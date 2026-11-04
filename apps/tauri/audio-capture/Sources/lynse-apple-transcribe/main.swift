import AudioCaptureCore
import AVFoundation
import Foundation
import Speech
#if canImport(Translation)
import Translation
#endif

/// Batch on-device transcription (Apple SpeechAnalyzer/SpeechTranscriber,
/// macOS 26+). Usage:
///
///   lynse-apple-transcribe <audio-path> --locale zh-CN [--output out.json]
///
/// Emits a segments JSON compatible with the Rust `normalize_whisper_output`
/// reader (segments with text + startMs/endMs). Progress and asset downloads
/// go to stderr; the Rust adapter captures stderr for diagnostics only.
///
/// The file is fed through Apple's own `AssetInputSequenceProvider` (AVAsset →
/// analyzer inputs) — the supported batch path. Manual buffer plumbing was
/// tried and abandoned: AnalyzerInput traps on format mismatches and the
/// analyzer's chosen format is not directly constructible from PCM bytes.

private let arguments = CommandLine.arguments

private func argumentValue(_ name: String) -> String? {
    guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else { return nil }
    return arguments[index + 1]
}

private func log(_ message: String) {
    FileHandle.standardError.write(Data((message + "\n").utf8))
}

private func fail(_ message: String) -> Never {
    log("error: \(message)")
    let payload: [String: Any] = ["error": message]
    if let output = argumentValue("--output"),
       let data = try? JSONSerialization.data(withJSONObject: payload) {
        try? data.write(to: URL(fileURLWithPath: output))
    }
    exit(1)
}

final class ResultBox<T> {
    var value: Result<T, Error>?
}

/// Run async work from the synchronous top level of main.
private func runAwaitThrow<T>(_ body: @escaping () async throws -> T) throws -> T {
    let box = ResultBox<T>()
    let semaphore = DispatchSemaphore(value: 0)
    Task.detached {
        do {
            box.value = .success(try await body())
        } catch {
            box.value = .failure(error)
        }
        semaphore.signal()
    }
    semaphore.wait()
    switch box.value! {
    case .success(let value): return value
    case .failure(let error): throw error
    }
}

