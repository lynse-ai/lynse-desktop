fn main() {
    tauri_build::build();

    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let manifest_path = std::path::Path::new(&manifest_dir);
    emit_build_metadata(manifest_path);
    configure_private_recording_card(manifest_path);

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

fn emit_build_metadata(manifest_dir: &std::path::Path) {
    for key in [
        "LYNSE_BUILD_NUMBER",
        "BUILD_NUMBER",
        "GITHUB_RUN_NUMBER",
        "LYNSE_GIT_SHA",
        "GITHUB_SHA",
    ] {
        println!("cargo:rerun-if-env-changed={key}");
    }

    // Re-run automatically whenever HEAD moves (new commit, checkout, rebase)
    // without forcing rebuilds when editing unrelated files.
    watch_git_path(manifest_dir, "HEAD");
    if let Some(ref_name) = git_output(manifest_dir, &["symbolic-ref", "-q", "HEAD"]) {
        watch_git_path(manifest_dir, &ref_name);
    }
    watch_git_path(manifest_dir, "packed-refs");

    let build_number = first_non_empty_env(&["LYNSE_BUILD_NUMBER", "BUILD_NUMBER", "GITHUB_RUN_NUMBER"])
        .or_else(|| git_output(manifest_dir, &["rev-list", "--count", "HEAD"]))
        .unwrap_or_default();

    let git_sha = first_non_empty_env(&["LYNSE_GIT_SHA", "GITHUB_SHA"])
        .map(|sha| sha.chars().take(7).collect::<String>())
        .or_else(|| git_output(manifest_dir, &["rev-parse", "--short=7", "HEAD"]))
        .unwrap_or_default();

    println!("cargo:rustc-env=LYNSE_BUILD_NUMBER={build_number}");
    println!("cargo:rustc-env=LYNSE_GIT_SHA={git_sha}");
}

fn first_non_empty_env(keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        std::env::var(key)
            .ok()
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
    })
}

fn git_output(dir: &std::path::Path, args: &[&str]) -> Option<String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

fn watch_git_path(dir: &std::path::Path, git_rel: &str) {
    let Some(rel) = git_output(dir, &["rev-parse", "--git-path", git_rel]) else {
        return;
    };
    let path = std::path::Path::new(&rel);
    let resolved = if path.is_absolute() {
        path.to_path_buf()
    } else {
        dir.join(path)
    };
    // Only register existing files — Cargo treats missing rerun-if-changed paths as always dirty.
    if resolved.is_file() {
        println!("cargo:rerun-if-changed={}", resolved.display());
    }
}
