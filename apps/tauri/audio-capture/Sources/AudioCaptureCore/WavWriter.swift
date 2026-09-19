import Foundation

/// Streaming PCM16 WAV writer. Frames are placed on the track timeline by
/// their first-sample timestamp: a gap ahead of the current write position is
/// filled with silence (a missing callback must consume its slice of time —
/// never compress the timeline). All tracks of a session use one timeline so
/// the files stay sample-aligned with each other.
public final class WavWriter {
    private let handle: FileHandle
    private var sampleFrames: UInt64 = 0  // interleaved frames written
    private let sampleRate: UInt32
    private let channels: UInt16
    private var closed = false
    private let lock = NSLock()

    public init(path: String, sampleRate: UInt32, channels: UInt16) throws {
        self.sampleRate = sampleRate
        self.channels = max(1, channels)
        FileManager.default.createFile(atPath: path, contents: Data(repeating: 0, count: 44))
        handle = try FileHandle(forWritingTo: URL(fileURLWithPath: path))
        try handle.seek(toOffset: 44)
    }

    /// Writes interleaved PCM16 samples positioned at `firstFrameElapsedMs`
    /// on the track timeline (one frame = `channels` samples).
    public func write(samples: [Int16], firstFrameElapsedMs: UInt64) {
        lock.withLock {
            guard !closed, !samples.isEmpty else { return }
            let intendedFrames = firstFrameElapsedMs.saturatingMultiply(UInt64(sampleRate)) / 1_000
            if intendedFrames > sampleFrames {
                let padding = Int(min(intendedFrames - sampleFrames, UInt64(Int.max))) * Int(channels)
                let silence = [Int16](repeating: 0, count: padding)
                try? handle.write(contentsOf: silence.withUnsafeBytesData())
                sampleFrames += UInt64(intendedFrames - sampleFrames)
            }
            try? handle.write(contentsOf: samples.withUnsafeBytesData())
            sampleFrames += UInt64(samples.count / Int(channels))
        }
    }

    public func close() {
        lock.withLock {
            guard !closed else { return }
            closed = true
            let dataBytes = UInt32(min(sampleFrames * UInt64(channels) * 2, UInt64(UInt32.max)))
            let byteRate = sampleRate * UInt32(channels) * 2
            var header = Data()
            header.append(Data("RIFF".utf8))
            appendLittleEndian(UInt32(36) + dataBytes, to: &header)
            header.append(Data("WAVEfmt ".utf8))
            appendLittleEndian(UInt32(16), to: &header)
            appendLittleEndian(UInt16(1), to: &header)  // PCM
            appendLittleEndian(channels, to: &header)
            appendLittleEndian(sampleRate, to: &header)
            appendLittleEndian(byteRate, to: &header)
            appendLittleEndian(UInt16(channels * 2), to: &header)  // block align
            appendLittleEndian(UInt16(16), to: &header)
            header.append(Data("data".utf8))
            appendLittleEndian(dataBytes, to: &header)
            try? handle.seek(toOffset: 0)
            try? handle.write(contentsOf: header)
            try? handle.synchronize()
            try? handle.close()
        }
    }
}

public extension Array where Element == Int16 {
    func withUnsafeBytesData() -> Data {
        withUnsafeBytes { Data($0) }
    }
}

/// Clamping float → PCM16 conversion shared by every track path. The master
/// mixdown sums two sources, so it can exceed full scale and the clamp matters.
public func pcm16(fromFloats samples: [Float]) -> [Int16] {
    samples.map { value in
        let clamped = max(-1.0, min(1.0, value))
        return Int16(clamping: Int((clamped * 32_767).rounded()))
    }
}

public extension FixedWidthInteger {
    func saturatingMultiply(_ other: Self) -> Self {
        let (value, overflow) = multipliedReportingOverflow(by: other)
        return overflow ? Self.max : value
    }
}

func appendLittleEndian<T: FixedWidthInteger>(_ value: T, to data: inout Data) {
    var little = value.littleEndian
    Swift.withUnsafeBytes(of: &little) { data.append(contentsOf: $0) }
}
