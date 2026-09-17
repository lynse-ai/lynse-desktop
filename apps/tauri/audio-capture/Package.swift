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
        .target(name: "AudioCaptureCore", dependencies: ["CAecBridge"]),
        // Header-only bridge to the AEC3 engine. The symbols themselves are
        // linked from vendor/build/lib/liblynse_dsp.a; scripts/build-audio-capture.sh
        // and scripts/test-audio-capture.sh append the matching -Xlinker flags,
        // so this target stays buildable without the C++ toolchain.
        .target(
            name: "CAecBridge",
            path: "Sources/CAecBridge",
            publicHeadersPath: "include"
        ),
        .executableTarget(
            name: "audio-capture-core-tests",
            dependencies: ["AudioCaptureCore"],
            path: "SelfTests"
        ),
    ],
    swiftLanguageModes: [.v5]
)
