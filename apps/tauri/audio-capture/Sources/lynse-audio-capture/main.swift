import AppKit
import AudioCaptureCore
import AudioToolbox
import AVFoundation
import CoreGraphics
import CoreMedia
import Darwin
import Foundation
import ScreenCaptureKit

private let targetSampleRate = 48_000.0
private let recognitionSampleRate = 16_000.0
/// Full-bandwidth playback mix archived beside the recognition tracks. Named
/// by the Rust persist path (`live_translation::MASTER_TRACK_FILE`); it is a
/// derived artifact, so it is deliberately not one of the `tracks.json` tracks.
private let masterTrackName = "master.wav"
private let controlLock2 = NSLock()
private let microphonePermissionMessage = "缺少麦克风权限。请在“系统设置 → 隐私与安全性 → 麦克风”中允许 Lynse，然后重新启动应用。"
private let systemAudioPermissionMessage = "缺少“屏幕与系统音频录制”权限。请在“系统设置 → 隐私与安全性 → 屏幕与系统音频录制”中允许 Lynse Audio Capture，然后重新启动 Lynse。"

private let controlLock = NSLock()

private func emit(_ payload: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(payload),
          let data = try? JSONSerialization.data(withJSONObject: payload),
          var line = String(data: data, encoding: .utf8) else { return }
    line.append("\n")
    controlLock.lock()
    defer { controlLock.unlock() }
    FileHandle.standardOutput.write(Data(line.utf8))
    try? FileHandle.standardOutput.synchronize()
}

private func emitError(_ message: String) {
    emit(["event": "error", "message": message])
}

private func microphonePermission() -> String {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return "granted"
    case .denied, .restricted: return "denied"
    case .notDetermined: return "notDetermined"
    @unknown default: return "denied"
    }
}

private func permissionStatus() -> [String: Any] {
    [
        "event": "permissionStatus",
        "microphone": microphonePermission(),
        "systemAudio": CGPreflightScreenCaptureAccess() ? "granted" : "denied",
    ]
}

private func requestMicrophonePermission() {
    let semaphore = DispatchSemaphore(value: 0)
    AVCaptureDevice.requestAccess(for: .audio) { _ in semaphore.signal() }
    _ = semaphore.wait(timeout: .now() + 60)
    emit(permissionStatus())
}

private func requestSystemAudioPermission() {
    let granted = CGRequestScreenCaptureAccess()
    var result = permissionStatus()
    result["restartRequired"] = granted
    emit(result)
}

private let arguments = CommandLine.arguments
if arguments.contains("--permission-status") {
    emit(permissionStatus())
    exit(0)
}
if arguments.contains("--request-microphone") {
    requestMicrophonePermission()
    exit(0)
}
if arguments.contains("--request-system-audio") {
    requestSystemAudioPermission()
    exit(0)
}

private func argumentValue(_ name: String) -> String? {
    guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else { return nil }
    return arguments[index + 1]
}

// ───────────────────────────────────────────────────────────────
// Offline reprocessing: rebuild the processed tracks from the raw
// recordings (crash recovery, or the "重新处理" entry point).
// Usage: lynse-audio-capture --process <session-dir>
// ───────────────────────────────────────────────────────────────
if let processDirectory = argumentValue("--process") {
    guard #available(macOS 15.0, *) else {
        emitError("离线重新处理需要 macOS 15 或更高版本。")
        exit(2)
    }
    let directory = URL(fileURLWithPath: processDirectory, isDirectory: true)
    let micRawURL = directory.appendingPathComponent("mic_raw.wav")
    let systemRawURL = directory.appendingPathComponent("system_raw.wav")
    guard let micRaw = WavReader(path: micRawURL), micRaw.channels == 1 else {
        emitError("重新处理失败：缺少原始麦克风音轨 (mic_raw.wav)")
        exit(5)
    }
    guard let systemRaw = WavReader(path: systemRawURL), systemRaw.channels == 2 else {
        emitError("重新处理失败：缺少原始系统音轨 (system_raw.wav)")
        exit(5)
    }

    let processedWav: WavWriter
    let system16kWav: WavWriter
    let replayMasterWav: WavWriter
    do {
        processedWav = try WavWriter(path: directory.appendingPathComponent("mic_processed.wav").path, sampleRate: 16_000, channels: 1)
        system16kWav = try WavWriter(path: directory.appendingPathComponent("system.wav").path, sampleRate: 16_000, channels: 1)
        replayMasterWav = try WavWriter(path: directory.appendingPathComponent(masterTrackName).path, sampleRate: 48_000, channels: 2)
    } catch {
        emitError("重新处理失败：\(error.localizedDescription)")
        exit(5)
    }

    // Reprocessing must not silently change the canceller setting: it rebuilds
    // what live capture would have produced, so it obeys the same `--aec` flag.
    let processor = DualChannelProcessor(enableAec: arguments.contains("--aec"))
    processor.onMicProcessed16k = { startMs, samples in
        processedWav.write(samples: samples, firstFrameElapsedMs: startMs)
    }
    processor.onSystem16k = { startMs, samples in
        system16kWav.write(samples: samples, firstFrameElapsedMs: startMs)
    }
    processor.onMaster48k = { startMs, samples in
        replayMasterWav.write(samples: samples, firstFrameElapsedMs: startMs)
    }

    let chunk = DualChannelProcessor.processingRate / 50  // 20 ms
    let frameCount = min(micRaw.frameCount, systemRaw.frameCount)
    var offset = 0
    while offset < frameCount {
        let end = min(offset + chunk, frameCount)
        let micChunk = Array(micRaw.samples[offset * micRaw.channels..<end * micRaw.channels])
            .map { Float($0) / 32_767.0 }
        let systemChunk = Array(systemRaw.samples[offset * systemRaw.channels..<end * systemRaw.channels])
            .map { Float($0) / 32_767.0 }
        let position = Int64(offset)
        // Alternate push order to mirror the live callback races.
        if (offset / chunk) % 2 == 0 {
            processor.pushMic(positionSamples: position, samples: micChunk)
            processor.pushSystem(positionSamples: position, samples: systemChunk)
        } else {
            processor.pushSystem(positionSamples: position, samples: systemChunk)
            processor.pushMic(positionSamples: position, samples: micChunk)
        }
        offset = end
    }
    processor.flush()
    processedWav.close()
    system16kWav.close()
    replayMasterWav.close()

    let degraded = processor.snapshotDegradedIntervals()
    TrackManifest.dualChannel(
        engine: processor.aecActive ? AecProcessor.engineId : "none",
        degraded: degraded
    ).write(to: directory)
    emit([
        "event": "processed",
        "durationMs": UInt64(frameCount) * 1_000 / UInt64(DualChannelProcessor.processingRate),
        "engine": processor.aecActive ? AecProcessor.engineId : "none",
        "degradedIntervals": degraded.map { [$0.startMs, $0.endMs] },
    ])
    exit(0)
}

