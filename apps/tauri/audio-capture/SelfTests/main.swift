import AudioCaptureCore
import Foundation

private func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else {
        FileHandle.standardError.write(Data("FAILED: \(message)\n".utf8))
        exit(1)
    }
}

private func testArbitraryBuffersBecomeExactFrames() {
    var assembler = PCMFrameAssembler()
    var frames: [PCMFrame] = []
    frames += assembler.append(samples: [Int16](repeating: 1, count: 81), chunkStartMs: 0)
    frames += assembler.append(samples: [Int16](repeating: 2, count: 559), chunkStartMs: 5)
    expect(frames.count == 2, "arbitrary buffers should make two frames")
    expect(frames.allSatisfy { $0.samples.count == 320 }, "every frame must contain 320 samples")
    expect(frames.map(\.sequence) == [0, 1], "frame sequences must be contiguous")
    expect(frames.map(\.elapsedMs) == [0, 20], "frame timestamps must advance by 20ms")
}

private func testCaptureGapIsSilent() {
    var assembler = PCMFrameAssembler()
    let first = assembler.append(samples: [Int16](repeating: 7, count: 320), chunkStartMs: 100)
    let afterGap = assembler.append(samples: [Int16](repeating: 9, count: 320), chunkStartMs: 140)
    expect(first.count == 1, "first frame should be emitted immediately")
    expect(afterGap.count == 2, "a 20ms capture gap should add one frame")
    expect(afterGap[0].samples.allSatisfy { $0 == 0 }, "capture gap must be silent")
    expect(afterGap[1].samples.allSatisfy { $0 == 9 }, "audio after the gap must be preserved")
    expect(afterGap.map(\.elapsedMs) == [120, 140], "gap frames must stay on the shared timeline")
}

private func testFinalPartialBufferIsPadded() {
    var assembler = PCMFrameAssembler()
    expect(assembler.append(samples: [Int16](repeating: 3, count: 100), chunkStartMs: 0).isEmpty, "partial frame should remain buffered")
    let frames = assembler.finish()
    expect(frames.count == 1, "finish should flush one partial frame")
    expect(frames[0].samples.prefix(100).allSatisfy { $0 == 3 }, "partial audio must be preserved")
    expect(frames[0].samples.dropFirst(100).allSatisfy { $0 == 0 }, "partial frame must be zero padded")
}

// ───────────────────────────────────────────────────────────────
// SampleTimeline
// ───────────────────────────────────────────────────────────────

private func testTimelineAnchorsOnFirstPresentationTimestamp() {
    var timeline = SampleTimeline()
    expect(timeline.position(firstSampleSeconds: 12.5) == 0, "the first PTS anchors position zero")
    expect(timeline.position(firstSampleSeconds: 12.51) == 480, "10 ms later sits 480 samples ahead")
    expect(timeline.position(firstSampleSeconds: 0.0) == nil, "invalid PTS must not move the timeline")
}

private func testTimelineRestartContinuesWithoutRewinding() {
    var timeline = SampleTimeline()
    _ = timeline.position(firstSampleSeconds: 100.0)
    _ = timeline.position(firstSampleSeconds: 100.1)
    timeline.beginRun(baseSamples: 9600)
    expect(timeline.position(firstSampleSeconds: 200.0) == 9600, "a new run starts at the handed-over base")
    expect(timeline.position(firstSampleSeconds: 200.02) == 10560, "PTS deltas keep advancing after a restart")
}

// ───────────────────────────────────────────────────────────────
// Decimator48to16
// ───────────────────────────────────────────────────────────────

private func sine48k(frequency: Double, samples: Int, amplitude: Float) -> [Float] {
    (0..<samples).map { index in
        amplitude * Float(sin(2.0 * .pi * frequency * Double(index) / 48_000.0))
    }
}

