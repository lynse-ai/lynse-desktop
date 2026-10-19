//! Relocation of user content between the legacy app-data layout and the
//! unified vault content root (see [`crate::vault::ContentKind`]). Runs when
//! the vault folder is enabled, disabled or changed — and once per launch so
//! installs that enabled the vault before this shipped get folded in too.
//!
//! Every move is merge-based and idempotent: children of the source directory
//! relocate one by one (rename, with a copy fallback for cross-volume vault
//! folders), so a pass interrupted by an error leaves the remaining sources
//! intact and a retried pass completes the job. `sourcePath` references in
//! the local-transcriptions index are rewritten in the same pass; inspiration
//! records store relative file names only, so they follow the root without
//! rewrites. Cloud-imported audio outside these directories is never touched.

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use crate::vault::{self, ContentKind, VaultConfig};
use crate::{local_store_path, read_array, write_array, CommandResult};

const CONTENT_KINDS: &[ContentKind] = &[
    ContentKind::Recordings,
    ContentKind::EditExports,
    ContentKind::Inspirations,
    ContentKind::KnowledgeMeetings,
    ContentKind::KnowledgeMemory,
];

/// Directory children excluded when relocating a kind: `staging` is
/// disposable scratch (wiped on every launch).
fn relocate_skip(kind: ContentKind) -> &'static [&'static str] {
    match kind {
        ContentKind::Inspirations => &["staging"],
        ContentKind::Recordings | ContentKind::EditExports | ContentKind::KnowledgeMeetings | ContentKind::KnowledgeMemory => &[],
    }
}

/// Whether skipped children should be deleted instead of left behind (the
/// inspiration staging area holds nothing durable).
fn delete_skipped(kind: ContentKind) -> bool {
    matches!(kind, ContentKind::Inspirations)
}

fn label(kind: ContentKind) -> &'static str {
    match kind {
        ContentKind::Inspirations => "inspirations",
        ContentKind::Recordings => "recordings",
        ContentKind::EditExports => "audio-editor exports",
        ContentKind::KnowledgeMeetings => "knowledge-base meetings",
        ContentKind::KnowledgeMemory => "knowledge-base memory",
    }
}

fn join_segments(base: &Path, segments: &[&str]) -> PathBuf {
    segments.iter().fold(base.to_path_buf(), |path, segment| path.join(segment))
}

fn content_dirs(kind:ContentKind,old_base:&Path,new_base:&Path,from:&VaultConfig,to:&VaultConfig)->CommandResult<(PathBuf,PathBuf)> {
    if matches!(kind,ContentKind::KnowledgeMeetings|ContentKind::KnowledgeMemory) {
        // Meeting text and derived memory stay in the chosen knowledge base,
        // including when its switch is off. Only explicit folder changes move them.
        let old=vault::vault_root(from).map(|root|join_segments(&root,kind.segments(true))).unwrap_or_else(|_|join_segments(old_base,kind.segments(false)));
        let new=vault::vault_root(to).map(|root|join_segments(&root,kind.segments(true))).unwrap_or_else(|_|old.clone());
        return Ok((old,new));
    }
    Ok((join_segments(old_base,kind.segments(from.enabled)),join_segments(new_base,kind.segments(to.enabled))))
}

/// Move every child of `from` into `to` (created on demand), merging with any
/// existing content so a partially completed previous pass resumes cleanly.
/// Returns whether anything was moved.
fn move_dir_contents(
    from: &Path,
    to: &Path,
    skip: &[&str],
    delete_skipped: bool,
) -> CommandResult<bool> {
    let entries = match fs::read_dir(from) {
        Ok(entries) => entries,
        // No content for this kind at the source — nothing to do.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };
    fs::create_dir_all(to).map_err(|error| error.to_string())?;
    let mut moved = false;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if skip.iter().any(|skipped| skipped == &name) {
            if delete_skipped {
                let path = entry.path();
                if path.is_dir() {
                    let _ = fs::remove_dir_all(&path);
                } else {
                    let _ = fs::remove_file(&path);
                }
            }
            continue;
        }
        let destination = to.join(&name);
        // Same-volume renames are atomic and cheap; the copy fallback covers
        // a vault folder on another volume.
        if fs::rename(entry.path(), &destination).is_err() {
            let source = entry.path();
            if source.is_dir() {
                fs::create_dir_all(&destination).map_err(|error| error.to_string())?;
                copy_dir_all(&source, &destination)?;
                fs::remove_dir_all(&source).map_err(|error| error.to_string())?;
            } else {
                fs::copy(&source, &destination).map_err(|error| error.to_string())?;
                fs::remove_file(&source).map_err(|error| error.to_string())?;
            }
        }
        moved = true;
    }
    Ok(moved)
}