/// One file through the recognizer. Availability-gated as a whole: top-level
/// code cannot hold unavailable types across `guard #available` (global-code
/// availability checking is unreliable), so everything lives in this function.
@available(macOS 27.0, *)
private func transcribeFile(audioPath: String, localeID: String, outputPath: String?) async -> Never {
    let transcriber: SpeechTranscriber
    do {
        transcriber = try SpeechTranscriber(
            locale: Locale(identifier: localeID),
            transcriptionOptions: [],
            // fastResults: without it Chinese only reports every ~11s of audio.
            reportingOptions: [.volatileResults, .fastResults],
            attributeOptions: []
        )
    } catch {
        fail("cannot create transcriber for \(localeID): \(error.localizedDescription)")
    }

    // Register the locale's assets, downloading on first use.
    do {
        let status = await AssetInventory.status(forModules: [transcriber])
        if status != .installed && status != .unsupported {
            log("downloading locale assets: \(localeID)")
            let current = Locale(identifier: localeID)
            let reserved = await AssetInventory.reservedLocales
            if !reserved.contains(current) {
                try await AssetInventory.reserve(locale: current)
            }
            if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                try await request.downloadAndInstall()
                log("locale assets installed: \(localeID)")
            }
        }
        if status == .unsupported {
            fail("locale \(localeID) is not supported by on-device transcription")
        }
    } catch {
        fail("asset check failed: \(error.localizedDescription)")
    }

    let asset = AVAsset(url: URL(fileURLWithPath: audioPath))
    let provider: AssetInputSequenceProvider
    do {
        provider = try await AssetInputSequenceProvider.provider(from: asset, compatibleWith: [transcriber], priority: nil)
    } catch {
        fail("cannot read audio asset: \(error.localizedDescription)")
    }

    let analyzer = SpeechAnalyzer(modules: [transcriber])
    do {
        try await analyzer.start(inputSequence: provider.analyzerInputs)
    } catch {
        fail("transcription start failed: \(error.localizedDescription)")
    }
    log("analyzer started")

    // Apple's sample pattern: consume results CONCURRENTLY while the main
    // task finalizes — the results sequence only completes once the analyzer
    // finishes, and a foreground iteration stalls.
    let collector = Task {
        var collected: [[String: Any]] = []
        var lastEnd: UInt64 = 0
        do {
            for try await result in transcriber.results {
                let text = String(result.text.characters)
                guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
                guard result.isFinal else { continue }
                let startMs = max(0, CMTimeGetSeconds(result.range.start) * 1000.0)
                let endMs = max(0, CMTimeGetSeconds(result.range.end) * 1000.0)
                // Overlap guard: finals occasionally re-emit the previous
                // sentence; skip anything ending before the last midpoint.
                let end = UInt64(endMs)
                guard end > lastEnd else { continue }
                lastEnd = end
                log("final: [\(Int(startMs))-\(Int(endMs))] \(text)")
                collected.append([
                    "text": text,
                    "startMs": Int(startMs),
                    "endMs": Int(endMs),
                ])
            }
        } catch {
            log("results stream error: \(error.localizedDescription)")
        }
        return collected
    }

    do {
        try await analyzer.finalizeAndFinishThroughEndOfInput()
        log("finalized")
    } catch {
        log("finalize failed: \(error.localizedDescription)")
    }

    // Bounded wait: a wedged analyzer must not hang the batch forever.
    var collected: [[String: Any]] = []
    await withTaskGroup(of: [[String: Any]].self) { group in
        group.addTask { await collector.value }
        group.addTask {
            try? await Task.sleep(nanoseconds: 180_000_000_000)
            collector.cancel()
            return []
        }
        if let first = await group.next() {
            collected = first
        }
        group.cancelAll()
    }

    writeTranscript(finals: collected, localeID: localeID, outputPath: outputPath)
}

private func writeTranscript(finals: [[String: Any]], localeID: String, outputPath: String?) -> Never {
    let text = finals.compactMap { $0["text"] as? String }.joined(separator: " ")
    let payload: [String: Any] = [
        "segments": finals,
        "text": text,
        "locale": localeID,
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted]) else {
        fail("cannot serialize transcript")
    }
    if let outputPath {
        do {
            try data.write(to: URL(fileURLWithPath: outputPath))
        } catch {
            fail("cannot write output: \(error.localizedDescription)")
        }
    } else {
        FileHandle.standardOutput.write(data)
    }
    exit(0)
}

// ── On-device translation mode (macOS 15+, Translation framework) ────────
/// lynse-apple-transcribe --translate <text> --from zh-Hans --to en
/// Emits {"text": "..."} on stdout. Kept in this sidecar because the
/// Translation framework is Swift-only and the Rust side has no bindings.
/// The direct TranslationSession init (without a SwiftUI trigger) is macOS 26+.
@available(macOS 26.0, *)
private func translateText(_ text: String, from: String, to: String) async -> Never {
    do {
        let session = try await TranslationSession(installedSource: Locale.Language(identifier: from), target: Locale.Language(identifier: to))
        let translated = try await session.translate(text)
        let payload: [String: Any] = ["text": translated]
        if let data = try? JSONSerialization.data(withJSONObject: payload) {
            FileHandle.standardOutput.write(data)
        }
        exit(0)
    } catch {
        fail("translation failed: \(error.localizedDescription)")
    }
}

