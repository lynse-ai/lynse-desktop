import Foundation

/// Polyphase 48 kHz → 16 kHz FIR decimator.
///
/// The capture pipeline runs the echo canceller at 48 kHz (where the reference
/// and near-end correlate most faithfully) while speech recognition consumes
/// 16 kHz. A windowed-sinc low-pass keeps the decimation deterministic and
/// testable — no framework converter state to reason about — and the phase is
/// tracked by absolute stream position so arbitrary chunk boundaries stay
/// lossless.
public struct Decimator48to16: Sendable {
    public static let inputRate = 48_000
    public static let outputRate = 16_000
    public static let decimationFactor = 3

    /// 45-tap windowed-sinc kernel (Blackman window), cutoff ≈ 7.2 kHz: the
    /// passband covers the speech band and the transition lands where neither
    /// ASR nor playback care.
    private static let taps: [Float] = {
        let count = 45
        let cutoff = 7_200.0 / Double(inputRate)
        var kernel = [Float](repeating: 0, count: count)
        var sum = 0.0 as Double
        for index in 0..<count {
            let middle = Double(count - 1) / 2
            let x = Double(index) - middle
            let sinc = x == 0 ? 1.0 : sin(2.0 * .pi * cutoff * x) / (2.0 * .pi * cutoff * x)
            let window = 0.42
                - 0.5 * cos(2.0 * .pi * Double(index) / Double(count - 1))
                + 0.08 * cos(4.0 * .pi * Double(index) / Double(count - 1))
            kernel[index] = Float(sinc * window)
            sum += Double(kernel[index])
        }
        // Normalize so unity-gain input keeps its amplitude.
        return kernel.map { $0 / Float(sum) }
    }()

    private static let half = taps.count / 2

    private var history: [Float] = []
    /// Absolute input index of the next `decimate` call's first sample.
    private var baseIndex = 0
    private var nextOutput = 0

    public init() {}

    /// Decimates `samples` (48 kHz mono). Returns the completed 16 kHz output;
    /// a few trailing input samples stay buffered until the kernel window
    /// slides past them (sub-millisecond latency) or `flush` is called.
    public mutating func decimate(_ samples: [Float]) -> [Float] {
        var input = history
        input.append(contentsOf: samples)
        let chunkBase = baseIndex - history.count
        let last = chunkBase + input.count - 1
        var output: [Float] = []
        output.reserveCapacity(samples.count / Self.decimationFactor + 1)
        while nextOutput * Self.decimationFactor + Self.half <= last {
            output.append(kernelValue(center: nextOutput * Self.decimationFactor, input: input, chunkBase: chunkBase))
            nextOutput += 1
        }
        history = Array(input.suffix(Self.taps.count - 1))
        baseIndex += samples.count
        return output
    }

    /// Emits any output whose kernel window was still waiting for input.
    public mutating func flush() -> [Float] {
        guard !history.isEmpty else { return [] }
        var input = history
        input.append(contentsOf: [Float](repeating: 0, count: Self.taps.count + Self.decimationFactor))
        let chunkBase = baseIndex - history.count
        let last = chunkBase + input.count - 1
        var output: [Float] = []
        while nextOutput * Self.decimationFactor + Self.half <= last {
            output.append(kernelValue(center: nextOutput * Self.decimationFactor, input: input, chunkBase: chunkBase))
            nextOutput += 1
        }
        history = []
        return output
    }

    private func kernelValue(center: Int, input: [Float], chunkBase: Int) -> Float {
        var accumulator: Float = 0
        for (tapIndex, tap) in Self.taps.enumerated() {
            let index = center - Self.half + tapIndex - chunkBase
            guard index >= 0, index < input.count else { continue }  // outside stream = zero
            accumulator += tap * input[index]
        }
        return accumulator
    }
}
