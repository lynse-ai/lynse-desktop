import Foundation

/// Tracks the acoustic-path delay between the system reference and the
/// microphone signal by cross-correlating decimated 16 kHz windows.
///
/// The AEC3 matched filter only searches a narrow band around the caller's
/// delay hint, so a roughly-correct hint is what makes convergence possible
/// (speaker playback lags the capture tap by the device's output latency —
/// typically 20–80 ms, different for every output device). The estimate is
/// refreshed while audio flows, which also re-covers device switches.
public struct AcousticDelayEstimator: Sendable {
    public static let sampleRate = 16_000
    /// Correlation window length (≈1 s of audio).
    public static let windowSamples = 16_000
    /// Search range for the echo path: 0–160 ms.
    public static let maxLagSamples = 2_560
    public static let lagStride = 2
    /// Re-estimate after this much new audio (≈1 s).
    public static let refreshIntervalSamples = 16_000
    /// First estimate comes earlier (≈0.5 s) so the echo canceller starts
    /// with a correct delay hint instead of flipping mid-stream.
    public static let firstRefreshIntervalSamples = 8_000
    /// Peak-to-average ratio the correlation must reach before the estimate
    /// is trusted; below it (uncorrelated audio, silence) the previous hint
    /// is kept.
    public static let peakConfidence = 2.5

    private var referenceHistory: [Float] = []
    private var nearHistory: [Float] = []
    private var samplesSinceRefresh = 0
    /// Diagnostics only: distinguishes instances in debug traces.
    private static var instanceCounter = 0
    private let instanceId: Int
    private var dbgTotalRef = 0
    private var dbgTotalNear = 0

    /// Current delay hint in milliseconds (0 until the first confident
    /// measurement).
    public private(set) var delayHintMs: Int = 0
    public private(set) var hasEstimate = false

    public init() {
        Self.instanceCounter += 1
        instanceId = Self.instanceCounter
    }

    /// Consumes the next aligned spans of reference and pre-cancellation near
    /// audio. Returns true when a new estimate was produced this call.
    public mutating func feed(reference: [Float], near: [Float]) -> Bool {
        append(reference: reference, near: near)
        dbgTotalRef += reference.count
        dbgTotalNear += near.count
        samplesSinceRefresh += reference.count
        if ProcessInfo.processInfo.environment["LYNSE_DBG"] != nil {
            FileHandle.standardError.write(Data("dbg: feed[#\(instanceId)] +\(reference.count)/+\(near.count) totalRef=\(dbgTotalRef) totalNear=\(dbgTotalNear)\n".utf8))
        }
        if ProcessInfo.processInfo.environment["LYNSE_DBG"] != nil, referenceHistory.count / 16000 != (referenceHistory.count - reference.count) / 16000 {
            FileHandle.standardError.write(Data("dbg: feed[#\(instanceId)] refHist=\(referenceHistory.count) nearHist=\(nearHistory.count) since=\(samplesSinceRefresh)\n".utf8))
        }
        guard samplesSinceRefresh >= Self.refreshIntervalSamples,
              referenceHistory.count >= Self.windowSamples,
              nearHistory.count >= Self.windowSamples else { return false }
        samplesSinceRefresh = 0
        if let delaySamples = Self.estimateDelay(reference: referenceHistory, near: nearHistory, instanceId: instanceId) {
            let newHint = delaySamples * 1_000 / Self.sampleRate
            if newHint != delayHintMs {
                delayHintMs = newHint
            }
            hasEstimate = true
            return true
        }
        return false
    }

    /// Drops learned state (capture restart, device switch).
    public mutating func reset() {
        referenceHistory = []
        nearHistory = []
        samplesSinceRefresh = 0
        delayHintMs = 0
        hasEstimate = false
    }

    private mutating func append(reference: [Float], near: [Float]) {
        referenceHistory.append(contentsOf: reference)
        nearHistory.append(contentsOf: near)
        let keep = Self.windowSamples + Self.maxLagSamples
        if referenceHistory.count > keep {
            referenceHistory.removeFirst(referenceHistory.count - keep)
        }
        if nearHistory.count > keep {
            nearHistory.removeFirst(nearHistory.count - keep)
        }
    }

    /// Naive cross-correlation over the most recent window: for each lag the
    /// energy of `near[t] - g * reference[t - lag]` is minimized — because
    /// amplitude is unknown, the score is the normalized correlation, and the
    /// winner must stand out from the lag-sweep average to count.
    ///
    /// Both signals are first-differenced before correlating: the talk/pause
    /// envelope is common to both tracks and would otherwise dominate the
    /// score at lag zero, masking the true echo-path lag.
    static func estimateDelay(reference: [Float], near: [Float], instanceId: Int = 0) -> Int? {
        let window = min(Self.windowSamples, near.count)
        let nearWindow = Self.firstDifference(Array(near.suffix(window)))
        let referenceSuffix = Self.firstDifference(
            Array(reference.suffix(min(reference.count, window + Self.maxLagSamples)))
        )
        guard referenceSuffix.count > Self.maxLagSamples else { return nil }

        var nearEnergy = 0.0
        for sample in nearWindow where sample != 0 {
            nearEnergy += Double(sample) * Double(sample)
        }
        guard nearEnergy > 1e-6 else { return nil }

        var scores = [Double]()
        scores.reserveCapacity(Self.maxLagSamples / Self.lagStride + 1)
        var bestLag = 0
        var bestScore = -2.0
        var scoreSum = 0.0
        var lag = 0
        while lag <= Self.maxLagSamples {
            var cross = 0.0
            var referenceEnergy = 0.0
            for index in 0..<window {
                let referenceIndex = referenceSuffix.count - window + index - lag
                guard referenceIndex >= 0 else { continue }
                let referenceSample = Double(referenceSuffix[referenceIndex])
                cross += Double(nearWindow[index]) * referenceSample
                referenceEnergy += referenceSample * referenceSample
            }
            let score = cross / (nearEnergy.squareRoot() * referenceEnergy.squareRoot() + 1e-12)
            scores.append(score)
            scoreSum += score
            if score > bestScore {
                bestScore = score
                bestLag = lag
            }
            lag += Self.lagStride
        }
        let average = scoreSum / Double(max(1, scores.count))
        if ProcessInfo.processInfo.environment["LYNSE_DBG"] != nil {
            FileHandle.standardError.write(Data("dbg: estimate[#\(instanceId)] bestLag=\(bestLag) best=\(bestScore) avg=\(average)\n".utf8))
        }
        guard bestScore > average * Self.peakConfidence, bestScore > 0.2 else { return nil }
        return bestLag
    }

    /// `y[n] = x[n] - x[n-1]` — a gentle high-pass that removes the shared
    /// slow envelope without touching the formant band.
    private static func firstDifference(_ samples: [Float]) -> [Float] {
        guard let first = samples.first else { return [] }
        var output = [Float](repeating: 0, count: samples.count)
        output[0] = first
        for index in 1..<samples.count {
            output[index] = samples[index] - samples[index - 1]
        }
        return output
    }
}
