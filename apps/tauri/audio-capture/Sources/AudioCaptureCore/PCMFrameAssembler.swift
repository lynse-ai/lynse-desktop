import Foundation

public struct PCMFrame: Equatable, Sendable {
    public let sequence: UInt64
    public let elapsedMs: UInt64
    public let samples: [Int16]
}

public struct PCMFrameAssembler: Sendable {
    public static let samplesPerFrame = 320
    public static let sampleRate = 16_000
    /// Longest dropout padded with silence. A jump past this is a broken
    /// timestamp rather than missing audio, and padding it would allocate
    /// whatever the number happened to imply.
    static let maxPaddedGapMs: UInt64 = 60_000

    private var pending: [Int16] = []
    private var sequence: UInt64 = 0
    private var streamStartMs: UInt64?

    public init() {}

    public mutating func append(samples: [Int16], chunkStartMs: UInt64) -> [PCMFrame] {
        if streamStartMs == nil { streamStartMs = chunkStartMs }
        insertSilenceIfNeeded(before: chunkStartMs)
        pending.append(contentsOf: samples)
        return drainCompleteFrames()
    }

    /// Appends without any gap arithmetic — the tail of a stream that simply
    /// continues where the last chunk stopped. Callers must not fake this with
    /// an out-of-range timestamp: `UInt64.max` used to be passed as a "keep
    /// going" sentinel and the gap maths trapped converting it to `Int`,
    /// crashing the sidecar on every single-microphone session's shutdown.
    public mutating func appendContiguous(samples: [Int16]) -> [PCMFrame] {
        if streamStartMs == nil { streamStartMs = 0 }
        pending.append(contentsOf: samples)
        return drainCompleteFrames()
    }

    public mutating func finish() -> [PCMFrame] {
        if !pending.isEmpty && pending.count < Self.samplesPerFrame {
            pending.append(contentsOf: repeatElement(0, count: Self.samplesPerFrame - pending.count))
        }
        return drainCompleteFrames()
    }

    private mutating func insertSilenceIfNeeded(before chunkStartMs: UInt64) {
        guard let streamStartMs else { return }
        let deltaMs = chunkStartMs.saturatingSubtract(streamStartMs)
        // An absurd timestamp is a caller bug, not audio. Padding it would
        // allocate gigabytes of silence (and the raw `Int` conversion used to
        // trap outright), so treat anything past a real dropout as jitter and
        // append in place instead.
        guard deltaMs <= Self.maxPaddedGapMs else { return }
        let incomingPosition = Int(deltaMs) * Self.sampleRate / 1_000
        let currentPosition = Int(sequence) * Self.samplesPerFrame + pending.count
        let gap = incomingPosition - currentPosition
        // Ignore normal callback jitter. A full-frame gap means capture actually dropped audio.
        if gap >= Self.samplesPerFrame {
            pending.append(contentsOf: repeatElement(0, count: gap))
        }
    }

    private mutating func drainCompleteFrames() -> [PCMFrame] {
        var frames: [PCMFrame] = []
        while pending.count >= Self.samplesPerFrame {
            let samples = Array(pending.prefix(Self.samplesPerFrame))
            pending.removeFirst(Self.samplesPerFrame)
            frames.append(PCMFrame(
                sequence: sequence,
                elapsedMs: (streamStartMs ?? 0) + sequence * 20,
                samples: samples
            ))
            sequence += 1
        }
        return frames
    }
}

private extension UInt64 {
    func saturatingSubtract(_ other: UInt64) -> UInt64 {
        self >= other ? self - other : 0
    }
}
