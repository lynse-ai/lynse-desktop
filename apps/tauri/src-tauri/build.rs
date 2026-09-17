fn main() {
    tauri_build::build();

    // The `aec3` feature statically links the shared WebRTC AEC3 library
    // (lynse_webrtc_aec, built by scripts/build-lynse-aec3.ps1) behind the
    // audio_contract C ABI. Without the feature the pure-Rust correlation
    // gate is compiled in and nothing external is linked.
    #[cfg(feature = "aec3")]
    {
        let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
        let lib_dir = std::path::Path::new(&manifest_dir).join("aec3").join("lib");
        assert!(
            lib_dir.join("lynse_webrtc_aec.lib").exists(),
            "aec3 feature requires aec3/lib/lynse_webrtc_aec.lib — run scripts/build-lynse-aec3.ps1 first"
        );
        println!("cargo:rustc-link-search=native={}", lib_dir.display());
        println!("cargo:rustc-link-lib=static=lynse_webrtc_aec");
        // Advancing the WebRTC version changes echo behaviour: rebuild when
        // the vendored library changes.
        println!("cargo:rerun-if-changed={}", lib_dir.display());
    }
}
