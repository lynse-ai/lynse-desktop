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

testArbitraryBuffersBecomeExactFrames()
testCaptureGapIsSilent()
testFinalPartialBufferIsPadded()
print("audio-capture core tests passed")