/// Recursive copy used by the cross-volume fallback of `move_dir_contents`.
fn copy_dir_all(from: &Path, to: &Path) -> CommandResult<()> {
    for entry in fs::read_dir(from)
        .map_err(|error| error.to_string())?
        .flatten()
    {
        let destination = to.join(entry.file_name());
        if entry.file_type().map_err(|error| error.to_string())?.is_dir() {
            fs::create_dir_all(&destination).map_err(|error| error.to_string())?;
            copy_dir_all(&entry.path(), &destination)?;
        } else {
            fs::copy(entry.path(), &destination).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

/// Remove `dir` when it is now empty, then its direct parent — but never the
/// content base itself (the app data root or the vault folder).
fn prune_emptied(dir: &Path, base: &Path) {
    if fs::remove_dir(dir).is_ok() {
        if let Some(parent) = dir.parent() {
            if parent != base {
                let _ = fs::remove_dir(parent);
            }
        }
    }
}

/// Rewrite `sourcePath` values in the local-transcriptions index that point
/// into one of the relocated directories. Returns how many paths changed.
fn rewrite_transcription_sources(
    index_path: &Path,
    moves: &[(PathBuf, PathBuf)],
) -> CommandResult<usize> {
    let records = read_array(index_path)?;
    let mut rewritten = 0usize;
    let records: Vec<Value> = records
        .into_iter()
        .map(|mut record| {
            let Some(source) = record
                .get("sourcePath")
                .and_then(Value::as_str)
                .map(str::to_owned)
            else {
                return record;
            };
            let path = PathBuf::from(&source);
            // `starts_with` compares whole components, so a sibling directory
            // sharing a prefix (`inspirations-other`) never matches.
            if let Some((from, to)) = moves.iter().find(|(from, _)| path.starts_with(from)) {
                let suffix = path.strip_prefix(from).unwrap_or(&path);
                let updated = to.join(suffix).to_string_lossy().into_owned();
                if updated != source {
                    if let Some(object) = record.as_object_mut() {
                        object.insert("sourcePath".into(), json!(updated));
                    }
                    rewritten += 1;
                }
            }
            record
        })
        .collect();
    if rewritten > 0 {
        write_array(index_path, &records)?;
    }
    Ok(rewritten)
}

/// Move all content kinds from the old configuration's base to the new one,
/// rewriting index references afterwards. Refuses while a live recording is
/// still writing into the old location. Per-kind failures are collected so
/// one bad directory cannot block the rest; the surfaced error lets the user
/// retry and the merge-based moves complete whatever is left.
pub(crate) fn relocate_user_content(
    app: &AppHandle,
    from: &VaultConfig,
    to: &VaultConfig,
) -> CommandResult<()> {
    let old_base = vault::content_base(app, from)?;
    let new_base = vault::content_base(app, to)?;
    if old_base == new_base && from.path==to.path {
        return Ok(());
    }
    if app
        .state::<crate::live_translation::LiveTranslationManager>()
        .has_active_session()
    {
        return Err("现场录音进行中，请先结束录音再更改存储位置".to_owned());
    }
    let index_path = local_store_path(app, "local-transcriptions")?;
    let mut pairs: Vec<(PathBuf, PathBuf)> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    for kind in CONTENT_KINDS {
        let (from_dir,to_dir)=content_dirs(*kind,&old_base,&new_base,from,to)?;
        if from_dir == to_dir {
            continue;
        }
        match move_dir_contents(&from_dir, &to_dir, relocate_skip(*kind), delete_skipped(*kind)) {
            Ok(moved) => {
                if moved {
                    pairs.push((from_dir.clone(), to_dir));
                }
                prune_emptied(&from_dir, &old_base);
            }
            Err(error) => errors.push(format!("{}: {error}", label(*kind))),
        }
    }
    if !errors.is_empty() {
        return Err(errors.join("；"));
    }
    if !pairs.is_empty() {
        rewrite_transcription_sources(&index_path, &pairs)?;
    }
    Ok(())
}

/// Launch-time hook: content follows the vault folder for installs that
/// enabled it before this feature shipped. No live session can exist yet.
pub(crate) fn migrate_on_launch(app: &AppHandle) -> CommandResult<()> {
    let config = vault::load_vault_config(app)?;
    if !config.enabled {
        return Ok(());
    }
    relocate_user_content(app, &VaultConfig::default(), &config)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_tmp() -> PathBuf {
        std::env::temp_dir().join(format!("lynse-content-mig-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn move_dir_contents_merges_and_deletes_skipped_staging() {
        let root = unique_tmp();
        let from = root.join("data").join("inspirations");
        let to = root.join("vault").join("Inspirations");
        fs::create_dir_all(from.join("abc")).unwrap();
        fs::write(from.join("abc").join("audio.wav"), b"x").unwrap();
        fs::create_dir_all(from.join("staging")).unwrap();
        fs::write(from.join("staging").join("paste-1.png"), b"y").unwrap();
        // Pre-existing target content must survive — moves merge, never clobber.
        fs::create_dir_all(to.join("def")).unwrap();
        fs::write(to.join("def").join("audio.wav"), b"z").unwrap();

        assert!(move_dir_contents(&from, &to, &["staging"], true).unwrap());
        assert!(to.join("abc").join("audio.wav").exists());
        assert!(to.join("def").join("audio.wav").exists());
        assert!(!from.join("abc").exists());
        assert!(!from.join("staging").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn move_dir_contents_on_missing_source_is_noop() {
        let root = unique_tmp();
        assert!(!move_dir_contents(&root.join("gone"), &root.join("to"), &[], false).unwrap());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rewrite_touches_only_owned_prefixes() {
        let root = unique_tmp();
        fs::create_dir_all(&root).unwrap();
        let index = root.join("index.json");
        let legacy_recovery = root.join("data").join("live-translations").join("recovery");
        let legacy_edits = root.join("data").join("audio-edits");
        let imported = "/Users/someone/Music/interview.m4a";
        let sibling = root.join("data").join("inspirations-other").join("a.wav");
        write_array(
            &index,
            &[
                json!({ "id": "local:live:1", "sourcePath": legacy_recovery.join("s").join("20260101_000000.wav").to_string_lossy() }),
                json!({ "id": "local:1", "sourcePath": legacy_edits.join("clip-x.m4a").to_string_lossy() }),
                // A user-imported file outside our directories stays put.
                json!({ "id": "local:2", "sourcePath": imported }),
                // A sibling directory sharing a name prefix must not match.
                json!({ "id": "local:3", "sourcePath": sibling.to_string_lossy() }),
            ],
        )
        .unwrap();
        let vault_recordings = root.join("vault").join("Recordings");
        let vault_transcriptions = root.join("vault").join("Transcriptions");

        let moved = rewrite_transcription_sources(
            &index,
            &[
                (legacy_recovery.clone(), vault_recordings.clone()),
                (legacy_edits.clone(), vault_transcriptions.clone()),
            ],
        )
        .unwrap();

        assert_eq!(moved, 2);
        let records = read_array(&index).unwrap();
        assert_eq!(
            records[0].get("sourcePath").and_then(Value::as_str),
            Some(
                vault_recordings
                    .join("s")
                    .join("20260101_000000.wav")
                    .to_string_lossy()
                    .as_ref()
            )
        );
        assert_eq!(
            records[1].get("sourcePath").and_then(Value::as_str),
            Some(vault_transcriptions.join("clip-x.m4a").to_string_lossy().as_ref())
        );
        assert_eq!(records[2].get("sourcePath").and_then(Value::as_str), Some(imported));
        assert_eq!(
            records[3].get("sourcePath").and_then(Value::as_str),
            Some(sibling.to_string_lossy().as_ref())
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn prune_emptied_removes_dir_and_wrapper_but_never_the_base() {
        let root = unique_tmp();
        let base = root.join("data");
        let recovery = base.join("live-translations").join("recovery");
        fs::create_dir_all(&recovery).unwrap();
        prune_emptied(&recovery, &base);
        assert!(!recovery.exists());
        assert!(!recovery.parent().unwrap().exists());
        assert!(base.exists());

        // A non-empty directory is left alone.
        let busy = base.join("live-translations").join("recovery");
        fs::create_dir_all(&busy).unwrap();
        fs::write(busy.join("left.wav"), b"x").unwrap();
        prune_emptied(&busy, &base);
        assert!(busy.exists());
        fs::remove_dir_all(&root).unwrap();
    }
    #[test]
    fn switching_off_the_vault_keeps_knowledge_text_in_its_selected_folder() {
        let from=VaultConfig{enabled:true,path:Some("/chosen-vault".into())};let to=VaultConfig{enabled:false,..from.clone()};
        for kind in [ContentKind::KnowledgeMeetings,ContentKind::KnowledgeMemory]{let(old,new)=content_dirs(kind,Path::new("/chosen-vault"),Path::new("/app-data"),&from,&to).unwrap();assert_eq!(old,new);assert!(new.starts_with("/chosen-vault"));let moved=VaultConfig{path:Some("/new-vault".into()),..to.clone()};let(_,destination)=content_dirs(kind,Path::new("/app-data"),Path::new("/app-data"),&to,&moved).unwrap();assert!(destination.starts_with("/new-vault"));}
    }

}
