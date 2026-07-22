import AppKit
import AudioCaptureCore
import AudioToolbox
import AVFoundation
import CoreGraphics
import CoreMedia
import Darwin
import Foundation
import ScreenCaptureKit

private let targetSampleRate = 16_000.0
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
    _ = CGRequestScreenCaptureAccess()
    var result = permissionStatus()
    result["restartRequired"] = true
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

guard #available(macOS 15.0, *) else {
    emitError("实时双流转写需要 macOS 15 或更高版本。")
    exit(2)
}
guard let socketPath = argumentValue("--socket"), !socketPath.isEmpty,
      let outputPath = argumentValue("--out"), !outputPath.isEmpty else {
    emitError("missing --socket or --out")
    exit(2)
}

NSApplication.shared.setActivationPolicy(.prohibited)

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

private final class WavWriter {
    private let handle: FileHandle
    private var sampleCount: UInt64 = 0
    private var wroteFirstSample = false
    private var closed = false
    private let lock = NSLock()

    init(path: String) throws {
        FileManager.default.createFile(atPath: path, contents: Data(repeating: 0, count: 44))
        handle = try FileHandle(forWritingTo: URL(fileURLWithPath: path))
        try handle.seek(toOffset: 44)
    }

    func write(_ samples: [Int16], firstSampleElapsedMs: UInt64) {
        lock.withLock {
            guard !closed else { return }
            let intendedSample = firstSampleElapsedMs.saturatingMultiply(16)
            if !wroteFirstSample { wroteFirstSample = true }
            if intendedSample > sampleCount {
                let padding = Int(min(intendedSample - sampleCount, UInt64(Int.max)))
                let silence = [Int16](repeating: 0, count: padding)
                try? handle.write(contentsOf: silence.withUnsafeBytesData())
                sampleCount += UInt64(padding)
            }
            try? handle.write(contentsOf: samples.withUnsafeBytesData())
            sampleCount += UInt64(samples.count)
        }
    }

