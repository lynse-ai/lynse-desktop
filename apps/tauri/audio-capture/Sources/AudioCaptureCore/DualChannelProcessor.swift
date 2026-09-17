import Foundation

/// Pairs the microphone and system-audio streams on one sample timeline, runs
/// the echo canceller over the microphone track and hands out the derived
/// outputs: the raw tracks (verbatim, for later reprocessing), the processed
/// microphone track and the 16 kHz recognition streams.
///
/// Design constraints (from the dual-channel recording spec):
///  - The two SCK callbacks only enqueue; all processing runs on one serial
///    queue, so the engine and the frame state stay single-threaded.
///  - Missing or late reference audio never deletes near-end audio: the mic
///    frame passes through uncancelled and the interval is recorded as
///    degraded instead of being muted or dropped.
///  - Capture gaps pad with silence (the timeline never compresses).
public final class DualChannelProcessor {
    public static let processingRate = 48_000
    public static let systemChannels = 2
    /// 10 ms quantization at the processing rate.
    public static let frameSamples = processingRate / 100
    /// How many consecutive processed frames may lack a system frame before
    /// the reference is treated as lost (≈300 ms of stream time).
    public static let referenceStallLimitFrames = 30
    /// Queued-frame ceiling per track: anything beyond this (≈5 s) means the
    /// consumer stalled; the oldest frames are dropped rather than growing
    /// memory for an hour-long meeting.
    public static let maxQueuedFrames = 500

    /// Raw 48 kHz microphone audio (mono), placed on the timeline. Feeds the
    /// `mic_raw.wav` writer.
    public var onRawMic: ((_ firstFrameElapsedMs: UInt64, _ samples: [Int16]) -> Void)?
    /// Raw 48 kHz system audio (stereo interleaved), placed on the timeline.
    /// Feeds the `system_raw.wav` writer.
    public var onRawSystem: ((_ firstFrameElapsedMs: UInt64, _ samples: [Int16]) -> Void)?
    /// Echo-cancelled microphone audio at 16 kHz (recognition socket +
    /// `mic_processed.wav`).
    public var onMicProcessed16k: ((_ firstFrameElapsedMs: UInt64, _ samples: [Int16]) -> Void)?
    /// System audio at 16 kHz mono (recognition socket + `system.wav`).
    public var onSystem16k: ((_ firstFrameElapsedMs: UInt64, _ samples: [Int16]) -> Void)?

    private let queue = DispatchQueue(label: "app.lynse.capture.dualchannel")
    private let aec: AecProcessor?
    /// True when dual-channel processing was requested but the engine could
    /// not start: every processed interval must be marked degraded.
    private let engineUnavailable: Bool

    private var micTrack = Track()
    private var systemTrack = Track()
    private var micDecimator = Decimator48to16()
    private var systemDecimator = Decimator48to16()
    /// Decimates the pre-cancellation microphone audio purely for the delay
    /// estimator (correlating suppressed audio would corrupt the estimate).
    private var rawNearDecimator = Decimator48to16()
    private var delayEstimator = AcousticDelayEstimator()
    private var delayHintMs = 0
    private var micOutputCount = 0
    private var systemOutputCount = 0
    private var framesSinceSystemEnqueue = 0
    private var framesSinceMicEnqueue = 0
    private var flushing = false
    var dbgPaired = 0
    var dbgMicAlone = 0
    var dbgSystemAlone = 0
    /// Half-open degraded intervals in ms, adjacent spans merged.
    private var degradedIntervals: [(startMs: UInt64, endMs: UInt64)] = []

    struct Track {
        /// Channels carried by this track's interleaved samples (1 = mic,
        /// 2 = system). A 10 ms frame holds `frameSamples * channels` floats.
        var channels: Int = 1
        var pending: [Float] = []
        /// Absolute timeline position (48 kHz samples) of `pending[0]`.
        var nextPosition: Int64 = 0
        var frames: [Frame] = []

        /// Floats in one 10 ms frame of this track.
        var floatsPerFrame: Int { DualChannelProcessor.frameSamples * channels }

        struct Frame {
            let position: Int64
            var samples: [Float]
        }
    }

    private enum SourceKind {
        case mic
        case system
    }

