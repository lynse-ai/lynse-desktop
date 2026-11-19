fn main() {
    tauri_build::build();

    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    configure_private_recording_card(std::path::Path::new(&manifest_dir));

    // The `aec3` feature statically links the shared WebRTC AEC3 library
    // (lynse_webrtc_aec, built by scripts/build-lynse-aec3.ps1) behind the
    // audio_contract C ABI. Without the feature the pure-Rust correlation
    // gate is compiled in and nothing external is linked.
    #[cfg(feature = "aec3")]
    {
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

fn configure_private_recording_card(manifest_dir: &std::path::Path) {
    let source = manifest_dir.join("src/recording_card_private/mod.rs");
    println!("cargo:rustc-check-cfg=cfg(private_recording_card)");
    println!("cargo:rerun-if-env-changed=LYNSE_REQUIRE_PRIVATE_RECORDING_CARD");
    println!("cargo:rerun-if-changed={}", source.display());
    if !source.is_file() {
        assert_ne!(
            std::env::var("LYNSE_REQUIRE_PRIVATE_RECORDING_CARD").as_deref(),
            Ok("1"),
            "private recording card sources are required for this build"
        );
        return;
    }

    let target = std::env::var("TARGET").expect("TARGET");
    let verifier = std::path::Path::new(&manifest_dir)
        .join("recording-card-ownership")
        .join(target.as_str());
    let archive = if target.ends_with("-msvc") {
        "recording_card_owner.lib"
    } else {
        "librecording_card_owner.a"
    };
    let archive_path = verifier.join(archive);
    assert!(
        archive_path.is_file(),
        "recording card ownership verifier is missing for {target}: {}",
        archive_path.display()
    );
    println!("cargo:rustc-link-search=native={}", verifier.display());
    println!("cargo:rustc-link-lib=static=recording_card_owner");
    println!("cargo:rerun-if-changed={}", archive_path.display());
    println!("cargo:rustc-cfg=private_recording_card");
}
