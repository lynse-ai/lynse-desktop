import Foundation

/// Versioned recording track manifest (`tracks.json`), written next to the
/// session audio. Rust reads it when persisting the session and when offering
/// per-track playback / reprocessing; the schema is shared by both sides, so
/// field names are frozen.
public struct TrackManifest: Equatable {
    public struct TrackEntry: Equatable {
        public let id: String
        public let file: String
        public let role: String
        public let processed: Bool
        public let sampleRate: Int
        public let channels: Int

        public init(id: String, file: String, role: String, processed: Bool, sampleRate: Int, channels: Int) {
            self.id = id
            self.file = file
            self.role = role
            self.processed = processed
            self.sampleRate = sampleRate
            self.channels = channels
        }
    }

    public static let version = 1

    public let version: Int
    public let engine: String
    public let sampleRate: Int
    public let tracks: [TrackEntry]
    /// Half-open [startMs, endMs) spans where the microphone track could not
    /// be echo-cancelled. Empty when the whole recording is clean.
    public let degradedIntervalsMs: [[UInt64]]

    public init(engine: String, sampleRate: Int, tracks: [TrackEntry], degradedIntervalsMs: [[UInt64]]) {
        self.version = TrackManifest.version
        self.engine = engine
        self.sampleRate = sampleRate
        self.tracks = tracks
        self.degradedIntervalsMs = degradedIntervalsMs
    }

    /// The manifest for a dual-channel session.
    public static func dualChannel(engine: String, degraded: [(startMs: UInt64, endMs: UInt64)]) -> TrackManifest {
        TrackManifest(
            engine: engine,
            sampleRate: DualChannelProcessor.processingRate,
            tracks: [
                TrackEntry(id: "mic_raw", file: "mic_raw.wav", role: "mic", processed: false, sampleRate: 48_000, channels: 1),
                TrackEntry(id: "system_raw", file: "system_raw.wav", role: "system", processed: false, sampleRate: 48_000, channels: 2),
                TrackEntry(id: "mic_processed", file: "mic_processed.wav", role: "mic", processed: true, sampleRate: 16_000, channels: 1),
                TrackEntry(id: "system_processed", file: "system.wav", role: "system", processed: false, sampleRate: 16_000, channels: 1),
            ],
            degradedIntervalsMs: degraded.map { [$0.startMs, $0.endMs] }
        )
    }

    public func write(to directory: URL) {
        let payload: [String: Any] = [
            "version": version,
            "engine": engine,
            "sampleRate": sampleRate,
            "tracks": tracks.map { entry in
                [
                    "id": entry.id,
                    "file": entry.file,
                    "role": entry.role,
                    "processed": entry.processed,
                    "sampleRate": entry.sampleRate,
                    "channels": entry.channels,
                ]
            },
            "degradedIntervalsMs": degradedIntervalsMs,
        ]
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys]) else { return }
        try? data.write(to: directory.appendingPathComponent("tracks.json"), options: .atomic)
    }
}
