import CAecBridge
import Foundation

/// Swift handle over the vendored WebRTC AEC3 engine (see dsp/lynse_aec.cc).
///
/// One instance processes a single mono near-end (microphone) stream against
/// a mono far-end (system playback) reference in 10 ms frames at 48 kHz.
/// Thread safety: callers serialize access (the capture pipeline runs on one
/// processing queue).
public final class AecProcessor {
    /// Microphone-path speech enhancement. `off` keeps the capture exactly as
    /// the driver delivered it; the other levels add WebRTC noise suppression
    /// and the DC/high-pass stage on top of the canceller.
    public enum Enhancement: Int32 {
        case off = 0
        case mild = 1
        case aggressive = 2
    }

    public static let processingRate = 48_000
    /// Samples in one 10 ms engine frame at the processing rate.
    public static let frameSamples = processingRate / 100

    /// True when the engine initialized (the vendored library is linked in and
    /// supports this platform). When false, callers must pass the microphone
    /// audio through unprocessed and mark the affected intervals as degraded.
    public static var isAvailable: Bool {
        let probe = lynse_aec_create(Int32(AecProcessor.processingRate))
        guard let probe else { return false }
        lynse_aec_destroy(probe)
        return true
    }

    public static let engineId = String(cString: lynse_aec_engine_id())

    private let handle: OpaquePointer

    public init?() {
        guard let handle = lynse_aec_create(Int32(AecProcessor.processingRate)) else { return nil }
        self.handle = handle
    }

    deinit {
        lynse_aec_destroy(handle)
    }

    /// Feeds the 10 ms far-end reference. Call once per near frame, before it.
    public func processReference(_ samples: [Float]) -> Bool {
        samples.count == AecProcessor.frameSamples
            && lynse_aec_process_reverse(handle, samples, Int32(samples.count)) == 0
    }

    /// Processes one 10 ms near-end frame in place. `delayHintMs` is the
    /// caller's estimate of the acoustic-path delay; the engine refines it
    /// internally. Returns false when the engine rejected the frame.
    public func processNear(_ samples: inout [Float], delayHintMs: Int32) -> Bool {
        guard samples.count == AecProcessor.frameSamples else { return false }
        let result = samples.withUnsafeMutableBufferPointer { buffer in
            lynse_aec_process_near(handle, buffer.baseAddress, Int32(buffer.count), delayHintMs)
        }
        return result == 0
    }

    /// Applies or removes speech enhancement on the near-end path. Safe at any
    /// time; takes effect from the next frame and survives `reset()`.
    @discardableResult
    public func setEnhancement(_ level: Enhancement) -> Bool {
        lynse_aec_set_enhancement(handle, level.rawValue) == 0
    }

    /// Drops all learned state (echo path, delay alignment).
    public func reset() {
        lynse_aec_reset(handle)
    }
}