private func rms(_ samples: [Float]) -> Double {
    guard !samples.isEmpty else { return 0 }
    let energy = samples.reduce(0.0) { $0 + Double($1) * Double($1) }
    return (energy / Double(samples.count)).squareRoot()
}

private func testDecimatorKeepsPassbandAmplitudeAcrossChunkSizes() {
    let input = sine48k(frequency: 1_000, samples: 48_000, amplitude: 0.5)
    var wholeDecimator = Decimator48to16()
    let whole = wholeDecimator.decimate(input) + wholeDecimator.flush()
    // Chunked decimation must agree with whole-buffer decimation.
    var chunked = Decimator48to16()
    var chunkedOutput: [Float] = []
    var cursor = 0
    while cursor < input.count {
        let end = min(cursor + 489, input.count)
        chunkedOutput += chunked.decimate(Array(input[cursor..<end]))
        cursor = end
    }
    chunkedOutput += chunked.flush()
    let reference = Array(whole.dropFirst(20).dropLast(20))
    let candidate = Array(chunkedOutput.dropFirst(20).dropLast(20))
    expect(reference.count == candidate.count, "chunked decimation must produce the same sample count (\(reference.count) vs \(candidate.count))")
    let deviation = zip(reference, candidate).map { abs($0 - $1) }.max() ?? 0
    expect(deviation < 1e-4, "chunked decimation must match whole-buffer decimation (max deviation \(deviation))")
    // 1 kHz sits well inside the passband: amplitude must survive.
    expect(abs(rms(Array(whole.dropFirst(200))) - 0.5 / 2.0.squareRoot()) < 0.02, "passband amplitude must be preserved")
}

// ───────────────────────────────────────────────────────────────
// DualChannelProcessor
// ───────────────────────────────────────────────────────────────

/// Speech-shaped excitation: white noise through a slowly-varying formant
/// filter plus syllabic AM — enough spectral spread for the engine's delay
/// estimator to lock onto (pure tones are pathologically ambiguous).
private final class SpeechShaper {
    private var y1: Float = 0
    private var y2: Float = 0
    private var generator: SeededGenerator
    private let baseFrequency: Double

    init(seed: UInt64, baseFrequency: Double = 350.0) {
        self.generator = SeededGenerator(seed: seed)
        self.baseFrequency = baseFrequency
    }

    func step(time t: Double) -> Float {
        let frequency = baseFrequency + 250.0 * sin(0.7 * t) + 180.0 * sin(1.9 * t)
        let radius = Float(exp(-2.0 * Double.pi * frequency / 48_000.0))
        let excitation = Float.random(in: -1...1, using: &generator)
        let value = excitation * (1 - radius) + 2 * radius * 0.7 * y1 - radius * radius * y2
        y2 = y1
        y1 = value
        return value
    }
}

private struct SeededGenerator: RandomNumberGenerator {
    private var state: UInt64
    init(seed: UInt64) { state = seed &+ 0x9E37_79B9_7F4A_7C15 }
    mutating func next() -> UInt64 {
        state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
        return state
    }
}

private struct BenchStreams {
    var far: [Float] = []
    var near: [Float] = []
    var processed: [Float] = []  // 16 kHz processed mic
}

