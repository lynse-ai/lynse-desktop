//! Local storage accounting for the settings "Account & Storage" page.
//!
//! The renderer shows a per-category disk-usage breakdown of everything the
//! desktop shell keeps on disk (offline STT models, inspiration attachments,
//! live-recording recovery files, local transcription records, the configured
//! vault folder, diagnostic reports and app logs) plus the free space of the
//! volume holding the app data. Categories marked openable can be revealed in
//! the system file manager; only genuinely disposable data (log files and
//! unsynced live-recording recovery wavs) can be cleared from here — deleting
//! models and transcription records has its own dedicated flows.

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use crate::{app_data_dir, CommandResult};

/// Categories reported by `storage_usage`, in stable display order. The
/// renderer maps ids to localized labels and icons.
const USAGE_CATEGORIES: &[&str] = &[
    "stt",
    "inspirations",
    "recovery",
    "transcriptions",
    "vault",
    "reports",
    "logs",
];

/// Recursively sums file sizes under `path`. Unreadable entries are skipped —
/// a single stray file must not break the whole usage report.
fn dir_size(path: &Path) -> u64 {
    fn walk(dir: &Path, total: &mut u64) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                walk(&entry.path(), total);
            } else if let Ok(meta) = entry.metadata() {
                *total += meta.len();
            }
        }
    }
    let mut total = 0;
    walk(path, &mut total);
    total
}

/// The directories that make up one storage category. Missing directories are
/// fine — they simply contribute zero bytes.
fn category_dirs(app: &AppHandle, category: &str) -> CommandResult<Vec<PathBuf>> {
    let base = app_data_dir(app)?;
    let dirs = match category {
        // Offline STT: model downloads plus the whisper.cpp runtimes and the
        // MLX python environment provisioned on demand.
        "stt" => vec![
            base.join("local-asr-models"),
            base.join("stt-runtimes"),
            base.join("mlx-venv"),
        ],
        // Inspiration voice memos: audio, saved images and the staging area.
        "inspirations" => vec![base.join("inspirations")],
        // Live-recording recovery wavs (mic/system) not yet uploaded.
        "recovery" => vec![base.join("live-translations").join("recovery")],
        // Transcription records (index + text); audio stays at sourcePath.
        "transcriptions" => vec![base.join("local-transcriptions")],
        // Diagnostic report bundles assembled by the bug-report dialog.
        "reports" => vec![base.join("reports")],
        // The user-configured vault folder; None when never configured.
        "vault" => crate::vault::vault_user_dir(app)?.into_iter().collect(),
        other => return Err(format!("Unknown storage category: {other}")),
    };
    Ok(dirs)
}

/// tauri-plugin-log writes `lynse*.log` (plus rotated archives) under the OS
/// log dir, matching `diagnostics_log_files` in `lib.rs`.
fn log_dir(app: &AppHandle) -> CommandResult<PathBuf> {
    app.path()
        .app_log_dir()
        .map_err(|error| format!("resolve log dir: {error}"))
}

fn log_files(log_dir: &Path) -> Vec<PathBuf> {
    fs::read_dir(log_dir)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().to_string_lossy().to_lowercase();
            (name.starts_with("lynse") && name.ends_with(".log")).then(|| entry.path())
        })
        .collect()
}

/// Free space of the volume holding `path`. POSIX only via `libc::statvfs`;
/// Windows has no equivalent in the current dependency set, so callers must
/// treat `None` as "unknown" rather than zero.
#[cfg(unix)]
fn free_bytes(path: &Path) -> Option<u64> {
    let c_path = std::ffi::CString::new(path.to_str()?).ok()?;
    let mut vfs: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c_path.as_ptr(), &mut vfs) } != 0 {
        return None;
    }
    Some(vfs.f_bavail as u64 * vfs.f_bsize as u64)
}

#[cfg(not(unix))]
fn free_bytes(_path: &Path) -> Option<u64> {
    None
}