guard #available(macOS 15.0, *) else {
    emitError("实时双流转写需要 macOS 15 或更高版本。")
    exit(2)
}
guard let socketPath = argumentValue("--socket"), !socketPath.isEmpty,
      let outputPath = argumentValue("--out"), !outputPath.isEmpty else {
    emitError("missing --socket or --out")
    exit(2)
}
// Capture-source mode: `--sources mic|system|both` (default both).
// "system" is the transcribe-a-playing-video case — the mic would only
// contribute a duplicate echo of the same audio.
let sourcesMode = argumentValue("--sources") ?? "both"
let captureMic: Bool
let captureSystem: Bool
switch sourcesMode {
case "mic": (captureMic, captureSystem) = (true, false)
case "system": (captureMic, captureSystem) = (false, true)
default: (captureMic, captureSystem) = (true, true)
}
// Dual-track layout: raw 48 kHz tracks + the 48 kHz master, which needs the
// two streams paired on one timeline. `--aec` is a *separate* switch on top of
// it: with both sources but without `--aec` the pairing, raw archive and master
// all still happen and only the canceller is bypassed, so echo cancellation can
// be A/B-compared against the same bandwidth and the same mixdown. Without both
// sources the sidecar falls back to the legacy 16 kHz pipeline.
let aecRequested = arguments.contains("--aec")
let dualChannel = captureMic && captureSystem
let aecEnabled = dualChannel && aecRequested
/// Microphone capture API. Core Audio (`AVAudioEngine`) is the default and the
/// one every other macOS recorder uses; ScreenCaptureKit's `.microphone` tap
/// goes through the screen-recording stack. `--mic-sck` keeps the old path
/// reachable so the two can be A/B-compared on the same room.
let micViaCoreAudio = captureMic && !arguments.contains("--mic-sck")

guard !captureMic || microphonePermission() == "granted" else {
    emitError(microphonePermissionMessage)
    exit(4)
}
guard !captureSystem || CGPreflightScreenCaptureAccess() else {
    emitError(systemAudioPermissionMessage)
    exit(4)
}

NSApplication.shared.setActivationPolicy(.prohibited)

private var sleepPreventionActivity: NSObjectProtocol?

private func preventIdleSystemSleep() {
    guard sleepPreventionActivity == nil else { return }
    sleepPreventionActivity = ProcessInfo.processInfo.beginActivity(
        options: [.idleSystemSleepDisabled],
        reason: "Lynse is recording and translating live audio."
    )
}

private func allowIdleSystemSleep() {
    guard let activity = sleepPreventionActivity else { return }
    ProcessInfo.processInfo.endActivity(activity)
    sleepPreventionActivity = nil
}

preventIdleSystemSleep()

private func appendLittleEndian<T: FixedWidthInteger>(_ value: T, to data: inout Data) {
    var little = value.littleEndian
    Swift.withUnsafeBytes(of: &little) { data.append(contentsOf: $0) }
}

private final class LocalSocketWriter {
    private var fd: Int32 = -1
    private let lock = NSLock()

