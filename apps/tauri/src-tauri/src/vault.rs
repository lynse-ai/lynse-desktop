//! Local markdown vault: a one-way mirror of note content (outline +
//! summaries) into a user-chosen folder as plain `.md` files, so the library
//! stays readable in Obsidian or any editor even when Lynse is closed.
//!
//! The renderer assembles the full markdown (frontmatter included); this
//! module owns the folder, safe file names, an `index.json` mapping note ids
//! to file names, and atomic writes. The vault is a mirror — nothing here
//! reads user edits back into the cloud.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

use crate::{app_data_dir, local_store_path, now, read_array, write_array, CommandResult};

const VAULT_DIR: &str = "local-vault";
const SYNC_PROGRESS_EVENT: &str = "vault-sync-progress";
/// Longest allowed base file name (chars, not bytes) before any id suffix.
pub(crate) const MAX_FILE_NAME_CHARS: usize = 80;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultConfig {
    pub enabled: bool,
    #[serde(default)]
    pub path: Option<String>,
}

impl Default for VaultConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            path: None,
        }
    }
}

/// One note payload as assembled by the renderer (frontmatter included).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultNote {
    pub file_id: String,
    pub title: String,
    pub markdown: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultBatchSummary {
    pub written: usize,
    pub failed: usize,
    pub errors: Vec<String>,
}