/// Feeds a synthesized dual-stream scenario through the pipeline exactly the
/// way the live capture does: 20 ms chunks, alternating push order.
private func runBench(delayMs: Int, echoGain: Float, enableAec: Bool, seconds: Double) -> (BenchStreams, Int) {
    let rate = DualChannelProcessor.processingRate
    let chunk = rate / 50  // 20 ms
    let delaySamples = rate * delayMs / 1_000
    let total = Int(seconds * Double(rate))

    var farSpeech = SpeechShaper(seed: 7)
    var far = [Float](repeating: 0, count: total)
    var near = [Float](repeating: 0, count: total + delaySamples)
    for index in 0..<total {
        let time = Double(index) / Double(rate)
        let talking = time.truncatingRemainder(dividingBy: 2.0) < 1.5
        let envelope = 0.5 + 0.5 * sin(2.0 * .pi * 3.5 * time)
        far[index] = talking ? farSpeech.step(time: time) * Float(envelope) * 0.5 : 0
        // The microphone only ever hears local speech (never the far voice
        // directly), so any correlation in `near` is echo by construction.
        let localTalking = time >= 3.0 && time < 6.0
        // A clearly different voice: tonal mixture (mirrors the C++ APM
        // validation signal) so double-talk is spectrally distinguishable.
        var local: Float = 0
        if localTalking {
            let env = 0.55 + 0.45 * Float(sin(1.9 * time + 1.3))
            local = env * 0.35 * (Float(sin(2.0 * .pi * 230.0 * time)) * 0.5
                + Float(sin(2.0 * .pi * 950.0 * time)) * 0.3
                + Float(sin(2.0 * .pi * 2100.0 * time)) * 0.2)
        }
        near[index + delaySamples] = local + (index < total ? far[index] * echoGain : 0)
    }

    var streams = BenchStreams()
    streams.far = far
    streams.near = near
    let lock = NSLock()
    let processor = DualChannelProcessor(enableAec: enableAec)
    processor.onMicProcessed16k = { _, samples in
        lock.lock()
        streams.processed += samples.map { Float($0) / 32_767.0 }
        lock.unlock()
    }
    // Push order alternates to exercise both callback orderings.
    for (index, offset) in stride(from: 0, to: total + delaySamples - chunk, by: chunk).enumerated() {
        if index % 2 == 0 {
            processor.pushMic(positionSamples: Int64(offset), samples: Array(near[offset..<offset + chunk]))
            let farEnd = min(offset + chunk, total)
            let systemSamples = offset < farEnd ? Array(far[offset..<farEnd]) : [Float](repeating: 0, count: chunk)
            processor.pushSystem(positionSamples: Int64(offset), samples: stereo(systemSamples))
        } else {
            let farEnd = min(offset + chunk, total)
            let systemSamples = offset < farEnd ? Array(far[offset..<farEnd]) : [Float](repeating: 0, count: chunk)
            processor.pushSystem(positionSamples: Int64(offset), samples: stereo(systemSamples))
            processor.pushMic(positionSamples: Int64(offset), samples: Array(near[offset..<offset + chunk]))
        }
    }
    processor.flush()
    return (streams, processor.snapshotDelayHintMs())
}

/// Renders mono floats as the interleaved stereo the system track carries.
private func stereo(_ mono: [Float]) -> [Float] {
    mono.flatMap { [$0, $0] }
}

private func testEchoCancellerSuppressesSyntheticEcho() {
    guard AecProcessor.isAvailable else {
        FileHandle.standardError.write(Data("SKIP: AEC engine unavailable on this platform\n".utf8))
        return
    }
    // 6.5 s run: 0–3 s far-only (echo measurement after convergence),
    // 3–6 s double-talk (near integrity).
    let (streams, processorDelay) = runBench(delayMs: 24, echoGain: 0.35, enableAec: true, seconds: 6.5)
    FileHandle.standardError.write(Data("bench delay hint: \(processorDelay) ms\n".utf8))

    // ERLE in the far-only window. `streams.near` lives on the 48 kHz input
    // timeline (echo at `delaySamples`), `streams.processed` on the 16 kHz
    // output timeline — each window must use its own rate's indices.
    let rate = DualChannelProcessor.processingRate
    let rate16 = Decimator48to16.outputRate
    let delaySamples = rate * 24 / 1_000
    let inputStart = Int(1.8 * Double(rate)) + delaySamples
    let inputEnd = Int(2.9 * Double(rate)) + delaySamples
    let inputEcho = rms(Array(streams.near[inputStart...inputEnd]))
    let residual = rms(Array(streams.processed[Int(1.8 * Double(rate16))...Int(2.9 * Double(rate16))]))
    let erle = 20.0 * log10(inputEcho / residual)
    expect(erle >= 20.0, "controlled echo must be suppressed by ≥20 dB (measured \(String(format: "%.1f", erle)) dB)")

    // Local speech must survive the double-talk window (±3 dB against the
    // unprocessed mix level).
    let localInputStart = Int(3.6 * Double(rate)) + delaySamples
    let localInputEnd = Int(5.4 * Double(rate)) + delaySamples
    let localReference = rms(Array(streams.near[localInputStart...localInputEnd]))
    let localProcessed = rms(Array(streams.processed[Int(3.6 * Double(rate16))...Int(5.4 * Double(rate16))]))
    let localDelta = 20.0 * log10(localProcessed / localReference)
    expect(localDelta > -3.0 && localDelta < 3.0, "local speech must survive cancellation (Δ \(String(format: "%.2f", localDelta)) dB)")
}