    init(path: String) throws {
        fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw POSIXError(.ENOTSOCK) }

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(path.utf8CString)
        guard pathBytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
            Darwin.close(fd)
            throw POSIXError(.ENAMETOOLONG)
        }
        withUnsafeMutablePointer(to: &address.sun_path) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: pathBytes.count) { destination in
                _ = pathBytes.withUnsafeBufferPointer { source in
                    memcpy(destination, source.baseAddress, source.count)
                }
            }
        }

        let length = socklen_t(MemoryLayout<sa_family_t>.size + pathBytes.count)
        var connected = false
        for _ in 0..<50 {
            let result = withUnsafePointer(to: &address) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.connect(fd, $0, length)
                }
            }
            if result == 0 {
                connected = true
                break
            }
            usleep(100_000)
        }
        if !connected {
            let code = errno
            Darwin.close(fd)
            fd = -1
            throw POSIXError(POSIXErrorCode(rawValue: code) ?? .ECONNREFUSED)
        }
    }

    func send(source: UInt8, sequence: UInt64, elapsedMs: UInt64, pcm: Data) throws {
        var packet = Data(capacity: 19 + pcm.count)
        packet.append(source)
        appendLittleEndian(sequence, to: &packet)
        appendLittleEndian(elapsedMs, to: &packet)
        appendLittleEndian(UInt16(pcm.count), to: &packet)
        packet.append(pcm)

        try lock.withLock {
            var written = 0
            try packet.withUnsafeBytes { raw in
                guard let base = raw.baseAddress else { return }
                while written < raw.count {
                    let count = Darwin.write(fd, base.advanced(by: written), raw.count - written)
                    if count <= 0 { throw POSIXError(.EPIPE) }
                    written += count
                }
            }
        }
    }

    func close() {
        lock.lock()
        defer { lock.unlock() }
        if fd >= 0 {
            Darwin.shutdown(fd, SHUT_RDWR)
            Darwin.close(fd)
            fd = -1
        }
    }
}

private extension NSLock {
    func withLock<T>(_ body: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try body()
    }
}

private extension Array where Element == Int16 {
    func withUnsafeBytesData() -> Data {
        withUnsafeBytes { Data($0) }
    }
}

private extension UInt64 {
    func saturatingMultiply(_ other: UInt64) -> UInt64 {
        let (value, overflow) = multipliedReportingOverflow(by: other)
        return overflow ? UInt64.max : value
    }
}

private final class ActiveClock {
    private let started = DispatchTime.now().uptimeNanoseconds
    private var pausedAt: UInt64?
    private var pausedNanos: UInt64 = 0
    private let lock = NSLock()

    func elapsedMs() -> UInt64 {
        lock.withLock {
            let now = pausedAt ?? DispatchTime.now().uptimeNanoseconds
            return (now - started - pausedNanos) / 1_000_000
        }
    }

    func pause() {
        lock.withLock {
            if pausedAt == nil { pausedAt = DispatchTime.now().uptimeNanoseconds }
        }
    }

    func resume() {
        lock.withLock {
            guard let pausedAt else { return }
            pausedNanos += DispatchTime.now().uptimeNanoseconds - pausedAt
            self.pausedAt = nil
        }
    }
}

private final class LevelState {
    private var peaks: [Float] = [0, 0]
    private let lock = NSLock()

    func record(source: Int, samples: [Float]) {
        let peak = samples.reduce(Float(0)) { max($0, abs($1)) }
        lock.withLock { peaks[source] = max(peaks[source], peak) }
    }

    func take() -> (Float, Float) {
        lock.withLock {
            let result = (peaks[0], peaks[1])
            peaks = [0, 0]
            return result
        }
    }
}

// ───────────────────────────────────────────────────────────────
// Recognition output: 16 kHz WAV + recognition socket, 20 ms frames.
// ───────────────────────────────────────────────────────────────
private final class RecognitionSink {
    let source: UInt8
    let socket: LocalSocketWriter
    let wav: WavWriter
    var assembler = PCMFrameAssembler()
    let queue: DispatchQueue

    init(source: UInt8, name: String, socket: LocalSocketWriter, wav: WavWriter) {
        self.source = source
        self.socket = socket
        self.wav = wav
        queue = DispatchQueue(label: "app.lynse.capture.\(name)")
    }

    func consume(_ samples: [Int16], firstFrameElapsedMs: UInt64) {
        queue.async {
            self.wav.write(samples: samples, firstFrameElapsedMs: firstFrameElapsedMs)
            let frames = self.assembler.append(samples: samples, chunkStartMs: firstFrameElapsedMs)
            self.send(frames)
        }
    }

    /// The flush tail of a stream: continues where the last chunk stopped, so
    /// neither the track writer nor the frame assembler is handed a fake
    /// timestamp to work that out from.
    func consumeContiguous(_ samples: [Int16]) {
        queue.async {
            self.wav.writeContiguous(samples: samples)
            self.send(self.assembler.appendContiguous(samples: samples))
        }
    }

    func close() {
        queue.sync {
            send(assembler.finish())
            wav.close()
        }
    }

    private func send(_ frames: [PCMFrame]) {
        for frame in frames {
            do {
                try socket.send(
                    source: source,
                    sequence: frame.sequence,
                    elapsedMs: frame.elapsedMs,
                    pcm: frame.samples.withUnsafeBytesData()
                )
            } catch {
                emitError("audio IPC write failed: \(error.localizedDescription)")
            }
        }
    }
}

// ───────────────────────────────────────────────────────────────
// Legacy single-stream sink (rollback / mic-only / system-only modes):
// converts 48 kHz capture straight to 16 kHz mono, no AEC, no raw tracks.
// ───────────────────────────────────────────────────────────────
private final class LegacySink {
    let source: UInt8
    let recognition: RecognitionSink
    /// 48 kHz archive of exactly what the device delivered, written before the
    /// decimation that serves recognition. Nil when no master is being kept.
    let master: WavWriter?
    var decimator = Decimator48to16()
    let queue: DispatchQueue