fn vault_dir(app: &AppHandle) -> CommandResult<PathBuf> {
    let path = app_data_dir(app)?.join(VAULT_DIR);
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

fn vault_config_path(app: &AppHandle) -> CommandResult<PathBuf> {
    Ok(vault_dir(app)?.join("config.json"))
}

pub fn load_vault_config(app: &AppHandle) -> CommandResult<VaultConfig> {
    let path = vault_config_path(app)?;
    match fs::read_to_string(&path) {
        Ok(content) => Ok(serde_json::from_str(&content).unwrap_or_default()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(VaultConfig::default()),
        Err(error) => Err(error.to_string()),
    }
}

/// The user-facing vault folder. `~` is expanded so a hand-edited config still
/// resolves.
fn vault_root(config: &VaultConfig) -> CommandResult<PathBuf> {
    let raw = config
        .path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("Vault folder is not configured")?;
    let expanded = match raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        Some(rest) => {
            let home = std::env::var("HOME")
                .ok()
                .or_else(|| std::env::var("USERPROFILE").ok())
                .ok_or("Cannot resolve the home directory")?;
            PathBuf::from(home).join(rest)
        }
        None => PathBuf::from(raw),
    };
    Ok(expanded)
}

/// Turn a note title into a cross-platform-safe file base name. Forbidden
/// characters are dropped (not replaced) so CJK titles keep their exact text;
/// the id suffix added on collision keeps names unique.
pub(crate) fn sanitize_file_base_name(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .filter(|c| !c.is_control())
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let truncated: String = collapsed.chars().take(MAX_FILE_NAME_CHARS).collect();
    let trimmed = truncated.trim().trim_end_matches('.').trim().to_string();
    if trimmed.is_empty() {
        "untitled".to_string()
    } else {
        trimmed
    }
}

/// In-memory view of `local-vault/index.json` (`{ id, fileName, title,
/// syncedAt, hash }` rows), loaded once per write batch so a full sync is
/// O(n) instead of reloading the index for every note.
struct VaultIndex {
    entries: Vec<Value>,
    positions: HashMap<String, usize>,
}

impl VaultIndex {
    fn load(app: &AppHandle) -> CommandResult<Self> {
        let entries = read_array(&local_store_path(app, VAULT_DIR)?)?;
        let positions = entries
            .iter()
            .enumerate()
            .filter_map(|(index, entry)| {
                entry
                    .get("id")
                    .and_then(Value::as_str)
                    .map(|id| (id.to_owned(), index))
            })
            .collect();
        Ok(Self { entries, positions })
    }

    fn file_name_for(&self, file_id: &str) -> Option<&str> {
        self.positions
            .get(file_id)
            .and_then(|index| self.entries[*index].get("fileName"))
            .and_then(Value::as_str)
    }

    fn name_taken_by_other(&self, file_id: &str, file_name: &str) -> bool {
        self.entries.iter().any(|entry| {
            entry.get("id").and_then(Value::as_str) != Some(file_id)
                && entry.get("fileName").and_then(Value::as_str) == Some(file_name)
        })
    }

    fn upsert(&mut self, file_id: &str, file_name: &str, title: &str, hash: &str) {
        let entry = json!({
            "id": file_id,
            "fileName": file_name,
            "title": title,
            "syncedAt": now(),
            "hash": hash,
        });
        if let Some(position) = self.positions.get(file_id).copied() {
            self.entries[position] = entry;
        } else {
            self.positions.insert(file_id.to_owned(), self.entries.len());
            self.entries.push(entry);
        }
    }
}

/// Resolve the target file name for `note` (collision-safe) and drop the stale
/// file left behind when the title changed, so the vault holds exactly one
/// file per note.
fn resolve_file_name(root: &Path, note: &VaultNote, index: &VaultIndex) -> String {
    let base = sanitize_file_base_name(&note.title);
    let mut file_name = format!("{}.md", base);
    if index.name_taken_by_other(&note.file_id, &file_name) {
        let suffix: String = note
            .file_id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .take(6)
            .collect();
        file_name = format!("{}-{}.md", base, suffix);
    }
    if let Some(previous) = index.file_name_for(&note.file_id) {
        if previous != file_name {
            let _ = fs::remove_file(root.join(previous));
        }
    }
    file_name
}

fn write_note_with_index(root: &Path, note: &VaultNote, index: &mut VaultIndex) -> CommandResult<()> {
    let file_name = resolve_file_name(root, note, index);
    let target = root.join(&file_name);
    let temporary = target.with_extension("md.tmp");
    fs::write(&temporary, &note.markdown).map_err(|error| error.to_string())?;
    fs::rename(&temporary, &target).map_err(|error| error.to_string())?;
    let hash = format!("{:x}", Sha256::digest(note.markdown.as_bytes()));
    index.upsert(&note.file_id, &file_name, &note.title, &hash);
    Ok(())
}

fn write_note_impl(app: &AppHandle, note: &VaultNote) -> CommandResult<()> {
    let config = load_vault_config(app)?;
    if !config.enabled {
        return Err("Local vault is disabled".into());
    }
    let root = vault_root(&config)?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let mut index = VaultIndex::load(app)?;
    write_note_with_index(&root, note, &mut index)?;
    write_array(&local_store_path(app, VAULT_DIR)?, &index.entries)?;
    Ok(())
}

fn write_notes_impl(app: &AppHandle, notes: &[VaultNote]) -> CommandResult<VaultBatchSummary> {
    let config = load_vault_config(app)?;
    if !config.enabled {
        return Err("Local vault is disabled".into());
    }
    let root = vault_root(&config)?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let mut index = VaultIndex::load(app)?;
    let total = notes.len();
    let mut written = 0;
    let mut failed = 0;
    let mut errors = Vec::new();
    for (done, note) in notes.iter().enumerate() {
        match write_note_with_index(&root, note, &mut index) {
            Ok(()) => written += 1,
            Err(error) => {
                failed += 1;
                errors.push(format!("{}: {}", note.title, error));
            }
        }
        let _ = app.emit(
            SYNC_PROGRESS_EVENT,
            json!({ "done": done + 1, "total": total, "title": note.title }),
        );
    }
    write_array(&local_store_path(app, VAULT_DIR)?, &index.entries)?;
    Ok(VaultBatchSummary {
        written,
        failed,
        errors,
    })
}

#[tauri::command]
pub fn vault_config_get(app: AppHandle) -> CommandResult<VaultConfig> {
    load_vault_config(&app)
}

#[tauri::command]
pub fn vault_config_save(app: AppHandle, config: VaultConfig) -> CommandResult<VaultConfig> {
    if config.enabled {
        // Create/validate the folder up front so a bad path fails at save
        // time instead of on the first sync.
        let root = vault_root(&config)?;
        fs::create_dir_all(root).map_err(|error| error.to_string())?;
    }
    let path = vault_config_path(&app)?;
    let content = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
    fs::write(&path, content).map_err(|error| error.to_string())?;
    Ok(config)
}

/// Suggested vault folder for the first-time enable flow.
#[tauri::command]
pub fn vault_default_path(app: AppHandle) -> CommandResult<String> {
    let documents = app.path().document_dir().map_err(|error| error.to_string())?;
    Ok(documents.join("Lynse知识库").to_string_lossy().into_owned())
}

#[tauri::command]
pub fn vault_write_note(app: AppHandle, note: VaultNote) -> CommandResult<()> {
    write_note_impl(&app, &note)
}

#[tauri::command(async)]
pub fn vault_write_notes(
    app: AppHandle,
    notes: Vec<VaultNote>,
) -> CommandResult<VaultBatchSummary> {
    write_notes_impl(&app, &notes)
}

/// Read a note's markdown back from the vault (offline fallback rendering).
#[tauri::command]
pub fn vault_read_note(app: AppHandle, file_id: String) -> CommandResult<Option<String>> {
    let config = load_vault_config(&app)?;
    if !config.enabled {
        return Ok(None);
    }
    let Ok(root) = vault_root(&config) else {
        return Ok(None);
    };
    let index = VaultIndex::load(&app)?;
    let Some(file_name) = index.file_name_for(&file_id) else {
        return Ok(None);
    };
    match fs::read_to_string(root.join(file_name)) {
        Ok(content) => Ok(Some(content)),
        Err(_) => Ok(None),
    }
}

/// Mirror a cloud-side deletion. No-op while the vault is disabled so the
/// user's folder is never touched behind their back.
#[tauri::command]
pub fn vault_remove_note(app: AppHandle, file_id: String) -> CommandResult<()> {
    let config = load_vault_config(&app)?;
    if !config.enabled {
        return Ok(());
    }
    let mut index = VaultIndex::load(&app)?;
    if let Some(file_name) = index.file_name_for(&file_id).map(str::to_owned) {
        if let Ok(root) = vault_root(&config) {
            let _ = fs::remove_file(root.join(&file_name));
        }
        index
            .entries
            .retain(|entry| entry.get("id").and_then(Value::as_str) != Some(file_id.as_str()));
        index.positions.remove(file_id.as_str());
        write_array(&local_store_path(&app, VAULT_DIR)?, &index.entries)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_keeps_cjk_and_drops_forbidden_chars() {
        assert_eq!(sanitize_file_base_name("产品评审会"), "产品评审会");
        assert_eq!(sanitize_file_base_name("a/b\\c:d*e?f\"g<h>i|j"), "abcdefghij");
        assert_eq!(sanitize_file_base_name("  spaced   out  "), "spaced out");
        assert_eq!(sanitize_file_base_name("..."), "untitled");
        assert_eq!(sanitize_file_base_name(""), "untitled");
        assert_eq!(sanitize_file_base_name("trail."), "trail");
    }

    #[test]
    fn sanitize_truncates_long_titles() {
        let long = "长".repeat(200);
        assert_eq!(sanitize_file_base_name(&long).chars().count(), MAX_FILE_NAME_CHARS);
    }
}
