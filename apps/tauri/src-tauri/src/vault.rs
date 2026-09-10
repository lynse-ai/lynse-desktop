//! Local markdown vault: a one-way mirror of note content (outline +
//! summaries) into a user-chosen folder as plain `.md` files, so the library
//! stays readable in Obsidian or any editor even when Lynse is closed.
//!
//! Journal entries (闪记/记录) and local todos follow the same storage rules —
//! one markdown file per entry with YAML frontmatter, attachments as real
//! files under `attachments/`, and `Journal/` / `Tasks/` folders — so every
//! capture lives in plain Obsidian-compatible markdown. Those mirrors write
//! automatically on every save/delete: into the user's vault folder when the
//! vault is enabled, otherwise into an app-internal `vault/` folder, so the
//! Obsidian-style copy always exists. The JSON stores stay the app's query
//! index; the markdown files are the durable, user-editable form.
//!
//! The renderer assembles the note markdown (frontmatter included); this
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

/// JSON store holding the journal/task entry index (separate from the note
/// index so the two mirrors never fight over file names).
const ENTRIES_INDEX_DIR: &str = "local-vault-entries";
/// Vault subfolders for the automatic journal/task mirrors.
const VAULT_JOURNAL_FOLDER: &str = "Journal";
const VAULT_TASKS_FOLDER: &str = "Tasks";
const VAULT_ATTACHMENTS_FOLDER: &str = "attachments";

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

/// In-memory view of the vault index (`{ id, fileName, title, syncedAt, hash,
/// root }` rows), loaded once per write batch so a full sync is O(n) instead
/// of reloading the index for every note.
struct VaultIndex {
    entries: Vec<Value>,
    positions: HashMap<String, usize>,
}

impl VaultIndex {
    fn load(app: &AppHandle) -> CommandResult<Self> {
        Self::load_from(app, VAULT_DIR)
    }