    public init(enableAec: Bool) {
        if enableAec, let aec = AecProcessor() {
            self.aec = aec
            engineUnavailable = false
        } else {
            self.aec = nil
            engineUnavailable = enableAec
        }
    }

    /// True when the engine is present and dual-channel processing is live.
    public var aecActive: Bool { aec != nil }

    // MARK: - Ingest (called from the capture callbacks)

    public func pushMic(positionSamples: Int64, samples: [Float]) {
        queue.async { self.ingest(.mic, position: positionSamples, samples: samples) }
    }

    public func pushSystem(positionSamples: Int64, samples: [Float]) {
        queue.async { self.ingest(.system, position: positionSamples, samples: samples) }
    }

    // MARK: - Lifecycle

    /// Capture (re)start: drop buffered audio, reset the engine and hand back
    /// the timeline base both tracks must re-anchor to.
    @discardableResult
    public func prepareForRestart() -> Int64 {
        queue.sync {
            let base = max(micTrack.nextPosition, systemTrack.nextPosition)
            micTrack = Track()
            systemTrack = Track()
            micTrack.nextPosition = base
            systemTrack.nextPosition = base
            micDecimator = Decimator48to16()
            systemDecimator = Decimator48to16()
            rawNearDecimator = Decimator48to16()
            delayEstimator = AcousticDelayEstimator()
            delayHintMs = 0
            micOutputCount = 0
            systemOutputCount = 0
            framesSinceSystemEnqueue = 0
            framesSinceMicEnqueue = 0
            aec?.reset()
            return base
        }
    }

    /// Processes everything still buffered (end of session). Mic frames
    /// without a reference pass through with a silent reference and are
    /// marked degraded.
    public func flush() {
        queue.sync {
            if ProcessInfo.processInfo.environment["LYNSE_DBG"] != nil {
                FileHandle.standardError.write(Data("dbg: paired=\(dbgPaired) micAlone=\(dbgMicAlone) systemAlone=\(dbgSystemAlone)\n".utf8))
            }
            flushing = true
            drain()
            flushing = false
            // Drain the decimators' sub-millisecond tails so the last words
            // of the session never stay stuck in the resampler.
            emit16k(micDecimator.flush(), outputCount: &micOutputCount, sink: onMicProcessed16k)
            emit16k(systemDecimator.flush(), outputCount: &systemOutputCount, sink: onSystem16k)
            _ = rawNearDecimator.flush()
        }
    }

    public func snapshotDegradedIntervals() -> [(startMs: UInt64, endMs: UInt64)] {
        queue.sync { degradedIntervals }
    }

    /// Current acoustic-delay hint in ms (diagnostics and tests).
    public func snapshotDelayHintMs() -> Int {
        queue.sync { delayHintMs }
    }

    // MARK: - Pipeline internals (all on `queue`; tracks are read, mutated
    // and stored back inside single methods — no inout access crosses a call
    // that touches self again)

    private func ingest(_ kind: SourceKind, position: Int64, samples original: [Float]) {
        var samples = original
        var position = position
        guard !samples.isEmpty else { return }
        if kind == .system {
            framesSinceSystemEnqueue = 0
        } else {
            framesSinceMicEnqueue = 0
        }
        var track = trackFor(kind)
        track.channels = kind == .mic ? 1 : DualChannelProcessor.systemChannels
        if position < track.nextPosition {
            let overlap = track.nextPosition - position
            guard overlap < Int64(samples.count) else { return }
            samples = Array(samples.dropFirst(Int(overlap)))
            position = track.nextPosition
        }
        if position > track.nextPosition {
            let gap = Int(position - track.nextPosition)
            let wholeFrames = gap / DualChannelProcessor.frameSamples
            let remainder = gap % DualChannelProcessor.frameSamples
            for _ in 0..<wholeFrames {
                append(samples: [Float](repeating: 0, count: track.floatsPerFrame), to: &track)
            }
            if remainder > 0 {
                // Sub-frame gap: pad raw floats so the next real frame still
                // starts exactly at its position.
                append(samples: [Float](repeating: 0, count: remainder * track.channels), to: &track)
            }
        }
        rawSink(kind)?(ms(position), toInt16(samples))
        append(samples: samples, to: &track)
        trimQueuedFrames(&track)
        storeTrack(kind, track)
        drain()
    }