    init(source: UInt8, name: String, recognition: RecognitionSink, master: WavWriter?) {
        self.source = source
        self.recognition = recognition
        self.master = master
        queue = DispatchQueue(label: "app.lynse.capture.legacy.\(name)")
    }

    func consume(_ floats: [Float], positionSamples: Int64) {
        queue.async {
            if let master = self.master {
                let startMs = UInt64(max(0, positionSamples) * 1_000 / Int64(targetSampleRate))
                master.write(samples: pcm16(fromFloats: floats), firstFrameElapsedMs: startMs)
            }
            let decimated = self.decimator.decimate(floats)
            guard !decimated.isEmpty else { return }
            let startMs = UInt64(Float(positionSamples) / 48.0)
            let samples = pcm16(fromFloats: decimated)
            self.recognition.consume(samples, firstFrameElapsedMs: startMs)
        }
    }

    func close() {
        queue.sync {
            let tail = self.decimator.flush()
            if !tail.isEmpty {
                recognition.consumeContiguous(pcm16(fromFloats: tail))
            }
            recognition.close()
            master?.close()
        }
    }
}

// ───────────────────────────────────────────────────────────────
// ScreenCaptureKit output: converts each callback to the canonical
// 48 kHz format (mic mono / system stereo) and pushes it, tagged with
// its presentation timestamp, onto the shared processing pipeline.
// ───────────────────────────────────────────────────────────────
private final class AudioConverterState {
    var formatDescription: String = ""
    var converter: AVAudioConverter?
}

@available(macOS 15.0, *)
private final class CaptureOutput: NSObject, SCStreamOutput {
    let source: UInt8
    let channels: Int
    let clock: ActiveClock
    let levels: LevelState
    let onAudio: (_ positionSamples: Int64, _ floats: [Float]) -> Void
    let timeline: TimelineBox
    private let converterState = AudioConverterState()

    init(
        source: UInt8,
        channels: Int,
        clock: ActiveClock,
        levels: LevelState,
        timeline: TimelineBox,
        onAudio: @escaping (_ positionSamples: Int64, _ floats: [Float]) -> Void
    ) {
        self.source = source
        self.channels = channels
        self.clock = clock
        self.levels = levels
        self.timeline = timeline
        self.onAudio = onAudio
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard !shuttingDown else { return }
        guard sampleBuffer.isValid,
              let description = sampleBuffer.formatDescription,
              let basic = CMAudioFormatDescriptionGetStreamBasicDescription(description)?.pointee else { return }

        var streamDescription = basic
        let inputFormat = AVAudioFormat(streamDescription: &streamDescription)
        guard let inputFormat, inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else { return }
        let signature = "\(inputFormat.sampleRate)-\(inputFormat.channelCount)-\(inputFormat.commonFormat.rawValue)-\(inputFormat.isInterleaved)"
        if converterState.converter == nil || converterState.formatDescription != signature {
            guard let target = AVAudioFormat(
                commonFormat: .pcmFormatFloat32,
                sampleRate: targetSampleRate,
                channels: UInt32(channels),
                interleaved: false
            ) else { return }
            converterState.converter = AVAudioConverter(from: inputFormat, to: target)
            converterState.formatDescription = signature
        }
        guard let converter = converterState.converter else { return }

        let frames = AVAudioFrameCount(sampleBuffer.numSamples)
        guard frames > 0,
              let input = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: frames) else { return }
        input.frameLength = frames

        let bufferCount = max(1, Int(inputFormat.channelCount))
        let listSize = MemoryLayout<AudioBufferList>.size
            + max(0, bufferCount - 1) * MemoryLayout<AudioBuffer>.size
        let audioList = AudioBufferList.allocate(maximumBuffers: bufferCount)
        defer { free(audioList.unsafeMutablePointer) }
        var blockBuffer: CMBlockBuffer?
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: audioList.unsafeMutablePointer,
            bufferListSize: listSize,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
            blockBufferOut: &blockBuffer
        )
        guard status == noErr else { return }

        let destination = UnsafeMutableAudioBufferListPointer(input.mutableAudioBufferList)
        for index in 0..<min(destination.count, audioList.count) {
            if let targetData = destination[index].mData, let sourceData = audioList[index].mData {
                memcpy(targetData, sourceData, Int(min(destination[index].mDataByteSize, audioList[index].mDataByteSize)))
            }
        }

        let ratio = targetSampleRate / inputFormat.sampleRate
        let capacity = AVAudioFrameCount(Double(frames) * ratio + 1_024)
        guard let output = AVAudioPCMBuffer(pcmFormat: converter.outputFormat, frameCapacity: capacity) else { return }
        var error: NSError?
        var supplied = false
        let conversion = converter.convert(to: output, error: &error) { _, state in
            if supplied {
                state.pointee = .noDataNow
                return nil
            }
            supplied = true
            state.pointee = .haveData
            return input
        }
        guard conversion != .error, output.frameLength > 0, let channelData = output.floatChannelData else { return }

        // The sample buffer's presentation timestamp places the audio on the
        // shared host clock — both sources use the same timebase, so the
        // tracks stay sample-aligned without arrival-time guesses.
        let ptsSeconds = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
        guard let position = timeline.position(firstSampleSeconds: ptsSeconds) else { return }

        let frameLength = Int(output.frameLength)
        var floats: [Float]
        if channels == 1 {
            floats = Array(UnsafeBufferPointer(start: channelData[0], count: frameLength))
        } else {
            // Interleave the non-interleaved converter output.
            floats = [Float](repeating: 0, count: frameLength * channels)
            for channel in 0..<channels {
                let channelSamples = UnsafeBufferPointer(start: channelData[channel], count: frameLength)
                for index in 0..<frameLength {
                    floats[index * channels + channel] = channelSamples[index]
                }
            }
        }
        levels.record(source: Int(source), samples: floats)
        onAudio(position, floats)
    }
}