private func testMissingReferenceDegradesInsteadOfMuting() {
    // The engine can be exercised directly here; even without it the
    // no-reference path must keep the microphone audio.
    let rate = DualChannelProcessor.processingRate
    let chunk = rate / 100
    var micSamples: [Float] = []
    var processed: [Float] = []
    let lock = NSLock()
    let processor = DualChannelProcessor(enableAec: true)
    processor.onMicProcessed16k = { _, samples in
        lock.lock()
        processed += samples.map { Float($0) / 32_767.0 }
        lock.unlock()
    }
    for offset in stride(from: 0, to: rate, by: chunk) {
        let tone = sine48k(frequency: 440, samples: chunk, amplitude: 0.3)
        micSamples += tone
        // System never delivers a single frame: every mic frame degrades.
        processor.pushMic(positionSamples: Int64(offset), samples: tone)
    }
    processor.flush()
    expect(processed.count > rate16(rate) / 2, "mic audio must flow through without a reference (got \(processed.count) of ~\(rate16(rate)) samples)")
    let inRms = rms(micSamples.map { $0 })
    let outRms = rms(processed)
    let drop = 20.0 * log10(max(inRms, 1e-9) / max(outRms, 1e-9))
    expect(drop < 6.0, "degraded passthrough must not mute the microphone (attenuated \(String(format: "%.1f", drop)) dB)")
    let intervals = processor.snapshotDegradedIntervals()
    expect(!intervals.isEmpty, "the missing-reference span must be recorded as degraded")
    expect(intervals[0].startMs == 0, "degradation starts with the first unmatched frame")
}

private func rate16(_ samplesAt48k: Int) -> Int {
    samplesAt48k / Decimator48to16.decimationFactor
}

private func testSystemGapDoesNotCompressTheTimeline() {
    let rate = DualChannelProcessor.processingRate
    let chunk = rate / 100
    var processedCount = 0
    var systemCount = 0
    let lock = NSLock()
    let processor = DualChannelProcessor(enableAec: true)
    processor.onMicProcessed16k = { _, samples in
        lock.lock()
        processedCount += samples.count
        lock.unlock()
    }
    processor.onSystem16k = { _, samples in
        lock.lock()
        systemCount += samples.count
        lock.unlock()
    }
    // Mic runs for 1 s; system drops out for the middle 500 ms (positions
    // keep advancing — the gap pads with silence, never shrinks).
    for offset in stride(from: 0, to: rate, by: chunk) {
        let tone = sine48k(frequency: 300, samples: chunk, amplitude: 0.2)
        processor.pushMic(positionSamples: Int64(offset), samples: tone)
        let inGap = offset >= rate / 4 && offset < rate * 3 / 4
        if !inGap {
            processor.pushSystem(positionSamples: Int64(offset), samples: stereo(tone.map { $0 * 0.5 }))
        } else {
            // keep the system track's own timeline advancing with silence
            // only while it lasts; the gap itself stays a gap.
            if offset % (chunk * 5) == 0 {
                processor.pushSystem(positionSamples: Int64(offset), samples: stereo(sine48k(frequency: 300, samples: chunk, amplitude: 0)))
            }
        }
    }
    processor.flush()
    let expectedMin = rate16(rate) * 3 / 4
    expect(processedCount >= expectedMin, "the mic track must cover the whole timeline without compression (got \(processedCount) ≥ \(expectedMin))")
    expect(systemCount > 0, "system audio must flow through independently")
}

