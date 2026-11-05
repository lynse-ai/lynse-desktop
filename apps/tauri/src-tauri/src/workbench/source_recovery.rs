//! Recoverable source commits and preservation of user-authored vault files.
use super::*;

#[derive(Clone, Deserialize, Serialize)]
struct SourceWrite {
    document: Document,
    entry: Entry,
    markdown: String,
    base_revision: Option<String>,
    base_markdown_hash: Option<String>,
}

fn journal_path(root: &Path, id: &str) -> PathBuf {
    root.join(format!("{}.write.json", digest(id)))
}

fn read_optional(path: &Path) -> CommandResult<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn validate_document(document: &Document, id: &str) -> CommandResult<()> {
    let mut check = document.clone();
    check.refresh_revision();
    if document.id != id || document.revision != check.revision {
        return Err("Source recovery identity or revision is invalid; files were preserved".into());
    }
    Ok(())
}

fn validate_write(write: &SourceWrite) -> CommandResult<()> {
    validate_document(&write.document, &write.entry.id)?;
    if write.document.revision != write.entry.revision
        || (write.entry.status != "conflict"
            && digest(&write.markdown) != write.entry.markdown_hash)
    {
        return Err("Source journal snapshot is inconsistent; files were preserved".into());
    }
    Ok(())
}

fn stage_incoming(root: &Path, document: &Document, markdown: &str) -> CommandResult<()> {
    let (md, source) = paths(root, &document.id);
    crate::atomic_write(
        &source.with_extension("incoming.json"),
        &serde_json::to_vec_pretty(document).map_err(|e| e.to_string())?,
    )?;
    crate::atomic_write(&md.with_extension("incoming.md"), markdown.as_bytes())
}

fn apply_write(root: &Path, write: &SourceWrite) -> CommandResult<Entry> {
    validate_write(write)?;
    let (md, source) = paths(root, &write.entry.id);
    let mut entry = write.entry.clone();
    if entry.status == "conflict" {
        stage_incoming(root, &write.document, &write.markdown)?;
        if !source.exists() {
            crate::atomic_write(
                &source,
                &serde_json::to_vec_pretty(&write.document).map_err(|e| e.to_string())?,
            )?;
        }
        return Ok(entry);
    }
    let current = read_optional(&md)?;
    let current_hash = current.as_deref().map(digest);
    if current_hash.is_some()
        && current_hash != write.base_markdown_hash
        && current_hash.as_deref() != Some(entry.markdown_hash.as_str())
    {
        // An external edit made after preparing the journal is authoritative.
        stage_incoming(root, &write.document, &write.markdown)?;
        entry.status = "conflict".into();
        entry.error = "Local document changed during source recovery; review its conflict".into();
        entry.markdown_hash = write.base_markdown_hash.clone().unwrap_or_default();
        return Ok(entry);
    }
    if let Some(bytes) = read_optional(&source)? {
        let valid_base = serde_json::from_slice::<Document>(&bytes)
            .ok()
            .is_some_and(|current| {
                validate_document(&current, &entry.id).is_ok()
                    && (current.revision == write.document.revision
                        || write.base_revision.as_ref() == Some(&current.revision))
            });
        if !valid_base {
            archive_files(
                root,
                &entry.id,
                std::slice::from_ref(&source),
                "structured-source-recovered",
            )?;
        }
    }
    crate::atomic_write(
        &source,
        &serde_json::to_vec_pretty(&write.document).map_err(|e| e.to_string())?,
    )?;
    crate::atomic_write(&md, write.markdown.as_bytes())?;
    Ok(entry)
}

pub(super) fn write_record(
    root: &Path,
    document: &Document,
    entry: &Entry,
    markdown: &str,
    old_markdown: Option<&[u8]>,
    previous: Option<&Entry>,
) -> CommandResult<Entry> {
    let write = SourceWrite {
        document: document.clone(),
        entry: entry.clone(),
        markdown: markdown.into(),
        base_revision: previous.map(|entry| entry.revision.clone()),
        base_markdown_hash: old_markdown.map(digest),
    };
    validate_write(&write)?;
    // Retain the journal until a subsequent recovery pass observes a durable
    // manifest and matching files. A crash before manifest persistence is safe.
    crate::atomic_write(
        &journal_path(root, &document.id),
        &serde_json::to_vec_pretty(&write).map_err(|e| e.to_string())?,
    )?;
    apply_write(root, &write)
}

pub(in crate::workbench) fn recover_document_writes(
    root: &Path,
    manifest: &mut Manifest,
) -> CommandResult<usize> {
    if !root.exists() {
        return Ok(0);
    }
    let mut recovered = 0;
    for (id, reason) in manifest.source_tombstones.clone() {
        if reason.starts_with("private:") {
            purge_private_document(root, &id)?;
        } else {
            remove_document(root, &id, manifest.entries.get(&id))?;
        }
        manifest.entries.remove(&id);
    }
    for file in fs::read_dir(root).map_err(|e| e.to_string())? {
        let path = file.map_err(|e| e.to_string())?.path();
        if !path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(".write.json"))
        {
            continue;
        }
        let write: SourceWrite =
            serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
                .map_err(|_| "Source journal is unreadable; files were preserved")?;
        if path != journal_path(root, &write.document.id) || write.entry.id != write.document.id {
            return Err("Source journal identity is invalid; files were preserved".into());
        }
        validate_write(&write)?;
        if manifest.source_tombstones.contains_key(&write.entry.id) {
            continue;
        }
        if let Some(current) = manifest.entries.get(&write.entry.id) {
            let same = current.revision == write.entry.revision
                && current.markdown_hash == write.entry.markdown_hash
                && current.status == write.entry.status;
            let committed = if current.status == "conflict" {
                same && ensure_incoming(root, current).is_ok()
            } else {
                read_document(root, current).is_ok()
            };
            if committed && (same || write.base_revision.as_ref() != Some(&current.revision)) {
                fs::remove_file(&path).map_err(|e| e.to_string())?;
                continue;
            }
        }
        let mut entry = apply_write(root, &write)?;
        if let Some(current) = manifest.entries.get(&entry.id) {
            entry.excluded |= current.excluded;
            entry.remote_revision = current.remote_revision.clone();
        }
        entry.excluded |= manifest.excluded_sources.contains(&entry.id);
        manifest.entries.insert(entry.id.clone(), entry);
        recovered += 1;
    }
    Ok(recovered)
}