    private func trackFor(_ kind: SourceKind) -> Track {
        kind == .mic ? micTrack : systemTrack
    }

    private func storeTrack(_ kind: SourceKind, _ track: Track) {
        if kind == .mic {
            micTrack = track
        } else {
            systemTrack = track
        }
    }

    private func rawSink(_ kind: SourceKind) -> ((_ firstFrameElapsedMs: UInt64, _ samples: [Int16]) -> Void)? {
        kind == .mic ? onRawMic : onRawSystem
    }

    private func append(samples: [Float], to track: inout Track) {
        var samples = samples
        let floatsPerFrame = track.floatsPerFrame
        if !track.pending.isEmpty {
            let needed = floatsPerFrame - track.pending.count
            let take = min(needed, samples.count)
            track.pending.append(contentsOf: samples.prefix(take))
            samples = Array(samples.dropFirst(take))
            if track.pending.count == floatsPerFrame {
                track.frames.append(Track.Frame(position: track.nextPosition, samples: track.pending))
                track.nextPosition += Int64(DualChannelProcessor.frameSamples)
                track.pending = []
            }
        }
        while samples.count >= floatsPerFrame {
            track.frames.append(Track.Frame(position: track.nextPosition, samples: Array(samples.prefix(floatsPerFrame))))
            track.nextPosition += Int64(DualChannelProcessor.frameSamples)
            samples.removeFirst(floatsPerFrame)
        }
        if !samples.isEmpty {
            track.pending.append(contentsOf: samples)
        }
    }

    private func trimQueuedFrames(_ track: inout Track) {
        while track.frames.count > DualChannelProcessor.maxQueuedFrames {
            let dropped = track.frames.removeFirst()
            markDegraded(startMs: ms(dropped.position), endMs: ms(dropped.position + Int64(DualChannelProcessor.frameSamples)))
        }
    }

    private func drain() {
        while true {
            let micHead = micTrack.frames.first
            let systemHead = systemTrack.frames.first
            if micHead == nil, systemHead == nil { return }

            if let mic = micHead, let system = systemHead {
                if system.position == mic.position {
                    micTrack.frames.removeFirst()
                    systemTrack.frames.removeFirst()
                    emitPaired(mic: mic, system: system)
                    dbgPaired += 1
                    continue
                }
                if system.position < mic.position {
                    systemTrack.frames.removeFirst()
                    emitSystem(system)
                    continue
                }
                // system.position > mic.position: the reference for this
                // position no longer exists (a system-side gap jumped past
                // it) — cancel with silence and record the degradation.
                micTrack.frames.removeFirst()
                emitMicWithoutReference(mic)
                continue
            }

            // One side has no frame buffered. Its counterpart may still
            // arrive (callback order is arbitrary), so hold briefly — but
            // never past the stall limit, or a dead track would choke the
            // other one's output.
            if let system = systemHead {
                framesSinceMicEnqueue += 1
                if !flushing,
                   framesSinceMicEnqueue < DualChannelProcessor.referenceStallLimitFrames,
                   systemTrack.frames.count < DualChannelProcessor.referenceStallLimitFrames {
                    return
                }
                systemTrack.frames.removeFirst()
                emitSystem(system)
                dbgSystemAlone += 1
                continue
            }
            guard let mic = micHead else { return }
            framesSinceSystemEnqueue += 1
            if !flushing,
               framesSinceSystemEnqueue < DualChannelProcessor.referenceStallLimitFrames,
               micTrack.frames.count < DualChannelProcessor.referenceStallLimitFrames {
                return
            }
            micTrack.frames.removeFirst()
            emitMicWithoutReference(mic)
            dbgMicAlone += 1
        }
    }

