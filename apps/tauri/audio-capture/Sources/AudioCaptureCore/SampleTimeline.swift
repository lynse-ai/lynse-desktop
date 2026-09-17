import Foundation

/// Maps ScreenCaptureKit presentation timestamps onto the session's audio
/// timeline in 48 kHz sample units.
///
/// All sources share one host clock, so positions derived from PTS are
/// sample-aligned across tracks by construction — this replaces the old
/// arrival-time estimates, which drifted by the delta between first
/// callbacks. `baseSamples` moves forward across capture restarts (device
/// switches, pause/resume) so the timeline never runs backwards; the padding
/// layer absorbs any dead time between runs.
public struct SampleTimeline {
    public let sampleRate: Int
    private var anchorSeconds: Double?
    private(set) var baseSamples: Int64

    public init(sampleRate: Int = 48_000, baseSamples: Int64 = 0) {
        self.sampleRate = sampleRate
        self.baseSamples = baseSamples
    }

    /// Re-anchors the timeline for a fresh capture run. Both tracks of a
    /// session must receive the same base so they stay aligned.
    public mutating func beginRun(baseSamples newBase: Int64) {
        anchorSeconds = nil
        baseSamples = newBase
    }

    /// Position of the first sample of the buffer whose presentation time is
    /// `ptsSeconds`. Returns nil for unusable timestamps (callers append at
    /// the current position instead of guessing).
    public mutating func position(firstSampleSeconds ptsSeconds: Double) -> Int64? {
        guard ptsSeconds > 0 else { return nil }
        guard let anchor = anchorSeconds else {
            anchorSeconds = ptsSeconds
            return baseSamples
        }
        let offsetSamples = Int64(((ptsSeconds - anchor) * Double(sampleRate)).rounded())
        return baseSamples + offsetSamples
    }
}