    fn load_from(app: &AppHandle, directory: &str) -> CommandResult<Self> {
        let entries = read_array(&local_store_path(app, directory)?)?;
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

    fn save_to(&self, app: &AppHandle, directory: &str) -> CommandResult<()> {
        write_array(&local_store_path(app, directory)?, &self.entries)
    }

    fn file_name_for(&self, file_id: &str) -> Option<&str> {
        self.positions
            .get(file_id)
            .and_then(|index| self.entries[*index].get("fileName"))
            .and_then(Value::as_str)
    }

    fn stored_hash_for(&self, file_id: &str) -> Option<&str> {
        self.positions
            .get(file_id)
            .and_then(|index| self.entries[*index].get("hash"))
            .and_then(Value::as_str)
    }

    /// Root folder the entry was last written to — used by the journal/task
    /// mirrors to force a rewrite after the user moves or enables the vault.
    fn stored_root_for(&self, file_id: &str) -> Option<&str> {
        self.positions
            .get(file_id)
            .and_then(|index| self.entries[*index].get("root"))
            .and_then(Value::as_str)
    }

    fn name_taken_by_other(&self, file_id: &str, file_name: &str) -> bool {
        self.entries.iter().any(|entry| {
            entry.get("id").and_then(Value::as_str) != Some(file_id)
                && entry.get("fileName").and_then(Value::as_str) == Some(file_name)
        })
    }

    fn upsert(&mut self, file_id: &str, file_name: &str, title: &str, hash: &str, root: &str) {
        let entry = json!({
            "id": file_id,
            "fileName": file_name,
            "title": title,
            "syncedAt": now(),
            "hash": hash,
            "root": root,
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
    index.upsert(&note.file_id, &file_name, &note.title, &hash, &root.to_string_lossy());
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

// ── Journal & task mirrors (Obsidian storage rules) ────────────────────

/// One mirrorable entry — a journal memo or a local todo — with its
/// attachment files. `markdown` is the complete file body (frontmatter
/// included); attachments are copied into `<root>/attachments/` before the
/// markdown's wikilinks can point at them.
pub(crate) struct VaultEntry {
    pub file_id: String,
    pub folder: &'static str,
    pub title: String,
    pub markdown: String,
    /// `(source file, vault-relative target path)` pairs.
    pub attachments: Vec<(PathBuf, String)>,
}

/// YAML double-quoted scalar (JSON escaping is a valid YAML subset).
fn yaml_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_owned())
}

/// Where the automatic mirrors write: the user's vault folder when enabled
/// (and configured), otherwise an app-internal folder — so the markdown copy
/// always exists without touching user-chosen folders behind their back.
fn entries_root(app: &AppHandle, config: &VaultConfig) -> CommandResult<PathBuf> {
    if config.enabled {
        if let Ok(root) = vault_root(config) {
            fs::create_dir_all(&root).map_err(|error| error.to_string())?;
            return Ok(root);
        }
    }
    let path = app_data_dir(app)?.join("vault");
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

/// Frontmatter shared by journals and tasks: id / type / created / updated /
/// source plus the given tag list; `extra` lines (e.g. completed/due) are
/// inserted between `updated` and `source`.
fn entry_markdown(
    id: &str,
    entry_type: &str,
    created: &str,
    updated: &str,
    extra: &[String],
    tags: &[String],
    body: &str,
) -> String {
    let mut markdown = String::from("---\nid: ");
    markdown.push_str(&yaml_string(id));
    markdown.push_str("\ntype: ");
    markdown.push_str(entry_type);
    markdown.push('\n');
    if !created.is_empty() {
        markdown.push_str(&format!("created: {}\n", yaml_string(created)));
    }
    if !updated.is_empty() {
        markdown.push_str(&format!("updated: {}\n", yaml_string(updated)));
    }
    for line in extra {
        markdown.push_str(line);
        markdown.push('\n');
    }
    markdown.push_str("source: lynse\ntags:\n");
    for tag in tags {
        markdown.push_str(&format!("  - {}\n", yaml_string(tag)));
    }
    markdown.push_str("---\n\n");
    markdown.push_str(body);
    markdown
}

/// Assemble the journal markdown for one inspiration record: YAML
/// frontmatter, the text (with inline `#tags` preserved — they are valid
/// Obsidian tags), image embeds and an audio wikilink, then the transcript
/// behind a divider.
pub(crate) fn build_journal_entry(record: &Value, attachments_root: &Path) -> Option<VaultEntry> {
    let id = record.get("id").and_then(Value::as_str)?.to_owned();
    let text = record
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned();
    let created = record.get("createdAt").and_then(Value::as_str).unwrap_or_default();
    let updated = record.get("updatedAt").and_then(Value::as_str).unwrap_or_default();
    let uuid = id.strip_prefix("inspiration:").unwrap_or(&id).to_owned();

    let mut tags: Vec<String> = record
        .get("tags")
        .and_then(Value::as_array)
        .map(|array| {
            array
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    if !tags.iter().any(|tag| tag == "lynse") {
        tags.insert(0, "lynse".to_owned());
    }

    // Title: the first non-empty text line (markdown heading markers
    // stripped); audio-only entries fall back to a dated memo title.
    let first_line = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default();
    let title = if first_line.is_empty() {
        let day = created.get(..10).unwrap_or_default().replace('-', "");
        if day.is_empty() {
            "语音记录".to_owned()
        } else {
            format!("语音记录 {day}")
        }
    } else {
        first_line
            .trim_start_matches('#')
            .trim()
            .chars()
            .take(MAX_FILE_NAME_CHARS)
            .collect()
    };
    if title.is_empty() {
        return None;
    }

    let mut body = format!("# {title}\n\n");
    if !text.is_empty() {
        body.push_str(&text);
        body.push_str("\n\n");
    }
    let mut attachments = Vec::new();
    if let Some(images) = record.get("images").and_then(Value::as_array) {
        for image in images {
            let Some(file) = image.get("file").and_then(Value::as_str) else {
                continue;
            };
            let relative = format!("{VAULT_ATTACHMENTS_FOLDER}/{uuid}/{file}");
            body.push_str(&format!("![[{relative}]]\n"));
            attachments.push((attachments_root.join(&uuid).join(file), relative));
        }
    }
    if let Some(audio_file) = record
        .get("audio")
        .and_then(|audio| audio.get("file"))
        .and_then(Value::as_str)
    {
        let relative = format!("{VAULT_ATTACHMENTS_FOLDER}/{uuid}/{audio_file}");
        body.push_str(&format!("\n- [[{relative}|🔊 录音]]\n"));
        attachments.push((attachments_root.join(&uuid).join(audio_file), relative));
    }
    if let Some(transcript) = record
        .get("transcript")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        body.push_str("\n---\n\n");
        body.push_str(transcript);
        body.push_str("\n");
    }

    Some(VaultEntry {
        file_id: id.clone(),
        folder: VAULT_JOURNAL_FOLDER,
        title,
        markdown: entry_markdown(&id, "journal", created, updated, &[], &tags, &body),
        attachments,
    })
}

/// Assemble the task markdown for one local todo: frontmatter (due/completed)
/// plus an Obsidian-Tasks-style `- [ ]` line (`📅` due date, `🆔` id) so the
/// checkbox state round-trips through the markdown file itself.
pub(crate) fn build_task_entry(record: &Value) -> Option<VaultEntry> {
    let id = record.get("id").and_then(Value::as_str)?.to_owned();
    let title = record
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_owned();
    let created = record.get("createdAt").and_then(Value::as_str).unwrap_or_default();
    let updated = record.get("updatedAt").and_then(Value::as_str).unwrap_or_default();
    let completed = record.get("completed").and_then(Value::as_bool).unwrap_or(false);
    let due = record
        .get("dueDate")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let due_day = due.map(|value| value.get(..10).unwrap_or(value).to_owned());
    let short_id: String = id.chars().filter(char::is_ascii_alphanumeric).take(12).collect();

    let tags = vec!["lynse".to_owned(), "task".to_owned()];
    let mut body = format!("# {title}\n\n");
    body.push_str(&format!("- [{}] {}", if completed { "x" } else { " " }, title));
    if let Some(day) = &due_day {
        if !day.is_empty() {
            body.push_str(&format!(" 📅 {day}"));
        }
    }
    body.push_str(&format!(" 🆔 {short_id}\n"));

    let mut extra = Vec::new();
    extra.push(format!("completed: {}", completed));
    if let Some(day) = &due_day {
        if !day.is_empty() {
            extra.push(format!("due: {day}"));
        }
    }

    Some(VaultEntry {
        file_id: id.clone(),
        folder: VAULT_TASKS_FOLDER,
        title,
        markdown: entry_markdown(&id, "task", created, updated, &extra, &tags, &body),
        attachments: Vec::new(),
    })
}

/// Write (or skip — unchanged entries cost a hash comparison) one mirror
/// entry into `<entries_root>/<folder>/`, copying attachments alongside.
fn write_entry(app: &AppHandle, entry: &VaultEntry) -> CommandResult<()> {
    let config = load_vault_config(app)?;
    let root = entries_root(app, &config)?;
    let folder = root.join(entry.folder);
    fs::create_dir_all(&folder).map_err(|error| error.to_string())?;

    for (source, relative) in &entry.attachments {
        let destination = root.join(relative);
        if destination.exists() || !source.exists() {
            continue;
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        // Copy, never move: the app-data originals still feed local-media
        // playback and transcription.
        if fs::copy(source, &destination).is_err() {
            continue;
        }
    }

    let mut index = VaultIndex::load_from(app, ENTRIES_INDEX_DIR)?;
    let root_label = root.to_string_lossy().into_owned();
    let hash = format!("{:x}", Sha256::digest(entry.markdown.as_bytes()));
    if let Some(file_name) = index.file_name_for(&entry.file_id) {
        let unchanged = index.stored_hash_for(&entry.file_id) == Some(hash.as_str())
            && index.stored_root_for(&entry.file_id) == Some(root_label.as_str())
            && folder.join(file_name).exists();
        if unchanged {
            return Ok(());
        }
    }

    // Collision-safe name, stale previous file removed from this folder only.
    let base = sanitize_file_base_name(&entry.title);
    let mut file_name = format!("{base}.md");
    if index.name_taken_by_other(&entry.file_id, &file_name) {
        let suffix: String = entry
            .file_id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .take(6)
            .collect();
        file_name = format!("{base}-{suffix}.md");
    }
    if let Some(previous) = index.file_name_for(&entry.file_id) {
        if previous != file_name {
            let _ = fs::remove_file(folder.join(previous));
        }
    }
    let target = folder.join(&file_name);
    let temporary = target.with_extension("md.tmp");
    fs::write(&temporary, &entry.markdown).map_err(|error| error.to_string())?;
    fs::rename(&temporary, &target).map_err(|error| error.to_string())?;
    index.upsert(&entry.file_id, &file_name, &entry.title, &hash, &root_label);
    index.save_to(app, ENTRIES_INDEX_DIR)
}

/// Best-effort mirror write — a failed vault write must never disturb the
/// store command that called it.
pub(crate) fn sync_journal(app: &AppHandle, record: &Value) {
    let attachments_root = match app_data_dir(app) {
        Ok(path) => path.join("inspirations"),
        Err(_) => return,
    };
    if let Some(entry) = build_journal_entry(record, &attachments_root) {
        let _ = write_entry(app, &entry);
    }
}

/// Best-effort mirror write for local todos.
pub(crate) fn sync_task(app: &AppHandle, record: &Value) {
    if let Some(entry) = build_task_entry(record) {
        let _ = write_entry(app, &entry);
    }
}

fn remove_entry(app: &AppHandle, id: &str, folder: &str, attachments_subdir: Option<&str>) {
    let Ok(config) = load_vault_config(app) else { return };
    let Ok(root) = entries_root(app, &config) else { return };
    let Ok(mut index) = VaultIndex::load_from(app, ENTRIES_INDEX_DIR) else { return };
    let Some(file_name) = index.file_name_for(id).map(str::to_owned) else { return };
    let _ = fs::remove_file(root.join(folder).join(&file_name));
    if let Some(subdir) = attachments_subdir {
        let _ = fs::remove_dir_all(root.join(VAULT_ATTACHMENTS_FOLDER).join(subdir));
    }
    index
        .entries
        .retain(|entry| entry.get("id").and_then(Value::as_str) != Some(id));
    index.positions.remove(id);
    let _ = index.save_to(app, ENTRIES_INDEX_DIR);
}

/// Remove a journal memo's mirror file (and its copied attachments).
pub(crate) fn remove_journal(app: &AppHandle, id: &str) {
    let uuid = id.strip_prefix("inspiration:").unwrap_or(id);
    remove_entry(app, id, VAULT_JOURNAL_FOLDER, Some(uuid));
}

/// Remove a local todo's mirror file.
pub(crate) fn remove_task(app: &AppHandle, id: &str) {
    remove_entry(app, id, VAULT_TASKS_FOLDER, None);
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

    #[test]
    fn journal_entry_assembles_frontmatter_and_attachments() {
        let record = json!({
            "id": "inspiration:abc-123",
            "text": "会议想法 #work",
            "tags": ["work"],
            "createdAt": "2026-09-09T10:00:00Z",
            "updatedAt": "2026-09-09T10:05:00Z",
            "audio": { "file": "audio.wav", "durationMs": 1200 },
            "images": [{ "file": "img-1.png", "width": 10, "height": 10 }],
            "transcript": " 转写内容 "
        });
        let entry = build_journal_entry(&record, Path::new("/data/inspirations")).unwrap();
        assert_eq!(entry.folder, VAULT_JOURNAL_FOLDER);
        assert_eq!(entry.title, "会议想法 #work");
        assert!(entry.markdown.starts_with("---\nid: \"inspiration:abc-123\"\ntype: journal\n"));
        assert!(entry.markdown.contains("  - \"work\""));
        assert!(entry.markdown.contains("![[attachments/abc-123/img-1.png]]"));
        assert!(entry.markdown.contains("[[attachments/abc-123/audio.wav|🔊 录音]]"));
        assert!(entry.markdown.contains("转写内容"));
        assert_eq!(entry.attachments.len(), 2);
        assert_eq!(
            entry.attachments[0],
            (
                PathBuf::from("/data/inspirations/abc-123/img-1.png"),
                "attachments/abc-123/img-1.png".to_owned()
            )
        );
    }

    #[test]
    fn journal_entry_audio_only_falls_back_to_dated_title() {
        let record = json!({
            "id": "inspiration:def",
            "text": "",
            "createdAt": "2026-09-09T10:00:00Z",
            "updatedAt": "2026-09-09T10:00:00Z",
        });
        let entry = build_journal_entry(&record, Path::new("/data/inspirations")).unwrap();
        assert_eq!(entry.title, "语音记录 20260909");
    }

    #[test]
    fn task_entry_renders_checkbox_and_due() {
        let todo = json!({
            "id": "todo:xyz-1",
            "title": "买菜",
            "completed": false,
            "dueDate": "2026-09-10",
            "createdAt": "2026-09-09T10:00:00Z",
            "updatedAt": "2026-09-09T10:00:00Z"
        });
        let entry = build_task_entry(&todo).unwrap();
        assert_eq!(entry.folder, VAULT_TASKS_FOLDER);
        assert!(entry.markdown.contains("due: 2026-09-10"));
        assert!(entry.markdown.contains("completed: false"));
        assert!(entry.markdown.contains("- [ ] 买菜 📅 2026-09-10 🆔 todoxyz1"));

        let done = build_task_entry(&json!({
            "id": "todo:xyz-1",
            "title": "买菜",
            "completed": true,
            "createdAt": "",
            "updatedAt": ""
        }))
        .unwrap();
        assert!(done.markdown.contains("completed: true"));
        assert!(done.markdown.contains("- [x] 买菜 🆔 todoxyz1"));
    }

    #[test]
    fn task_entry_without_title_is_skipped() {
        let todo = json!({ "id": "todo:xyz-1", "title": "   " });
        assert!(build_task_entry(&todo).is_none());
    }
}
