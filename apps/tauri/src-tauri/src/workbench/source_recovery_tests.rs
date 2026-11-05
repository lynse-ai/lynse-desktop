use super::*;

fn fixture() -> (PathBuf, Document, Entry, Manifest) {
    let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
    let mut document = Document {
        id: "meeting".into(),
        kind: "meeting".into(),
        title: "Saved meeting".into(),
        transcript: "Original evidence".into(),
        ..Default::default()
    };
    document.refresh_revision();
    let entry = write_document(&root, &document, None).unwrap();
    let mut manifest = Manifest {
        sync_root: root.to_string_lossy().into_owned(),
        ..Default::default()
    };
    manifest.entries.insert(document.id.clone(), entry.clone());
    recover_document_writes(&root, &mut manifest).unwrap();
    (root, document, entry, manifest)
}

fn archived_text(root: &Path, id: &str) -> String {
    let mut contents = String::new();
    let archive = root.join(".source-archive").join(digest(id));
    if !archive.exists() {
        return contents;
    }
    for directory in fs::read_dir(archive).unwrap() {
        for file in fs::read_dir(directory.unwrap().path()).unwrap() {
            contents.push_str(&fs::read_to_string(file.unwrap().path()).unwrap());
        }
    }
    contents
}

#[test]
fn every_interrupted_source_commit_prefix_recovers_the_same_snapshot() {
    for phase in [
        "journal-only",
        "source-only",
        "source-and-markdown",
        "manifest-written",
    ] {
        let (root, mut doc, old, mut manifest) = fixture();
        let (md, source) = paths(&root, &doc.id);
        let old_md = fs::read(&md).unwrap();
        let old_source = fs::read(&source).unwrap();
        doc.transcript = "Updated verified evidence".into();
        doc.refresh_revision();
        let next = write_document(&root, &doc, Some(&old)).unwrap();
        match phase {
            "journal-only" => {
                fs::write(&md, &old_md).unwrap();
                fs::write(&source, &old_source).unwrap();
            }
            "source-only" => fs::write(&md, &old_md).unwrap(),
            "manifest-written" => {
                manifest.entries.insert(doc.id.clone(), next);
            }
            _ => {}
        }
        recover_document_writes(&root, &mut manifest).unwrap();
        let recovered = read_document(&root, &manifest.entries[&doc.id]).unwrap();
        assert_eq!(recovered.revision, doc.revision, "phase {phase}");
        assert_eq!(
            fs::read_to_string(&md).unwrap(),
            doc.markdown(),
            "phase {phase}"
        );
        // A second restart sees the manifest acknowledgement and collects the journal.
        save(&root.join("state.json"), &manifest).unwrap();
        let mut reloaded = load(&root.join("state.json")).unwrap();
        recover_document_writes(&root, &mut reloaded).unwrap();
        assert!(!journal_path(&root, &doc.id).exists());
        assert_eq!(
            read_document(&root, &reloaded.entries[&doc.id])
                .unwrap()
                .revision,
            doc.revision
        );
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn a_damaged_journal_never_replaces_the_last_verified_source_files() {
    let (root, mut document, old, mut manifest) = fixture();
    let (md, source) = paths(&root, &document.id);
    let before_md = fs::read(&md).unwrap();
    let before_source = fs::read(&source).unwrap();
    document.transcript = "Prepared replacement".into();
    document.refresh_revision();
    write_document(&root, &document, Some(&old)).unwrap();
    let journal = journal_path(&root, &document.id);
    let mut write: SourceWrite = serde_json::from_slice(&fs::read(&journal).unwrap()).unwrap();
    write.markdown = "Tampered journal Markdown".into();
    fs::write(&journal, serde_json::to_vec(&write).unwrap()).unwrap();
    fs::write(&md, &before_md).unwrap();
    fs::write(&source, &before_source).unwrap();
    assert!(recover_document_writes(&root, &mut manifest).is_err());
    assert_eq!(fs::read(&md).unwrap(), before_md);
    assert_eq!(fs::read(&source).unwrap(), before_source);
    assert!(journal.exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn recovery_preserves_external_edits_and_keeps_both_conflict_choices_available() {
    let (root, mut doc, old, mut manifest) = fixture();
    doc.transcript = "Incoming source evidence".into();
    doc.refresh_revision();
    write_document(&root, &doc, Some(&old)).unwrap();
    let (md, _) = paths(&root, &doc.id);
    fs::write(&md, "User-authored recovery canary").unwrap();

    recover_document_writes(&root, &mut manifest).unwrap();
    let conflict = &manifest.entries[&doc.id];
    assert_eq!(conflict.status, "conflict");
    assert_eq!(
        fs::read_to_string(&md).unwrap(),
        "User-authored recovery canary"
    );
    assert_eq!(
        ensure_incoming(&root, conflict).unwrap().revision,
        doc.revision
    );
    let resolved = resolve_document_conflict(&root, conflict, true).unwrap();
    assert_eq!(
        read_document(&root, &resolved).unwrap().transcript,
        "User-authored recovery canary"
    );
    assert_eq!(
        fs::read_to_string(&md).unwrap(),
        "User-authored recovery canary"
    );
    assert!(archived_text(&root, &doc.id).contains("User-authored recovery canary"));
    assert_eq!(resolved.accepted_revision, doc.revision);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn legacy_conflict_without_incoming_can_be_resolved_offline_without_losing_edits() {
    for keep_local in [true, false] {
        let (root, doc, mut entry, _) = fixture();
        entry.status = "conflict".into();
        let (md, source) = paths(&root, &doc.id);
        fs::write(&md, "Legacy manual edit canary").unwrap();
        assert!(!source.with_extension("incoming.json").exists());
        let resolved = resolve_document_conflict(&root, &entry, keep_local).unwrap();
        assert_eq!(resolved.status, "synced");
        assert_eq!(
            read_document(&root, &resolved).unwrap().transcript,
            if keep_local {
                "Legacy manual edit canary"
            } else {
                "Original evidence"
            }
        );
        assert!(archived_text(&root, &doc.id).contains("Legacy manual edit canary"));
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn an_unregistered_markdown_file_is_preserved_as_a_conflict() {
    let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&root).unwrap();
    let mut document = Document {
        id: "orphan".into(),
        kind: "meeting".into(),
        transcript: "Downloaded evidence".into(),
        ..Default::default()
    };
    document.refresh_revision();
    fs::write(paths(&root, &document.id).0, "Unregistered manual document").unwrap();
    let entry = write_document(&root, &document, None).unwrap();
    assert_eq!(entry.status, "conflict");
    assert_eq!(
        fs::read_to_string(paths(&root, &document.id).0).unwrap(),
        "Unregistered manual document"
    );
    assert_eq!(
        ensure_incoming(&root, &entry).unwrap().revision,
        document.revision
    );
    let resolved = resolve_document_conflict(&root, &entry, true).unwrap();
    assert_eq!(
        read_document(&root, &resolved).unwrap().transcript,
        "Unregistered manual document"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn durable_tombstones_block_pending_recovery_and_archive_edited_files() {
    let (root, mut doc, old, mut manifest) = fixture();
    doc.transcript = "A late download must not resurrect this source".into();
    doc.refresh_revision();
    write_document(&root, &doc, Some(&old)).unwrap();
    fs::write(paths(&root, &doc.id).0, "User edit preserved on deletion").unwrap();
    manifest
        .source_tombstones
        .insert(doc.id.clone(), "removed:durable".into());
    save(&root.join("state.json"), &manifest).unwrap();
    let mut reloaded = load(&root.join("state.json")).unwrap();
    recover_document_writes(&root, &mut reloaded).unwrap();
    assert!(!reloaded.entries.contains_key(&doc.id));
    assert!(!paths(&root, &doc.id).0.exists());
    assert!(!paths(&root, &doc.id).1.exists());
    assert!(!journal_path(&root, &doc.id).exists());
    assert!(archived_text(&root, &doc.id).contains("User edit preserved on deletion"));
    recover_document_writes(&root, &mut reloaded).unwrap();
    assert!(!reloaded.entries.contains_key(&doc.id));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn private_withdrawal_purges_journals_and_archives_instead_of_preserving_plaintext() {
    let (root, doc, entry, mut manifest) = fixture();
    fs::write(paths(&root, &doc.id).0, "Private plaintext canary").unwrap();
    remove_document(&root, &doc.id, Some(&entry)).unwrap();
    assert!(archived_text(&root, &doc.id).contains("Private plaintext canary"));
    write_document(&root, &doc, None).unwrap();
    manifest
        .source_tombstones
        .insert(doc.id.clone(), "private:durable".into());
    recover_document_writes(&root, &mut manifest).unwrap();
    assert!(!manifest.entries.contains_key(&doc.id));
    assert!(!paths(&root, &doc.id).0.exists());
    assert!(!paths(&root, &doc.id).1.exists());
    assert!(!journal_path(&root, &doc.id).exists());
    assert!(archived_text(&root, &doc.id).is_empty());
    fs::remove_dir_all(root).unwrap();
}