// ───────────────────────────────────────────────────────────────
// Microphone through the system capture API (AVAudioEngine → Core Audio).
//
// ScreenCaptureKit's `.microphone` output taps the device through the
// screen-recording stack; this is the path every other macOS recorder takes,
// including Voice Memos, and it is the reference this pipeline is held
// against. Voice processing stays explicitly off so the archived microphone
// track is driver audio and nothing else — the canceller (when enabled) is
// ours, and it must not be stacked on a vendor one.
//
// Buffers carry host (mach) time, the same clock ScreenCaptureKit stamps its
// presentation times with, so the microphone and system tracks stay aligned on
// one timeline even though they now come from two different APIs.
// ───────────────────────────────────────────────────────────────
@available(macOS 15.0, *)
private final class MicEngineCapture {
    private let engine = AVAudioEngine()
    private let timeline: TimelineBox
    private let levels: LevelState
    private let onAudio: (_ positionSamples: Int64, _ floats: [Float]) -> Void
    private var converter: AVAudioConverter?
    private var converterKey = ""
    private(set) var isRunning = false

    init(timeline: TimelineBox, levels: LevelState,
         onAudio: @escaping (_ positionSamples: Int64, _ floats: [Float]) -> Void) {
        self.timeline = timeline
        self.levels = levels
        self.onAudio = onAudio
    }

    /// Host seconds of the shared clock both capture APIs are stamped against.
    static func hostSeconds() -> Double {
        hostClockSeconds()
    }

    func start() throws {
        guard !isRunning else { return }
        let input = engine.inputNode
        let format = input.inputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw NSError(domain: "LynseCapture", code: 6,
                          userInfo: [NSLocalizedDescriptionKey: "麦克风输入格式不可用。"])
        }
        try? input.setVoiceProcessingEnabled(false)
        input.installTap(onBus: 0, bufferSize: 480, format: format) { [weak self] buffer, when in
            self?.deliver(buffer, hostSeconds: AVAudioTime.seconds(forHostTime: when.hostTime))
        }
        engine.prepare()
        do {
            try engine.start()
            isRunning = true
        } catch {
            input.removeTap(onBus: 0)
            throw error
        }
    }

    func stop() {
        guard isRunning else { return }
        isRunning = false
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }

    private func deliver(_ buffer: AVAudioPCMBuffer, hostSeconds rawSeconds: Double) {
        let frames = Int(buffer.frameLength)
        guard frames > 0, buffer.format.channelCount > 0 else { return }
        // Some drivers hand back no host time; the wall clock is the same mach
        // clock, so falling back keeps positions monotonic instead of dropping.
        let seconds = rawSeconds > 0 ? rawSeconds : Self.hostSeconds()
        let floats: [Float]
        if buffer.format.sampleRate == targetSampleRate, buffer.format.channelCount == 1,
           let data = buffer.floatChannelData {
            floats = Array(UnsafeBufferPointer(start: data[0], count: frames))
        } else if let converted = convert(buffer) {
            floats = converted
        } else {
            return
        }
        guard let position = timeline.position(firstSampleSeconds: seconds) else { return }
        levels.record(source: 0, samples: floats)
        onAudio(position, floats)
    }

    /// Any input format → 48 kHz mono Float32.
    private func convert(_ buffer: AVAudioPCMBuffer) -> [Float]? {
        let source = buffer.format
        let key = "\(source.sampleRate)-\(source.channelCount)-\(source.commonFormat.rawValue)"
        if converter == nil || converterKey != key {
            guard let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: targetSampleRate,
                                             channels: 1, interleaved: false),
                  let incoming = AVAudioFormat(commonFormat: source.commonFormat,
                                               sampleRate: source.sampleRate,
                                               channels: source.channelCount,
                                               interleaved: source.isInterleaved)
            else { return nil }
            converter = AVAudioConverter(from: incoming, to: target)
            converterKey = key
        }
        guard let converter else { return nil }
        let target = converter.outputFormat
        let ratio = targetSampleRate / max(1, source.sampleRate)
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 64)
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return nil }
        var error: NSError?
        var supplied = false
        let status = converter.convert(to: out, error: &error) { _, state in
            if supplied {
                state.pointee = .noDataNow
                return nil
            }
            supplied = true
            state.pointee = .haveData
            return buffer
        }
        guard status != .error, out.frameLength > 0, let channels = out.floatChannelData else { return nil }
        return Array(UnsafeBufferPointer(start: channels[0], count: Int(out.frameLength)))
    }
}

@available(macOS 15.0, *)
private final class NoopVideoOutput: NSObject, SCStreamOutput {
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {}
}

