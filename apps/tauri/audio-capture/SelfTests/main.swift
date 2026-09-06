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
// EchoGate — cross-stream echo detection
// ───────────────────────────────────────────────────────────────

/// Deterministic uniform noise in (-amplitude, amplitude).
private func noise(count: Int, seed: UInt64, amplitude: Double) -> [Int16] {
    var state: UInt64 = seed
    var samples: [Int16] = []
    samples.reserveCapacity(count)
    for _ in 0..<count {
        state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
        // state >> 11 spans 53 bits — divide by 2^53, not Int64.max, or the
        // signal ends up ~1000x quieter than intended and falls under the
        // gate's silence floor.
        let unit = Double(Int64(bitPattern: state >> 11)) / 9_007_199_254_740_992.0
        samples.append(Int16(max(-32_768, min(32_767, unit * amplitude * 32_767))))
    }
    return samples
}

private func feedGate(_ gate: EchoGate, system: [Int16], mic: [Int16], chunk: Int) {
    for start in stride(from: 0, to: system.count, by: chunk) {
        gate.pushSystem(samples: Array(system[start..<Swift.min(start + chunk, system.count)]))
        _ = gate.admitMic(samples: Array(mic[start..<Swift.min(start + chunk, mic.count)]))
    }
}

private func testEchoGateSuppressesDelayedAttenuatedSystemEcho() {
    let gate = EchoGate()
    let system = noise(count: 12_000, seed: 42, amplitude: 0.5)
    let echo: [Int16] = (0..<12_000).map { index in
        index >= 100 ? Int16(Double(system[index - 100]) * 0.3) : 0
    }
    var suppressedAfterFirstWindow = false
    for start in stride(from: 0, to: 12_000, by: 2_000) {
        gate.pushSystem(samples: Array(system[start..<start + 2_000]))
        let admitted = gate.admitMic(samples: Array(echo[start..<start + 2_000]))
        if start == 2_000 { suppressedAfterFirstWindow = !admitted }
    }
    expect(suppressedAfterFirstWindow == false, "gate must not close after a single correlated window")
    expect(gate.isSuppressed, "a delayed attenuated copy of the system stream must be suppressed")
}

private func testEchoGateAdmitsUncorrelatedMicrophoneSignal() {
    let gate = EchoGate()
    let system = noise(count: 12_000, seed: 7, amplitude: 0.5)
    let voice = noise(count: 12_000, seed: 99, amplitude: 0.3)
    feedGate(gate, system: system, mic: voice, chunk: 2_000)
    expect(!gate.isSuppressed, "an uncorrelated mic signal (headphones, real speech) must keep the gate open")
}

private func testEchoGateAdmitsVoiceLouderThanTheEchoPath() {
    let gate = EchoGate()
    let system = noise(count: 12_000, seed: 5, amplitude: 0.5)
    let voice = noise(count: 12_000, seed: 12345, amplitude: 0.9)
    let mic: [Int16] = (0..<12_000).map { index in
        let echo = index >= 100 ? Double(system[index - 100]) * 0.3 : 0
        let mixed = echo + Double(voice[index])
        return Int16(max(-32_768, min(32_767, mixed)))
    }
    feedGate(gate, system: system, mic: mic, chunk: 2_000)
    expect(!gate.isSuppressed, "speech louder than the echo path must open the gate immediately")
}

private func testEchoGateIgnoresCorrelationWhenNothingPlays() {
    let gate = EchoGate()
    let system = [Int16](repeating: 0, count: 12_000)
    let voice = noise(count: 12_000, seed: 3, amplitude: 0.4)
    feedGate(gate, system: system, mic: voice, chunk: 2_000)
    expect(!gate.isSuppressed, "a silent system stream must leave the mic live")
}

private func testEchoGateResetReopensTheGate() {
    let gate = EchoGate()
    let system = noise(count: 12_000, seed: 42, amplitude: 0.5)
    let echo: [Int16] = (0..<12_000).map { index in
        index >= 100 ? Int16(Double(system[index - 100]) * 0.3) : 0
    }
    feedGate(gate, system: system, mic: echo, chunk: 2_000)
    expect(gate.isSuppressed, "echo copy should be suppressed before reset")
    gate.reset()
    expect(!gate.isSuppressed, "reset must reopen the gate")
}

testArbitraryBuffersBecomeExactFrames()
testCaptureGapIsSilent()
testFinalPartialBufferIsPadded()
testEchoGateSuppressesDelayedAttenuatedSystemEcho()
testEchoGateAdmitsUncorrelatedMicrophoneSignal()
testEchoGateAdmitsVoiceLouderThanTheEchoPath()
testEchoGateIgnoresCorrelationWhenNothingPlays()
testEchoGateResetReopensTheGate()
print("audio-capture core tests passed")