    private func emitPaired(mic: Track.Frame, system: Track.Frame) {
        if ProcessInfo.processInfo.environment["LYNSE_DBG"] != nil, mic.position == 0 {
            FileHandle.standardError.write(Data("dbg: first paired frame\n".utf8))
        }
        let reference48k = downmixToMono(system.samples)
        let reference16k = systemDecimator.decimate(reference48k)
        // Pre-cancellation near audio feeds the delay estimator; correlating
        // suppressed audio would corrupt the estimate.
        let rawNear16k = rawNearDecimator.decimate(mic.samples)
        if delayEstimator.feed(reference: reference16k, near: rawNear16k) {
            delayHintMs = delayEstimator.delayHintMs
        }

        var near = mic.samples
        var cancelled = false
        if let aec, delayEstimator.hasEstimate {
            // Warm-up: until the first delay estimate lands the engine would
            // start with a wrong hint and re-converge when it flips, so the
            // first ≈0.5 s passes through uncancelled (not marked degraded —
            // it is bounded engine warm-up, not a processing failure).
            if aec.processReference(reference48k) {
                cancelled = aec.processNear(&near, delayHintMs: Int32(delayHintMs))
            }
            if !cancelled {
                // The engine rejected the frame — pass the original audio
                // through and record the interval rather than muting.
                near = mic.samples
                markDegraded(startMs: ms(mic.position), endMs: ms(mic.position + Int64(DualChannelProcessor.frameSamples)))
            }
        } else if engineUnavailable {
            markDegraded(startMs: ms(mic.position), endMs: ms(mic.position + Int64(DualChannelProcessor.frameSamples)))
        }
        emitMicProcessed(near)
        emit16k(reference16k, outputCount: &systemOutputCount, sink: onSystem16k)
    }

    private func emitMicWithoutReference(_ mic: Track.Frame) {
        if let aec {
            // Feed a silent reference so the engine keeps its internal block
            // alignment; the near audio passes through uncancelled and the
            // interval is recorded as degraded.
            var near = mic.samples
            _ = aec.processReference([Float](repeating: 0, count: AecProcessor.frameSamples))
            _ = aec.processNear(&near, delayHintMs: 0)
            markDegraded(startMs: ms(mic.position), endMs: ms(mic.position + Int64(DualChannelProcessor.frameSamples)))
            emitMicProcessed(near)
        } else {
            if engineUnavailable {
                markDegraded(startMs: ms(mic.position), endMs: ms(mic.position + Int64(DualChannelProcessor.frameSamples)))
            }
            emitMicProcessed(mic.samples)
        }
    }

    private func emitMicProcessed(_ samples48k: [Float]) {
        let decimated = micDecimator.decimate(samples48k)
        emit16k(decimated, outputCount: &micOutputCount, sink: onMicProcessed16k)
    }

    private func emitSystem(_ system: Track.Frame) {
        let decimated = systemDecimator.decimate(downmixToMono(system.samples))
        emit16k(decimated, outputCount: &systemOutputCount, sink: onSystem16k)
    }

    private func emit16k(_ samples: [Float], outputCount: inout Int, sink: ((_ firstFrameElapsedMs: UInt64, _ samples: [Int16]) -> Void)?) {
        guard let sink, !samples.isEmpty else { return }
        let startOutput = outputCount
        outputCount += samples.count
        let startMs = UInt64((Double(startOutput) * 1_000.0 / Double(Decimator48to16.outputRate)).rounded(.down))
        sink(startMs, toInt16(samples))
    }

    private func downmixToMono(_ interleaved: [Float]) -> [Float] {
        guard interleaved.count % DualChannelProcessor.systemChannels == 0 else { return interleaved }
        var mono = [Float]()
        mono.reserveCapacity(interleaved.count / DualChannelProcessor.systemChannels)
        var index = 0
        while index < interleaved.count {
            var sum: Float = 0
            for channel in 0..<DualChannelProcessor.systemChannels {
                sum += interleaved[index + channel]
            }
            mono.append(sum / Float(DualChannelProcessor.systemChannels))
            index += DualChannelProcessor.systemChannels
        }
        return mono
    }

    private func toInt16(_ samples: [Float]) -> [Int16] {
        samples.map { value in
            let clamped = max(-1.0, min(1.0, value))
            return Int16(clamping: Int((clamped * 32_767).rounded()))
        }
    }

    private func ms(_ positionSamples: Int64) -> UInt64 {
        UInt64(max(0, positionSamples) * 1_000 / Int64(DualChannelProcessor.processingRate))
    }

    private func markDegraded(startMs: UInt64, endMs: UInt64) {
        if let last = degradedIntervals.last, last.endMs >= startMs {
            degradedIntervals[degradedIntervals.count - 1].endMs = max(last.endMs, endMs)
            return
        }
        degradedIntervals.append((startMs, endMs))
    }
}