@available(macOS 15.0, *)
private final class CaptureDelegate: NSObject, SCStreamDelegate {
    var onUnexpectedStop: ((Error) -> Void)?

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        onUnexpectedStop?(error)
    }
}

private let outputDirectory = URL(fileURLWithPath: outputPath, isDirectory: true)
try? FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)

private let socketWriter: LocalSocketWriter
do {
    socketWriter = try LocalSocketWriter(path: socketPath)
} catch {
    emitError("audio IPC connect failed: \(error.localizedDescription)")
    exit(3)
}

private let clock = ActiveClock()
private let levels = LevelState()

// ───────────────────────────────────────────────────────────────
// Pipeline wiring: dual-channel (raw tracks + AEC) vs legacy.
// ───────────────────────────────────────────────────────────────
/// Reference box so capture outputs always read the CURRENT timeline
/// (re-anchored on every capture restart) rather than a stale copy.
private final class TimelineBox {
    var timeline = SampleTimeline()
    func position(firstSampleSeconds pts: Double) -> Int64? {
        timeline.position(firstSampleSeconds: pts)
    }
}

private let micTimeline = TimelineBox()
private let systemTimeline = TimelineBox()

private let processor = DualChannelProcessor(enableAec: aecEnabled)

private var micRecognition: RecognitionSink!
private var systemRecognition: RecognitionSink!
private var micRawWav: WavWriter?
private var systemRawWav: WavWriter?
private var masterWav: WavWriter?
private var legacyMicSink: LegacySink?
private var legacySystemSink: LegacySink?

do {
    if dualChannel {
        micRecognition = RecognitionSink(
            source: 0, name: "mic", socket: socketWriter,
            wav: try WavWriter(path: outputDirectory.appendingPathComponent("mic_processed.wav").path, sampleRate: 16_000, channels: 1)
        )
        systemRecognition = RecognitionSink(
            source: 1, name: "system", socket: socketWriter,
            wav: try WavWriter(path: outputDirectory.appendingPathComponent("system.wav").path, sampleRate: 16_000, channels: 1)
        )
        micRawWav = try WavWriter(path: outputDirectory.appendingPathComponent("mic_raw.wav").path, sampleRate: 48_000, channels: 1)
        systemRawWav = try WavWriter(path: outputDirectory.appendingPathComponent("system_raw.wav").path, sampleRate: 48_000, channels: 2)
        masterWav = try WavWriter(path: outputDirectory.appendingPathComponent(masterTrackName).path, sampleRate: 48_000, channels: 2)
        legacyMicSink = nil
        legacySystemSink = nil

        processor.onRawMic = { startMs, samples in
            micRawWav?.write(samples: samples, firstFrameElapsedMs: startMs)
        }
        processor.onRawSystem = { startMs, samples in
            systemRawWav?.write(samples: samples, firstFrameElapsedMs: startMs)
        }
        processor.onMicProcessed16k = { startMs, samples in
            micRecognition.consume(samples, firstFrameElapsedMs: startMs)
        }
        processor.onSystem16k = { startMs, samples in
            systemRecognition.consume(samples, firstFrameElapsedMs: startMs)
        }
        processor.onMaster48k = { startMs, samples in
            masterWav?.write(samples: samples, firstFrameElapsedMs: startMs)
        }
    } else {
        micRecognition = RecognitionSink(
            source: 0, name: "mic", socket: socketWriter,
            wav: try WavWriter(path: outputDirectory.appendingPathComponent("mic.wav").path, sampleRate: 16_000, channels: 1)
        )
        systemRecognition = RecognitionSink(
            source: 1, name: "system", socket: socketWriter,
            wav: try WavWriter(path: outputDirectory.appendingPathComponent("system.wav").path, sampleRate: 16_000, channels: 1)
        )
        // Single-source sessions still archive at 48 kHz: the 16 kHz
        // recognition track is not something anyone wants to listen back to.
        // The dual-source rollback path gets no master — summing an
        // un-cancelled microphone into the system mix would just replay the
        // room's own output, so persist falls back to the 16 kHz mixdown.
        let legacyMasterChannels: UInt16? = captureMic != captureSystem ? (captureSystem ? 2 : 1) : nil
        var legacyMaster: WavWriter?
        if let channels = legacyMasterChannels {
            legacyMaster = try WavWriter(path: outputDirectory.appendingPathComponent(masterTrackName).path, sampleRate: 48_000, channels: channels)
        }
        if captureMic {
            legacyMicSink = LegacySink(
                source: 0, name: "mic", recognition: micRecognition,
                master: legacyMaster
            )
        } else {
            legacyMicSink = nil
        }
        if captureSystem {
            legacySystemSink = LegacySink(
                source: 1, name: "system", recognition: systemRecognition,
                master: legacyMaster
            )
        } else {
            legacySystemSink = nil
        }
        micRawWav = nil
        systemRawWav = nil
    }
} catch {
    emitError("recording files unavailable: \(error.localizedDescription)")
    exit(3)
}

private var micOutput: CaptureOutput!
private var systemOutput: CaptureOutput!
/// The microphone feed when it comes from Core Audio instead of
/// ScreenCaptureKit — exactly one of the two is live.
private var micEngine: MicEngineCapture?

private let videoOutput = NoopVideoOutput()
private let captureDelegate = CaptureDelegate()

