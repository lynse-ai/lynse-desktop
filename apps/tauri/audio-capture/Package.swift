// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "lynse-audio-capture",
    platforms: [.macOS(.v15)],
    targets: [
        .executableTarget(
            name: "lynse-audio-capture",
            dependencies: ["AudioCaptureCore"],
            path: "Sources/lynse-audio-capture",
            linkerSettings: [
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", "Info.plist",
                ])
            ]
        ),
        .target(name: "AudioCaptureCore"),
        .executableTarget(
            name: "audio-capture-core-tests",
            dependencies: ["AudioCaptureCore"],
            path: "SelfTests"
        ),
    ],
    swiftLanguageModes: [.v5]
)