// ── Entry ────────────────────────────────────────────────────────────────
if argumentValue("--translate") != nil {
    guard let text = argumentValue("--translate"), !text.trimmingCharacters(in: .whitespaces).isEmpty else {
        fail("--translate requires text")
    }
    let from = argumentValue("--from") ?? "zh-Hans"
    let to = argumentValue("--to") ?? "en"
    if #available(macOS 26.0, *) {
        Task.detached {
            await translateText(text, from: from, to: to)
        }
        dispatchMain()
    } else {
        fail("Apple on-device translation requires macOS 26 or newer")
    }
}
guard let audioPath = arguments.count > 1 && !arguments[1].hasPrefix("--") ? arguments[1] : nil else {
    fail("usage: lynse-apple-transcribe <audio-path> --locale <bcp47> [--output out.json]")
}
let localeID = argumentValue("--locale") ?? "zh-CN"
let outputPath = argumentValue("--output")

guard FileManager.default.fileExists(atPath: audioPath) else {
    fail("audio file not found: \(audioPath)")
}
guard AppleSpeechAvailability.isSupported() else {
    fail("on-device transcription requires macOS 26 or newer")
}
// Top-level code cannot rely on `guard #available` for availability-checked
// symbols (global-code checking is unreliable); an explicit if-region works.
// macOS 27+ feeds the file through Apple's AssetInputSequenceProvider; macOS 26
// (where that type does not exist yet) falls back to manual PCM streaming.
if #available(macOS 27.0, *) {
    Task.detached {
        await transcribeFile(audioPath: audioPath, localeID: localeID, outputPath: outputPath)
    }
    dispatchMain()
} else if #available(macOS 26.0, *) {
    Task.detached {
        await transcribeFileManually(audioPath: audioPath, localeID: localeID, outputPath: outputPath)
    }
    dispatchMain()
} else {
    fail("on-device transcription requires macOS 26 or newer")
}

/// macOS 26 fallback: manual PCM decode + feed through AppleSpeechStream.
@available(macOS 26.0, *)
private func transcribeFileManually(audioPath: String, localeID: String, outputPath: String?) async -> Never {
    guard let file = try? AVAudioFile(forReading: URL(fileURLWithPath: audioPath)) else {
        fail("cannot decode audio file: \(audioPath)")
    }
    let srcFormat = file.processingFormat
    guard let targetFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false),
          let converter = AVAudioConverter(from: srcFormat, to: targetFormat) else {
        fail("cannot convert \(srcFormat.sampleRate) Hz → 16 kHz")
    }
    var finals: [[String: Any]] = []
    var lastFinalEndMs: UInt64 = 0
    let stream = AppleSpeechStream(localeID: localeID, onResult: { result in
        guard result.isFinal, !result.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        guard result.endMs > lastFinalEndMs else { return }
        lastFinalEndMs = result.endMs
        finals.append([
            "text": result.text,
            "startMs": Int(result.startMs),
            "endMs": Int(result.endMs),
        ])
    })
    do {
        _ = try await stream.ensureAssets()
        try await stream.start(startElapsedMs: 0)
    } catch {
        fail("transcription start failed: \(error.localizedDescription)")
    }
    let chunkFrames = AVAudioFrameCount(16_000)
    var samplesBuffer: [Int16] = []
    let inputCapacity = AVAudioFrameCount(32_768)
    while file.framePosition < file.length {
        guard let input = AVAudioPCMBuffer(pcmFormat: srcFormat, frameCapacity: inputCapacity),
              let output = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: chunkFrames) else { break }
        do { try file.read(into: input) } catch { break }
        guard input.frameLength > 0 else { break }
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, outStatus in
            outStatus.pointee = .haveData
            return input
        }
        guard status != .error else { break }
        let channel = output.floatChannelData![0]
        samplesBuffer.removeAll(keepingCapacity: true)
        samplesBuffer.reserveCapacity(Int(output.frameLength))
        for index in 0..<Int(output.frameLength) {
            let value = max(-1.0, min(1.0, channel[index]))
            samplesBuffer.append(Int16(clamping: Int(value * 32767.0)))
        }
        await stream.feed(samples: samplesBuffer, startElapsedMs: 0)
    }
    await stream.finish()
    writeTranscript(finals: finals, localeID: localeID, outputPath: outputPath)
}
