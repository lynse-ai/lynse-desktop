import Foundation

/// Cross-stream acoustic-echo detector. When the computer speakers play the
/// system audio, the microphone signal is a delayed, attenuated copy of it;
/// a high normalized cross-correlation between the two streams therefore
/// means the mic currently carries only echo, and its frames can be withheld
/// from the recognition feed (they are still written to the WAV). A human
/// speaking into the mic is uncorrelated with the system stream, which
/// reopens the gate within one decision window.
///
/// Hysteresis is asymmetric on purpose: closing requires two consecutive
/// correlated windows (avoid flapping on brief musical passages), while any
/// uncorrelated window — or mic energy the echo path cannot explain — opens
/// the gate immediately so speech is never clipped for long.
public final class EchoGate: Sendable {
    /// History per stream: 500ms at 16kHz.
    private let bufferSamples = 8_000
    /// Decision window: 250ms.
    private let decisionSamples = 4_000
    /// Speaker-to-mic sound path delay rarely exceeds 30ms (480 samples).
    private let maxLagSamples = 480
    /// Lag search resolution: every 4th sample (0.25ms) — speech correlation
    /// peaks span tens of milliseconds, so this is far finer than needed.
    private let lagStride = 4
    /// Correlation floor for "the mic is only hearing the system stream".
    private let correlatedThreshold = 0.65
    /// The mic may be at most this fraction of the system level while still
    /// being explained as acoustic echo (speaker → air → mic attenuation).
    private let echoRatioCeiling = 0.5
    /// Mic energy above this fraction of the system level means a voice is
    /// present in the room, louder than any echo path can account for.
    private let voiceRatioFloor = 0.8
    /// System level below this (≈ -48dBFS) means nothing is playing; the
    /// correlation is meaningless and the mic must stay live.
    private let systemSilenceRMS = 0.004

    private let lock = NSLock()
    private var micBuffer: [Double] = []
    private var systemBuffer: [Double] = []
    private var micSinceDecision = 0
    private var correlatedWindows = 0
    private var gateSuppressed = false

    public init() {}

    /// Whether mic frames are currently withheld from the recognition feed.
    public var isSuppressed: Bool {
        lock.withLock { gateSuppressed }
    }

    /// Record system-stream samples. Never changes the gate by itself; it
    /// only keeps the reference signal available for correlation.
    public func pushSystem(samples: [Int16]) {
        let doubles = samples.map { Double($0) / 32_768.0 }
        lock.withLock {
            append(&systemBuffer, doubles)
        }
    }

    /// Record mic-stream samples and get the routing decision for them:
    /// `false` means "withhold from the recognition feed" (echo-only).
    public func admitMic(samples: [Int16]) -> Bool {
        let doubles = samples.map { Double($0) / 32_768.0 }
        return lock.withLock {
            append(&micBuffer, doubles)
            micSinceDecision += doubles.count
            if micSinceDecision >= decisionSamples {
                micSinceDecision = 0
                evaluateLocked()
            }
            return !gateSuppressed
        }
    }

    /// Reset all history (used when capture restarts, e.g. device change).
    public func reset() {
        lock.withLock {
            micBuffer.removeAll(keepingCapacity: true)
            systemBuffer.removeAll(keepingCapacity: true)
            micSinceDecision = 0
            correlatedWindows = 0
            gateSuppressed = false
        }
    }

    private func append(_ buffer: inout [Double], _ samples: [Double]) {
        buffer.append(contentsOf: samples)
        if buffer.count > bufferSamples {
            buffer.removeFirst(buffer.count - bufferSamples)
        }
    }

    private func evaluateLocked() {
        guard micBuffer.count >= decisionSamples, systemBuffer.count >= decisionSamples else {
            return
        }
        let mic = Array(micBuffer.suffix(decisionSamples))
        let system = Array(systemBuffer.suffix(decisionSamples))
        let systemRMS = rms(system)
        let micRMS = rms(mic)
        // Nothing playing through the system stream: correlation undefined,
        // the microphone is the only live source — keep it open.
        guard systemRMS > systemSilenceRMS else {
            correlatedWindows = 0
            gateSuppressed = false
            return
        }
        let ratio = micRMS / systemRMS
        // A voice in the room dominates any echo path — open immediately.
        if ratio > voiceRatioFloor {
            correlatedWindows = 0
            gateSuppressed = false
            return
        }
        // A silent mic while audio plays is echo (or nothing at all):
        // withholding it saves the duplicate recognition feed.
        if micRMS < systemSilenceRMS {
            correlatedWindows += 1
            if correlatedWindows >= 2 { gateSuppressed = true }
            return
        }
        let best = maxNormalizedCorrelation(mic: mic, system: system)
        if best >= correlatedThreshold && ratio < echoRatioCeiling {
            correlatedWindows += 1
            if correlatedWindows >= 2 { gateSuppressed = true }
        } else {
            correlatedWindows = 0
            gateSuppressed = false
        }
    }

    private func rms(_ samples: [Double]) -> Double {
        var sum = 0.0
        for sample in samples { sum += sample * sample }
        return (sum / Double(samples.count)).squareRoot()
    }

    /// Peak normalized (Pearson) cross-correlation of mic against system over
    /// positive lags 0...maxLag, searched with `lagStride`. Positive lag means
    /// the mic signal trails the system signal, which is the physical echo
    /// direction.
    private func maxNormalizedCorrelation(mic: [Double], system: [Double]) -> Double {
        let count = decisionSamples
        var best = 0.0
        var lag = 0
        while lag <= maxLagSamples {
            var sumXY = 0.0
            var sumX = 0.0
            var sumY = 0.0
            var sumXX = 0.0
            var sumYY = 0.0
            var index = 0
            while index < count - maxLagSamples {
                let x = mic[index + lag]
                let y = system[index]
                sumXY += x * y
                sumX += x
                sumY += y
                sumXX += x * x
                sumYY += y * y
                index += 1
            }
            let pairs = Double(count - maxLagSamples)
            let numerator = sumXY - sumX * sumY / pairs
            let varianceX = sumXX - sumX * sumX / pairs
            let varianceY = sumYY - sumY * sumY / pairs
            if varianceX > 1e-12, varianceY > 1e-12 {
                let value = numerator / (varianceX.squareRoot() * varianceY.squareRoot())
                if value > best { best = value }
            }
            lag += lagStride
        }
        return best
    }
}