    func close() {
        lock.withLock {
            guard !closed else { return }
            closed = true
            let dataBytes = UInt32(min(sampleCount * 2, UInt64(UInt32.max)))
            var header = Data()
            header.append(Data("RIFF".utf8))
            appendLittleEndian(UInt32(36) + dataBytes, to: &header)
            header.append(Data("WAVEfmt ".utf8))
            appendLittleEndian(UInt32(16), to: &header)
            appendLittleEndian(UInt16(1), to: &header)
            appendLittleEndian(UInt16(1), to: &header)
            appendLittleEndian(UInt32(16_000), to: &header)
            appendLittleEndian(UInt32(32_000), to: &header)
            appendLittleEndian(UInt16(2), to: &header)
            appendLittleEndian(UInt16(16), to: &header)
            header.append(Data("data".utf8))
            appendLittleEndian(dataBytes, to: &header)
            try? handle.seek(toOffset: 0)
            try? handle.write(contentsOf: header)
            try? handle.synchronize()
            try? handle.close()
        }
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

private final class FrameSink {
    private let source: UInt8
    private let socket: LocalSocketWriter
    private let wav: WavWriter
    private var assembler = PCMFrameAssembler()
    private let queue: DispatchQueue

    init(source: UInt8, name: String, socket: LocalSocketWriter, wav: WavWriter) {
        self.source = source
        self.socket = socket
        self.wav = wav
        queue = DispatchQueue(label: "app.lynse.capture.\(name)")
    }

    func consume(_ floats: [Float], callbackElapsedMs: UInt64) {
        queue.async {
            let durationMs = UInt64((Double(floats.count) / targetSampleRate * 1_000).rounded())
            let chunkStartMs = callbackElapsedMs > durationMs ? callbackElapsedMs - durationMs : 0
            let samples = floats.map { value -> Int16 in
                let scaled = Int((max(-1, min(1, value)) * 32_767).rounded())
                return Int16(max(-32_768, min(32_767, scaled)))
            }
            self.wav.write(samples, firstSampleElapsedMs: chunkStartMs)
            self.send(self.assembler.append(samples: samples, chunkStartMs: chunkStartMs))
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

private final class AudioConverterState {
    var formatDescription: String = ""
    var converter: AVAudioConverter?
}

@available(macOS 15.0, *)
private final class CaptureOutput: NSObject, SCStreamOutput {
    let source: UInt8
    let sink: FrameSink
    let clock: ActiveClock
    let levels: LevelState
    private let converterState = AudioConverterState()

    init(source: UInt8, sink: FrameSink, clock: ActiveClock, levels: LevelState) {
        self.source = source
        self.sink = sink
        self.clock = clock
        self.levels = levels
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard sampleBuffer.isValid,
              let description = sampleBuffer.formatDescription,
              let basic = CMAudioFormatDescriptionGetStreamBasicDescription(description)?.pointee else { return }

        var streamDescription = basic
        let inputFormat = AVAudioFormat(streamDescription: &streamDescription)
        guard let inputFormat, inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else { return }
        let signature = "\(inputFormat.sampleRate)-\(inputFormat.channelCount)-\(inputFormat.commonFormat.rawValue)-\(inputFormat.isInterleaved)"
        if converterState.converter == nil || converterState.formatDescription != signature {
            guard let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: targetSampleRate, channels: 1, interleaved: false) else { return }
            converterState.converter = AVAudioConverter(from: inputFormat, to: target)
            converterState.formatDescription = signature
        }
        guard let converter = converterState.converter else { return }
        let target = converter.outputFormat

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
        guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
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
        guard conversion != .error, output.frameLength > 0, let channels = output.floatChannelData else { return }
        let samples = Array(UnsafeBufferPointer(start: channels[0], count: Int(output.frameLength)))
        levels.record(source: Int(source), samples: samples)
        sink.consume(samples, callbackElapsedMs: clock.elapsedMs())
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
private let micWav = try WavWriter(path: outputDirectory.appendingPathComponent("mic.wav").path)
private let systemWav = try WavWriter(path: outputDirectory.appendingPathComponent("system.wav").path)
private let micSink = FrameSink(source: 0, name: "mic", socket: socketWriter, wav: micWav)
private let systemSink = FrameSink(source: 1, name: "system", socket: socketWriter, wav: systemWav)
private let micOutput = CaptureOutput(source: 0, sink: micSink, clock: clock, levels: levels)
private let systemOutput = CaptureOutput(source: 1, sink: systemSink, clock: clock, levels: levels)
private let videoOutput = NoopVideoOutput()
private let captureDelegate = CaptureDelegate()

private var captureStream: SCStream?
private var paused = false
private var shuttingDown = false
private var restartingCapture = false
private var lastMicrophoneDeviceID = AVCaptureDevice.default(for: .audio)?.uniqueID

@available(macOS 15.0, *)
func createCaptureStream() async throws -> SCStream {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let display = content.displays.first else { throw NSError(domain: "LynseCapture", code: 1, userInfo: [NSLocalizedDescriptionKey: "No display is available for audio capture."]) }
    let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
    let configuration = SCStreamConfiguration()
    configuration.capturesAudio = true
    configuration.excludesCurrentProcessAudio = true
    configuration.sampleRate = 48_000
    configuration.channelCount = 2
    configuration.captureMicrophone = microphonePermission() == "granted"
    configuration.microphoneCaptureDeviceID = AVCaptureDevice.default(for: .audio)?.uniqueID
    configuration.width = 2
    configuration.height = 2
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
    configuration.queueDepth = 3

    let stream = SCStream(filter: filter, configuration: configuration, delegate: captureDelegate)
    try stream.addStreamOutput(systemOutput, type: .audio, sampleHandlerQueue: DispatchQueue(label: "app.lynse.capture.system"))
    if configuration.captureMicrophone {
        try stream.addStreamOutput(micOutput, type: .microphone, sampleHandlerQueue: DispatchQueue(label: "app.lynse.capture.mic"))
    }
    try stream.addStreamOutput(videoOutput, type: .screen, sampleHandlerQueue: DispatchQueue(label: "app.lynse.capture.video"))
    return stream
}

@available(macOS 15.0, *)
func startCapture(event: String = "ready") async {
    guard !shuttingDown else { return }
    do {
        let stream = try await createCaptureStream()
        try await stream.startCapture()
        captureStream = stream
        emit(["event": event, "microphone": microphonePermission() == "granted", "systemAudio": CGPreflightScreenCaptureAccess()])
    } catch {
        emitError("capture start failed: \(error.localizedDescription)")
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
    clock.pause()
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
    clock.resume()
    Task {
        await startCapture(event: "resumed")
    }
}

let levelTimer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "app.lynse.capture.levels"))
levelTimer.schedule(deadline: .now() + .milliseconds(200), repeating: .milliseconds(200))
levelTimer.setEventHandler {
    let (mic, system) = levels.take()
    emit(["event": "levels", "mic": mic, "system": system, "elapsedMs": clock.elapsedMs()])
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
    levelTimer.cancel()
    deviceTimer.cancel()
    parentTimer.cancel()
    micSink.close()
    systemSink.close()
    socketWriter.close()
    emit(["event": "stopped", "elapsedMs": clock.elapsedMs()])
    let stream = captureStream
    captureStream = nil
    Task {
        if let stream { try? await stream.stopCapture() }
        exit(0)
    }
}
shutdownHandler = shutdown

let termSignal = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
let intSignal = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
termSignal.setEventHandler(handler: shutdown)
intSignal.setEventHandler(handler: shutdown)
termSignal.resume()
intSignal.resume()

Task { await startCapture() }
RunLoop.main.run()
