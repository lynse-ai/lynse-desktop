import Foundation
import AVFoundation

// The SpeechAnalyzer APIs ship in the Speech framework with the macOS 26 SDK
// (Xcode 26+). canImport(Speech) is unreliable here: SPM's explicit-module
// builds evaluate it against the scanned module graph and report false even
// when the framework is present, silently compile-stubbing the feature out.
// The compiler version is the reliable proxy for "SDK has SpeechTranscriber";
// call sites additionally gate on availability at runtime.

#if compiler(>=6.2)
import Speech
import CoreMedia

/// Local on-device recognizer built on Apple SpeechAnalyzer / SpeechTranscriber
/// (macOS 26+). Shared by the live capture sidecar (per-source streaming
/// results) and the batch `lynse-apple-transcribe` binary (file → segments).
///
/// The caller feeds 16 kHz mono samples tagged with the *session* timeline
/// position of their first sample. The analyzer's own clock counts fed audio,
/// so results are re-based onto the session timeline via the first feed's
/// position — and when a feeding gap is detected (pause, source switch), the
/// recognizer restarts with the new base instead of letting every later
/// timestamp drift behind the session clock.
///
/// Callbacks are fixed at init: actor-isolated state is never touched from
/// outside after construction.

@available(macOS 26.0, *)
public actor AppleSpeechStream {
    public struct Result {
        public var text: String
        public var isFinal: Bool
        public var startMs: UInt64
        public var endMs: UInt64
    }

    private let localeID: String
    private let onResult: ((Result) -> Void)?
    private let onStatus: ((String) -> Void)?
    private var analyzer: SpeechAnalyzer?
    private var continuation: AsyncStream<AnalyzerInput>.Continuation?
    private var resultsTask: Task<Void, Never>?
    /// Set when the results loop exits — finish() polls this with a bound
    /// instead of awaiting the task (awaiting Task.value is not cancellable).
    private var resultsDone = false
    /// The format bestAvailableAudioFormat handed back — AnalyzerInput traps
    /// on buffers in any other format, so feed() converts into this.
    private var feedFormat: AVAudioFormat?
    /// Session-timeline ms that fed sample 0 corresponds to.
    private var baseMs: UInt64 = 0
    /// Total fed samples since the current base — the analyzer clock in samples.
    private var fedSamples: Int64 = 0

    public static func isSupported() -> Bool {
        if #available(macOS 26.0, *) { return true }
        return false
    }

    public init(localeID: String, onResult: ((Result) -> Void)? = nil, onStatus: ((String) -> Void)? = nil) {
        self.localeID = localeID
        self.onResult = onResult
        self.onStatus = onStatus
    }

    /// Verify the locale's transcription assets exist, downloading on first
    /// use. Returns a short status word for the control log.
    public func ensureAssets() async throws -> String {
        let transcriber = try Self.makeTranscriber(localeID: localeID)
        let status = await AssetInventory.status(forModules: [transcriber])
        switch status {
        case .installed:
            return "installed"
        case .unsupported:
            throw NSError(domain: "AppleSpeech", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "Locale \(localeID) is not supported by on-device transcription",
            ])
        default:
            // Reserve the locale first: without an allocation the asset
            // request comes back nil ("no download available") and errors
            // surface as assetLocaleNotAllocated.
            let current = Locale(identifier: localeID)
            let reserved = await AssetInventory.reservedLocales
            if !reserved.contains(current) {
                try await AssetInventory.reserve(locale: current)
            }
            onStatus?("downloading locale assets: \(localeID)")
            if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                try await request.downloadAndInstall()
                onStatus?("locale assets installed: \(localeID)")
                return "downloaded"
            }
            throw NSError(domain: "AppleSpeech", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "Locale \(localeID) assets are not installed and no download is available",
            ])
        }
    }

    private static func makeTranscriber(localeID: String) throws -> SpeechTranscriber {
        SpeechTranscriber(
            locale: Locale(identifier: localeID),
            transcriptionOptions: [],
            // fastResults: without it Chinese only reports every ~11s of audio.
            reportingOptions: [.volatileResults, .fastResults],
            attributeOptions: []
        )
    }

    /// Start recognizing with `startElapsedMs` as the session-timeline position
    /// of the first sample that will be fed.
    public func start(startElapsedMs: UInt64) async throws {
        let transcriber = try Self.makeTranscriber(localeID: localeID)
        let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])
            ?? AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!
        let stream = AsyncStream.makeStream(of: AnalyzerInput.self, bufferingPolicy: .unbounded)
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        do {
            try await analyzer.prepareToAnalyze(in: format)
        } catch {
            onStatus?("prepareToAnalyze failed: \(error.localizedDescription)")
        }
        try await analyzer.start(inputSequence: stream.stream)
        onStatus?("analyzer started, format=\(format.sampleRate)Hz \(format.commonFormat.rawValue)")
        baseMs = startElapsedMs
        fedSamples = 0
        self.analyzer = analyzer
        self.feedFormat = format
        continuation = stream.continuation
        let base = startElapsedMs
        let handler = onResult
        resultsTask = Task {
            do {
                var resultCount = 0
                for try await result in transcriber.results {
                    resultCount += 1
                    if resultCount == 1 {
                        handler?(Result(text: "", isFinal: false, startMs: 0, endMs: 0)) // first-result probe
                    }
                    let text = String(result.text.characters)
                    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
                    // Analyzer clock (fed audio) → session timeline.
                    let fedStart = max(0, CMTimeGetSeconds(result.range.start) * 1000.0)
                    let fedEnd = max(0, CMTimeGetSeconds(result.range.end) * 1000.0)
                    handler?(Result(
                        text: text,
                        isFinal: result.isFinal,
                        startMs: base + UInt64(fedStart),
                        endMs: base + UInt64(max(fedStart, fedEnd))
                    ))
                }
            } catch {
                // Stream ended (restart or teardown); teardown errors are
                // expected and handled by the restart/finish paths.
            }
            resultsDone = true
        }
    }

    /// Feed samples whose first sample sits at `startElapsedMs` on the session
    /// timeline. A gap larger than the restart threshold tears the recognizer
    /// down and starts a fresh one re-based at the new position.
    public func feed(samples: [Int16], startElapsedMs: UInt64) async {
        guard !samples.isEmpty else { return }
        let expected = baseMs + UInt64(fedSamples * 1000 / 16_000)
        if analyzer != nil, startElapsedMs > expected + 1_500 {
            onStatus?("asr gap detected, restarting at \(startElapsedMs)ms")
            await finish()
        }
        if analyzer == nil {
            do {
                try await start(startElapsedMs: startElapsedMs)
            } catch {
                onStatus?("asr start failed: \(error.localizedDescription)")
                return
            }
        }
        fedSamples += Int64(samples.count)
        guard let continuation, let feedFormat else { return }
        // AnalyzerInput traps unless the buffer matches the analyzer's own
        // chosen format exactly. Fill it sample-by-sample: for mono, the
        // interleaved and deinterleaved layouts are identical, so a direct
        // write through the buffer list covers every observed format — and
        // AVAudioConverter refuses interleaved inputs, so it cannot be used
        // here. (Rates other than 16 kHz would need a resampler first; the
        // analyzer has so far always asked for 16 kHz.)
        guard feedFormat.sampleRate == 16_000, feedFormat.channelCount == 1 else { return }
        let buffer = AVAudioPCMBuffer(pcmFormat: feedFormat, frameCapacity: AVAudioFrameCount(samples.count))!
        buffer.frameLength = AVAudioFrameCount(samples.count)
        let abl = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
        guard let data = abl[0].mData else { return }
        switch feedFormat.commonFormat {
        case .pcmFormatFloat32:
            let out = data.assumingMemoryBound(to: Float.self)
            for (index, sample) in samples.enumerated() {
                out[index] = Float(sample) / 32768.0
            }
        case .pcmFormatInt16:
            let out = data.assumingMemoryBound(to: Int16.self)
            for (index, sample) in samples.enumerated() {
                out[index] = sample
            }
        default:
            return
        }
        continuation.yield(AnalyzerInput(buffer: buffer))
    }

    /// Flush pending audio through the recognizer so the last words are
    /// captured (batch tail, stop path). Finalize — not cancel — or unprocessed
    /// audio is discarded; then wait for the results stream to close.
    public func finish() async {
        resultsDone = false
        // End the input stream; the analyzer drains what it holds, finalizes
        // the trailing utterance and closes the results sequence on its own.
        // (Calling finalizeAndFinishThroughEndOfInput with the stream still
        // open was observed to block forever.)
        continuation?.finish()
        // Bounded drain: everything finalized by now is already in the
        // callback; a wedged results stream must not hang the caller.
        let deadline = Date().addingTimeInterval(60)
        while !resultsDone && Date() < deadline {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        resultsTask?.cancel()
        analyzer = nil
        continuation = nil
        feedFormat = nil
    }
}

#else

/// Compile-out stub for toolchains older than Xcode 26 (no SpeechAnalyzer
/// APIs): call sites gate on `AppleSpeechAvailability.isSupported()` and
/// never construct a stream.

#endif