pub(in crate::workbench) fn ensure_incoming(root: &Path, entry: &Entry) -> CommandResult<Document> {
    let (md, source) = paths(root, &entry.id);
    let incoming = source.with_extension("incoming.json");
    let bytes = match read_optional(&incoming)? {
        Some(bytes) => bytes,
        None => read_optional(&source)?
            .ok_or("No recoverable source snapshot is available; resync the source first")?,
    };
    let document: Document = serde_json::from_slice(&bytes)
        .map_err(|_| "Source snapshot is unreadable; files were preserved")?;
    validate_document(&document, &entry.id)?;
    if !incoming.exists() {
        crate::atomic_write(&incoming, &bytes)?;
    }
    if !md.with_extension("incoming.md").exists() {
        crate::atomic_write(
            &md.with_extension("incoming.md"),
            document.markdown().as_bytes(),
        )?;
    }
    Ok(document)
}

fn archive_files(root: &Path, id: &str, files: &[PathBuf], reason: &str) -> CommandResult<()> {
    let archive = root
        .join(".source-archive")
        .join(digest(id))
        .join(uuid::Uuid::new_v4().to_string());
    let mut any = false;
    for path in files {
        if let Some(bytes) = read_optional(path)? {
            crate::atomic_write(
                &archive.join(path.file_name().ok_or("Invalid source archive path")?),
                &bytes,
            )?;
            any = true;
        }
    }
    if any {
        crate::atomic_write(
            &archive.join("archive.json"),
            &serde_json::to_vec_pretty(
                &json!({"sourceId":id,"reason":reason,"createdAt":crate::now()}),
            )
            .map_err(|e| e.to_string())?,
        )?;
    }
    Ok(())
}

pub(in crate::workbench) fn remove_document(
    root: &Path,
    id: &str,
    entry: Option<&Entry>,
) -> CommandResult<()> {
    let (md, source) = paths(root, id);
    let files = [
        md.clone(),
        source,
        md.with_extension("incoming.md"),
        paths(root, id).1.with_extension("incoming.json"),
        md.with_extension("local-backup.md"),
    ];
    let edited = read_optional(&md)?.is_some_and(|bytes| {
        entry.is_none_or(|entry| {
            digest(&bytes) != entry.markdown_hash
                || entry.status == "conflict"
                || !entry.accepted_revision.is_empty()
        })
    });
    if edited || md.with_extension("local-backup.md").exists() {
        archive_files(root, id, &files, "source-withdrawn")?;
    }
    for path in files
        .into_iter()
        .chain(std::iter::once(journal_path(root, id)))
    {
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

pub(in crate::workbench) fn purge_private_document(root: &Path, id: &str) -> CommandResult<()> {
    let (md, source) = paths(root, id);
    for path in [
        md.clone(),
        source.clone(),
        md.with_extension("incoming.md"),
        source.with_extension("incoming.json"),
        md.with_extension("local-backup.md"),
        journal_path(root, id),
    ] {
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    match fs::remove_dir_all(root.join(".source-archive").join(digest(id))) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

pub(in crate::workbench) fn resolve_document_conflict(
    root: &Path,
    entry: &Entry,
    keep_local: bool,
) -> CommandResult<Entry> {
    let mut document = ensure_incoming(root, entry)?;
    let (md, source) = paths(root, &entry.id);
    let local = fs::read(&md).map_err(|e| e.to_string())?;
    archive_files(
        root,
        &entry.id,
        &[
            md.clone(),
            source.clone(),
            md.with_extension("incoming.md"),
            source.with_extension("incoming.json"),
        ],
        "conflict-resolved",
    )?;
    let accepted_revision = document.revision.clone();
    let markdown = if keep_local {
        let text = String::from_utf8(local.clone()).map_err(|_| "Local document must be UTF-8")?;
        document.transcript = text.clone();
        document.segments.clear();
        document.outline.clear();
        document.conclusions.clear();
        document.refresh_revision();
        text
    } else {
        document.markdown()
    };
    let mut next = Entry {
        revision: document.revision.clone(),
        markdown_hash: digest(&markdown),
        status: "synced".into(),
        accepted_revision: if keep_local {
            accepted_revision
        } else {
            String::new()
        },
        error: String::new(),
        synthesis_revision: String::new(),
        failed_synthesis_revision: String::new(),
        ..entry.clone()
    };
    next.title = document.title.clone();
    write_record(root, &document, &next, &markdown, Some(&local), Some(entry))
}

#[cfg(test)]
#[path = "source_recovery_tests.rs"]
mod tests;