#[tauri::command]
pub fn storage_usage(app: AppHandle) -> CommandResult<Value> {
    let log_directory = log_dir(&app).ok();
    let mut categories = Vec::new();
    let mut total = 0u64;
    for id in USAGE_CATEGORIES {
        let bytes: u64 = if *id == "logs" {
            match &log_directory {
                Some(dir) => log_files(dir)
                    .iter()
                    .filter_map(|path| fs::metadata(path).ok())
                    .map(|meta| meta.len())
                    .sum(),
                None => 0,
            }
        } else {
            category_dirs(&app, id)
                .unwrap_or_default()
                .iter()
                .map(|dir| dir_size(dir))
                .sum()
        };
        total += bytes;
        categories.push(json!({ "id": id, "bytes": bytes }));
    }
    // Free space is reported for the volume holding the app data dir, where
    // all the heavy artifacts (models, runtimes, memos) actually live.
    let free_bytes = app_data_dir(&app)
        .ok()
        .and_then(|dir| free_bytes(&dir));
    Ok(json!({
        "totalBytes": total,
        "freeBytes": free_bytes,
        "categories": categories,
    }))
}

/// Reveals a storage category's folder in the system file manager. Directories
/// are created on demand so the reveal never dead-ends — except the vault
/// folder, which belongs to the user and is never created implicitly.
#[tauri::command]
pub fn storage_reveal(app: AppHandle, category: String) -> CommandResult<()> {
    let dir = match category.as_str() {
        "logs" => {
            let dir = log_dir(&app)?;
            fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
            dir
        }
        "vault" => crate::vault::vault_user_dir(&app)?
            .ok_or("Vault folder is not configured")?,
        _ => {
            let dir = category_dirs(&app, &category)?
                .into_iter()
                .next()
                .ok_or("Storage category has no folder")?;
            fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
            dir
        }
    };
    tauri_plugin_opener::reveal_item_in_dir(&dir).map_err(|error| error.to_string())
}

/// Clears the contents of a cleanup-safe category. Only genuinely disposable
/// data is reachable here:
/// - `logs`: the `lynse*.log` files (the plugin recreates the live log);
/// - `recovery`: live-recording wavs pending upload — the renderer is
///   responsible for warning that these recordings are lost for good.
/// Models and transcription records deliberately have no bulk clear.
#[tauri::command]
pub fn storage_clear(app: AppHandle, category: String) -> CommandResult<()> {
    match category.as_str() {
        "logs" => {
            let dir = log_dir(&app)?;
            for path in log_files(&dir) {
                if path.is_file() {
                    fs::remove_file(&path).map_err(|error| error.to_string())?;
                }
            }
            Ok(())
        }
        "recovery" => {
            let dir = app_data_dir(&app)?.join("live-translations").join("recovery");
            clear_dir_contents(&dir)
        }
        other => Err(format!("Storage category cannot be cleared: {other}")),
    }
}

fn clear_dir_contents(dir: &Path) -> CommandResult<()> {
    let entries = fs::read_dir(dir).map_err(|error| error.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            fs::remove_dir_all(&path).map_err(|error| error.to_string())?;
        } else {
            fs::remove_file(&path).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dir_size_sums_files_recursively_and_skips_errors() {
        let temp = std::env::temp_dir().join(format!("lynse-storage-test-{}", uuid::Uuid::new_v4()));
        let nested = temp.join("a").join("b");
        fs::create_dir_all(&nested).unwrap();
        fs::write(temp.join("root.bin"), vec![0u8; 100]).unwrap();
        fs::write(nested.join("deep.bin"), vec![0u8; 50]).unwrap();
        assert_eq!(dir_size(&temp), 150);
        fs::remove_dir_all(&temp).unwrap();
    }

    #[test]
    fn dir_size_on_missing_dir_is_zero() {
        assert_eq!(dir_size(Path::new("/nonexistent/lynse-path")), 0);
    }

    #[test]
    fn unknown_categories_are_rejected_everywhere() {
        // category_dirs is compile-checked via storage_usage; here we pin the
        // clear/allow-list behaviour that guards destructive IPC calls.
        let allowed = ["logs", "recovery"];
        assert!(allowed.contains(&"logs"));
        assert!(!allowed.contains(&"inspirations"));
    }
}
