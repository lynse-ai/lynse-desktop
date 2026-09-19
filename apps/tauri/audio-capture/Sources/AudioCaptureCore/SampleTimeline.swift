import Foundation

/// Maps host-clock sample timestamps onto the session's audio timeline in
/// 48 kHz sample units.
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
    /// Optional pinned zero point in host (mach) seconds. Needed as soon as the
    /// two tracks come from different APIs — ScreenCaptureKit presentation
    /// timestamps and an `AVAudioEngine` tap both report mach seconds, but
    /// without a shared anchor each zeroes on its own first callback and the
    /// tracks start a buffer apart.
    private var pinnedAnchorSeconds: Double?
    private(set) var baseSamples: Int64

    public init(sampleRate: Int = 48_000, baseSamples: Int64 = 0) {
        self.sampleRate = sampleRate
        self.baseSamples = baseSamples
    }

    /// Re-anchors the timeline for a fresh capture run. Both tracks of a
    /// session must receive the same base so they stay aligned; pass
    /// `anchorSeconds` to pin the zero point as well.
    public mutating func beginRun(baseSamples newBase: Int64, anchorSeconds: Double? = nil) {
        self.anchorSeconds = nil
        baseSamples = newBase
        pinnedAnchorSeconds = anchorSeconds
    }

    /// Position of the first sample of the buffer whose presentation time is
    /// `ptsSeconds`. Returns nil for unusable timestamps (callers append at the
    /// current position instead of guessing).
    public mutating func position(firstSampleSeconds ptsSeconds: Double) -> Int64? {
        guard ptsSeconds > 0 else { return nil }
        if anchorSeconds == nil, let pinned = pinnedAnchorSeconds {
            // The pinned instant IS the shared zero point: a first buffer that
            // happens to arrive before it must not replace it, or the two
            // tracks lose the alignment the pinning exists to guarantee.
            anchorSeconds = pinned
        }
        guard let anchor = anchorSeconds else {
            anchorSeconds = ptsSeconds
            return baseSamples
        }
        let offsetSamples = Int64(((ptsSeconds - anchor) * Double(sampleRate)).rounded())
        // A buffer stamped before the pinned anchor (Core Audio hands back the
        // time the conversion started, which can precede the rebase instant)
        // belongs at the start of this run. Letting it go negative below the
        // base propagates a negative sample position into every `UInt64(...)`
        // conversion downstream, and those trap.
        return offsetSamples < 0 ? baseSamples : baseSamples + offsetSamples
    }
}
