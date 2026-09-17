import Foundation

/// Minimal PCM16 WAV reader for the offline reprocessing mode. Understands
/// canonical 44-byte-header files (what `WavWriter` produces) plus files with
/// chunk-alignment padding, which some tooling inserts.
public struct WavReader {
    public let sampleRate: Int
    public let channels: Int
    /// Interleaved PCM16 samples of the data chunk.
    public let samples: [Int16]

    public init?(path: URL) {
        guard let data = try? Data(contentsOf: path),
              data.count > 44,
              data.prefix(4) == Data("RIFF".utf8),
              data.subdata(in: 8..<12) == Data("WAVE".utf8) else { return nil }

        var sampleRateValue = 0
        var channelsValue = 0
        var pcm: [Int16] = []
        var offset = 12
        while offset + 8 <= data.count {
            let chunkId = data.subdata(in: offset..<(offset + 4))
            let chunkLength = data.subdata(in: (offset + 4)..<(offset + 8)).withUnsafeBytes {
                $0.loadUnaligned(as: UInt32.self).littleEndian
            }
            let body = (offset + 8)..<min(offset + 8 + Int(chunkLength), data.count)
            if chunkId == Data("fmt ".utf8) {
                let fmt = data.subdata(in: body)
                guard fmt.count >= 16 else { return nil }
                channelsValue = Int(fmt.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 2, as: UInt16.self).littleEndian })
                sampleRateValue = Int(fmt.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 4, as: UInt32.self).littleEndian })
                let bits = fmt.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 14, as: UInt16.self).littleEndian }
                guard bits == 16 else { return nil }  // PCM16 only
            } else if chunkId == Data("data".utf8) {
                let byteStart = body.lowerBound
                let sampleCount = (body.upperBound - byteStart) / 2
                pcm.reserveCapacity(sampleCount)
                data.withUnsafeBytes { raw in
                    let source = raw.bindMemory(to: Int16.self)
                    let firstIndex = byteStart / 2
                    for index in 0..<sampleCount where firstIndex + index < source.count {
                        pcm.append(Int16(littleEndian: source[firstIndex + index]))
                    }
                }
            }
            offset = offset + 8 + Int(chunkLength)
            // Chunks are 2-byte aligned in RIFF.
            if offset % 2 == 1 { offset += 1 }
        }
        guard sampleRateValue > 0, channelsValue > 0, !pcm.isEmpty else { return nil }
        sampleRate = sampleRateValue
        channels = channelsValue
        samples = pcm
    }

    public var frameCount: Int { samples.count / channels }
}