private var captureStream: SCStream?
private var paused = false
private var shuttingDown = false
private var restartingCapture = false
private var lastMicrophoneDeviceID = AVCaptureDevice.default(for: .audio)?.uniqueID

@available(macOS 15.0, *)
private func makeOutputs() {
    // The microphone arrives from one API at a time and is then handed to
    // whichever pipeline owns the session; the system feed always comes from
    // ScreenCaptureKit.
    let pushMic: (Int64, [Float]) -> Void = { position, floats in
        if dualChannel {
            processor.pushMic(positionSamples: position, samples: floats)
        } else {
            legacyMicSink?.consume(floats, positionSamples: position)
        }
    }
    let pushSystem: (Int64, [Float]) -> Void = { position, floats in
        if dualChannel {
            processor.pushSystem(positionSamples: position, samples: floats)
        } else {
            legacySystemSink?.consume(floats, positionSamples: position)
        }
    }
    if captureMic {
        if micViaCoreAudio {
            micEngine = MicEngineCapture(timeline: micTimeline, levels: levels, onAudio: pushMic)
            micOutput = nil
        } else {
            micOutput = CaptureOutput(
                source: 0, channels: 1, clock: clock, levels: levels,
                timeline: micTimeline, onAudio: pushMic
            )
            micEngine = nil
        }
    } else {
        micEngine = nil
        micOutput = nil
    }
    if captureSystem {
        systemOutput = CaptureOutput(
            source: 1, channels: 2, clock: clock, levels: levels,
            timeline: systemTimeline, onAudio: pushSystem
        )
    } else {
        systemOutput = nil
    }
}

/// Seconds on the mach host clock — the clock both ScreenCaptureKit
/// presentation times and Core Audio tap timestamps are stamped against, which
/// is what lets two different capture APIs share one sample timeline.
private func hostClockSeconds() -> Double {
    CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock()))
}

/// Re-bases both track timelines on the processing pipeline's hand-over
/// position. Called before every capture (re)start so device switches,
/// pauses and unexpected SCK stops never rewind the shared timeline.
private func rebaseTimelines() {
    let base = processor.prepareForRestart()
    // Pin both tracks to the same host-clock instant: the microphone may come
    // from Core Audio while the system feed comes from ScreenCaptureKit, and
    // unanchored each would zero on its own first callback.
    let anchor = hostClockSeconds()
    micTimeline.timeline.beginRun(baseSamples: base, anchorSeconds: anchor)
    systemTimeline.timeline.beginRun(baseSamples: base, anchorSeconds: anchor)
}

@available(macOS 15.0, *)
func createCaptureStream() async throws -> SCStream {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let display = content.displays.first else { throw NSError(domain: "LynseCapture", code: 1, userInfo: [NSLocalizedDescriptionKey: "No display is available for audio capture."]) }
    let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
    let configuration = SCStreamConfiguration()
    configuration.capturesAudio = captureSystem
    configuration.excludesCurrentProcessAudio = true
    configuration.sampleRate = 48_000
    configuration.channelCount = 2
    configuration.captureMicrophone = captureMic && !micViaCoreAudio && microphonePermission() == "granted"
    configuration.microphoneCaptureDeviceID = AVCaptureDevice.default(for: .audio)?.uniqueID
    configuration.width = 2
    configuration.height = 2
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
    configuration.queueDepth = 3

    makeOutputs()
    let stream = SCStream(filter: filter, configuration: configuration, delegate: captureDelegate)
    if captureSystem, let systemOutput {
        try stream.addStreamOutput(systemOutput, type: .audio, sampleHandlerQueue: DispatchQueue(label: "app.lynse.capture.system"))
    }
    if configuration.captureMicrophone, let micOutput {
        try stream.addStreamOutput(micOutput, type: .microphone, sampleHandlerQueue: DispatchQueue(label: "app.lynse.capture.mic"))
    }
    try stream.addStreamOutput(videoOutput, type: .screen, sampleHandlerQueue: DispatchQueue(label: "app.lynse.capture.video"))
    return stream
}

@available(macOS 15.0, *)
func startCapture(event: String = "ready") async {
    guard !shuttingDown else { return }
    rebaseTimelines()
    do {
        let stream = try await createCaptureStream()
        try await stream.startCapture()
        captureStream = stream
        // The microphone runs on its own API, so it starts beside the stream
        // rather than through it. `makeOutputs` replaced the object on restart,
        // so nothing else is holding the previous tap.
        if let micEngine {
            try micEngine.start()
        }
        var readyPayload: [String: Any] = [
            "event": event,
            "microphone": microphonePermission() == "granted",
            "systemAudio": CGPreflightScreenCaptureAccess(),
            "dualChannel": dualChannel,
            // Which capture API and canceller actually ran — the log is the
            // only place an A/B comparison of the two can be audited later.
            "microphoneApi": micViaCoreAudio ? "coreaudio" : "screencapturekit",
            "aec": aecEnabled,
        ]
        if let id = lastMicrophoneDeviceID, let device = AVCaptureDevice(uniqueID: id) {
            readyPayload["microphoneCaptureDeviceID"] = id
            readyPayload["microphoneCaptureDeviceName"] = device.localizedName
        } else {
            readyPayload["microphoneCaptureDeviceID"] = NSNull()
            readyPayload["microphoneCaptureDeviceName"] = NSNull()
        }
        emit(readyPayload)
    } catch {
        if !CGPreflightScreenCaptureAccess() {
            emitError(systemAudioPermissionMessage)
        } else if microphonePermission() != "granted" {
            emitError(microphonePermissionMessage)
        } else {
            emitError("音频采集启动失败：\(error.localizedDescription)")
        }
    }
}