private func testLegacyPassthroughLeavesAudioUntouched() {
    let rate = DualChannelProcessor.processingRate
    let chunk = rate / 100
    var processed: [Float] = []
    let lock = NSLock()
    let processor = DualChannelProcessor(enableAec: false)
    processor.onMicProcessed16k = { _, samples in
        lock.lock()
        processed += samples.map { Float($0) / 32_767.0 }
        lock.unlock()
    }
    for offset in stride(from: 0, to: rate, by: chunk) {
        processor.pushMic(positionSamples: Int64(offset), samples: sine48k(frequency: 500, samples: chunk, amplitude: 0.4))
        processor.pushSystem(positionSamples: Int64(offset), samples: stereo(sine48k(frequency: 90, samples: chunk, amplitude: 0.1)))
    }
    processor.flush()
    expect(processor.snapshotDegradedIntervals().isEmpty, "legacy passthrough must not mark degradation")
    expect(processed.count >= rate16(rate) - 4, "passthrough must keep the full timeline")
}

private func testRestartHandsOverTheTimelineBase() {
    let processor = DualChannelProcessor(enableAec: true)
    let chunk = DualChannelProcessor.processingRate / 100
    for offset in stride(from: 0, to: chunk * 50, by: chunk) {
        processor.pushMic(positionSamples: Int64(offset), samples: sine48k(frequency: 300, samples: chunk, amplitude: 0.1))
        processor.pushSystem(positionSamples: Int64(offset), samples: stereo(sine48k(frequency: 300, samples: chunk, amplitude: 0.1)))
    }
    let base = processor.prepareForRestart()
    expect(base >= chunk * 50 - chunk, "restart base must sit at the last consumed position (got \(base))")
    // A run that starts at the handed-over base must not pad or rewind.
    var received: [Float] = []
    let lock = NSLock()
    processor.onMicProcessed16k = { _, samples in
        lock.lock()
        received += samples.map { Float($0) / 32_767.0 }
        lock.unlock()
    }
    processor.pushMic(positionSamples: base, samples: sine48k(frequency: 300, samples: chunk, amplitude: 0.5))
    processor.pushSystem(positionSamples: base, samples: stereo(sine48k(frequency: 300, samples: chunk, amplitude: 0.5)))
    processor.flush()
    expect(received.count >= rate16(chunk) - 2, "audio pushed at the restart base must flow immediately (got \(received.count))")
}

runDelayProbe()
testArbitraryBuffersBecomeExactFrames()
testCaptureGapIsSilent()
testFinalPartialBufferIsPadded()
testTimelineAnchorsOnFirstPresentationTimestamp()
testTimelineRestartContinuesWithoutRewinding()
testDecimatorKeepsPassbandAmplitudeAcrossChunkSizes()
if AecProcessor.isAvailable {
    testEchoCancellerSuppressesSyntheticEcho()
    testMissingReferenceDegradesInsteadOfMuting()
    testSystemGapDoesNotCompressTheTimeline()
    testLegacyPassthroughLeavesAudioUntouched()
    testRestartHandsOverTheTimelineBase()
} else {
    // The pipeline must still run (passing audio through) without the engine.
    testMissingReferenceDegradesInsteadOfMuting()
    testLegacyPassthroughLeavesAudioUntouched()
    testRestartHandsOverTheTimelineBase()
}
print("audio-capture core tests passed")