@available(macOS 15.0, *)
func restartCapture(reason: String) {
    guard !paused, !shuttingDown, !restartingCapture else { return }
    restartingCapture = true
    emit(["event": "diagnostic", "message": reason])
    let stream = captureStream
    captureStream = nil
    Task {
        if let stream { try? await stream.stopCapture() }
        // Release the input device before the new capture re-opens it, or two
        // taps would deliver into one timeline.
        micEngine?.stop()
        try? await Task.sleep(nanoseconds: 250_000_000)
        lastMicrophoneDeviceID = AVCaptureDevice.default(for: .audio)?.uniqueID
        restartingCapture = false
        await startCapture()
    }
}

captureDelegate.onUnexpectedStop = { error in
    DispatchQueue.main.async {
        restartCapture(reason: "ScreenCaptureKit stopped unexpectedly: \(error.localizedDescription)")
    }
}

@available(macOS 15.0, *)
func pauseCapture() {
    guard !paused, !shuttingDown else { return }
    paused = true
    allowIdleSystemSleep()
    clock.pause()
    micEngine?.stop()   // the microphone is not part of the stream; stop it too
    let stream = captureStream
    captureStream = nil
    Task {
        if let stream { try? await stream.stopCapture() }
        emit(["event": "paused", "elapsedMs": clock.elapsedMs()])
    }
}

@available(macOS 15.0, *)
func resumeCapture() {
    guard paused, !shuttingDown else { return }
    paused = false
    preventIdleSystemSleep()
    clock.resume()
    Task {
        await startCapture(event: "resumed")
    }
}

let levelTimer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "app.lynse.capture.levels"))
levelTimer.schedule(deadline: .now() + .milliseconds(200), repeating: .milliseconds(200))
levelTimer.setEventHandler {
    let (mic, system) = levels.take()
    emit([
        "event": "levels",
        "mic": mic,
        "system": system,
        "elapsedMs": clock.elapsedMs(),
    ])
}
levelTimer.resume()

let deviceTimer = DispatchSource.makeTimerSource(queue: .main)
deviceTimer.schedule(deadline: .now() + 1, repeating: 1)
deviceTimer.setEventHandler {
    let current = AVCaptureDevice.default(for: .audio)?.uniqueID
    if current != lastMicrophoneDeviceID {
        lastMicrophoneDeviceID = current
        restartCapture(reason: "Default microphone changed; restarting capture.")
    }
}
deviceTimer.resume()

let pauseSignal = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
let resumeSignal = DispatchSource.makeSignalSource(signal: SIGUSR2, queue: .main)
signal(SIGUSR1, SIG_IGN)
signal(SIGUSR2, SIG_IGN)
pauseSignal.setEventHandler { pauseCapture() }
resumeSignal.setEventHandler { resumeCapture() }
pauseSignal.resume()
resumeSignal.resume()

let originalParent = getppid()
private var shutdownHandler: (() -> Void)?
let parentTimer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "app.lynse.capture.parent"))
parentTimer.schedule(deadline: .now() + 2, repeating: 2)
parentTimer.setEventHandler {
    let parent = getppid()
    if parent == 1 || (originalParent != 1 && parent != originalParent) {
        DispatchQueue.main.async { shutdownHandler?() }
    }
}
parentTimer.resume()

let shutdown: () -> Void = {
    guard !shuttingDown else { return }
    shuttingDown = true
    allowIdleSystemSleep()
    levelTimer.cancel()
    deviceTimer.cancel()
    parentTimer.cancel()
    // Drain in order: capture stops delivering, the pipeline flushes its
    // echo-cancel and resampler tails, then writers close on a complete
    // timeline so the final words survive.
    let stream = captureStream
    captureStream = nil
    Task {
        if let stream { try? await stream.stopCapture() }
        DispatchQueue.main.async {
            finishAndExit()
        }
    }
}
shutdownHandler = shutdown

/// Closes every writer on the processing queue's turn and exits.
private func finishAndExit() {
    micEngine?.stop()
    processor.flush()
    micRecognition.close()
    if dualChannel || captureSystem {
        systemRecognition.close()
    }
    micRawWav?.close()
    systemRawWav?.close()
    masterWav?.close()
    legacyMicSink?.close()
    legacySystemSink?.close()
    if dualChannel {
        let engine = processor.aecActive ? AecProcessor.engineId : "none"
        TrackManifest.dualChannel(engine: engine, degraded: processor.snapshotDegradedIntervals())
            .write(to: outputDirectory)
    }
    socketWriter.close()
    emit(["event": "stopped", "elapsedMs": clock.elapsedMs()])
    exit(0)
}

let termSignal = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
let intSignal = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
termSignal.setEventHandler(handler: shutdown)
intSignal.setEventHandler(handler: shutdown)
termSignal.resume()
intSignal.resume()

if #available(macOS 15.0, *) {
    Task { await startCapture() }
}
RunLoop.main.run()
