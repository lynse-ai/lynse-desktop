//! Reuse account-scoped source files and existing legacy vault notes before downloading text.
use super::*;
use std::path::Path;

pub(super) fn prepare_sync(root: &Path, manifest: &mut Manifest) -> CommandResult<bool> {
    recover_entries(root, manifest)?;
    let has_local = manifest
        .entries
        .values()
        .any(|entry| eligible(entry) && read_document(root, entry).is_ok());
    let background = begin_sync(manifest, root.to_string_lossy().into_owned());
    // Available, account-scoped text can be read while missing records are backfilled.
    if !background
        && has_local
        && !manifest
            .entries
            .values()
            .any(|entry| entry.status == "conflict")
    {
        manifest.initial_complete = true;
        manifest.completed_round = manifest.sync_round.clone();
        manifest.phase = "ready".into();
    }
    Ok(background || manifest.initial_complete)
}

pub(super) fn recover_entries(root: &Path, manifest: &mut Manifest) -> CommandResult<usize> {
    if !root.exists() {
        return Ok(0);
    }
    let mut restored = 0;
    let known: BTreeSet<_> = manifest
        .entries
        .values()
        .filter(|entry| !entry.markdown_hash.is_empty())
        .map(|entry| format!("{}.source.json", store::digest(&entry.id)))
        .collect();
    for file in fs::read_dir(root).map_err(|e| e.to_string())? {
        let path = file.map_err(|e| e.to_string())?.path();
        let Some(name) = path
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| name.ends_with(".source.json"))
        else {
            continue;
        };
        // Only this verified account's source directory is scanned, never other account folders.
        if known.contains(name) {
            continue;
        }
        let doc: Document = serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
            .map_err(|_| "Local knowledge source is unreadable; original preserved")?;
        if name != format!("{}.source.json", store::digest(&doc.id)) {
            return Err("Local source identity does not match its file; original preserved".into());
        }
        let mut check = doc.clone();
        check.refresh_revision();
        if check.revision != doc.revision {
            return Err("Local source revision is invalid; original preserved".into());
        }
        let markdown = store::paths(root, &doc.id).0;
        let bytes = match fs::read(&markdown) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.to_string()),
        };
        let expected = store::digest(doc.markdown());
        let conflict = store::digest(&bytes) != expected;
        let previous = manifest.entries.get(&doc.id).cloned().unwrap_or_default();
        manifest.entries.insert(
            doc.id.clone(),
            store::Entry {
                id: doc.id.clone(),
                kind: doc.kind.clone(),
                title: doc.title.clone(),
                revision: doc.revision.clone(),
                status: if conflict {
                    "conflict"
                } else if doc.kind == "meeting" && !doc.has_meeting_text() {
                    "awaiting_transcription"
                } else {
                    "synced"
                }
                .into(),
                markdown_hash: expected,
                error: if conflict {
                    "Local document was edited; resolve its sync conflict before AI processing"
                        .into()
                } else {
                    String::new()
                },
                excluded: previous.excluded || manifest.excluded_sources.contains(&doc.id),
                ..previous
            },
        );
        restored += 1;
    }
    Ok(restored)
}

pub(super) fn cached_meeting(
    root: &Path,
    manifest: &Manifest,
    id: &str,
) -> CommandResult<Option<Document>> {
    let Some(entry) = manifest.entries.get(id) else {
        return Ok(None);
    };
    let (markdown, source) = store::paths(root, id);
    if entry.status == "conflict" {
        return Err("Local document has an unresolved sync conflict; original preserved".into());
    }
    if !markdown.exists() || !source.exists() {
        return Ok(None);
    }
    let doc = store::read_document(root, entry)?;
    Ok(doc.has_meeting_text().then_some(doc))
}

pub(super) fn legacy_document(row: &Value, markdown: &str) -> Option<Document> {
    let text = markdown.trim_start();
    let rest = text
        .strip_prefix("---\r\n")
        .or_else(|| text.strip_prefix("---\n"))?;
    let (metadata, body) = rest.split_once("\n---")?;
    let field = |key: &str| {
        metadata
            .lines()
            .find_map(|line| line.strip_prefix(&format!("{key}:")))
            .map(|value| {
                serde_json::from_str::<String>(value.trim())
                    .unwrap_or_else(|_| value.trim().to_owned())
            })
            .unwrap_or_default()
    };
    let id = string(row, &["id", "fileId"]);
    if field("id") != id || field("source") != "lynse" {
        return None;
    }
    let body = body.trim_start_matches(['\r', '\n']).trim();
    if body.is_empty() {
        return None;
    }
    let mut doc = Document {
        id,
        kind: "meeting".into(),
        title: field("title"),
        created_at: field("created"),
        updated_at: field("updated"),
        // A legacy note contains summaries, not a verbatim transcript or invented audio positions.
        outline: body.into(),
        ai_context_enabled: true,
        ..Default::default()
    };
    if doc.title.is_empty() {
        doc.title = string(row, &["originalFilename", "title", "name"]);
    }
    doc.refresh_revision();
    Some(doc)
}

pub(super) fn restrict_context(mut doc: Document, row: &Value) -> Document {
    let previous_folder = doc.folder_id.clone();
    if row.get("folderId").is_some() {
        doc.folder_id = string(row, &["folderId"]);
    }
    if previous_folder != doc.folder_id {
        doc.refresh_revision();
    }
    if row
        .get("aiContextEnabled")
        .or_else(|| row.get("ai_context_enabled"))
        .and_then(Value::as_bool)
        == Some(false)
        || matches!(
            string(row, &["sensitivity"]).as_str(),
            "private" | "sensitive" | "restricted"
        )
    {
        if doc.ai_context_enabled {
            doc.ai_context_enabled = false;
            doc.refresh_revision();
        }
    }
    doc
}

pub(super) async fn load_meeting(
    session: &Session,
    row: &Value,
    todos: &[Value],
    cached: Option<Document>,
) -> CommandResult<Document> {
    match cached {
        Some(doc) => Ok(restrict_context(doc, row)),
        None => cloud_document(session, row, todos).await,
    }
}
pub(super) fn needs_automatic_refresh(manifest: &Manifest, cached: &Document, row: &Value, remote_revision: &str) -> bool {
    let current = restrict_context(cached.clone(),row);
    manifest.enabled && manifest.allow_ai && super::super::wiki::in_automatic_scope(&current,manifest)
        && current.ai_context_enabled
        && manifest.entries.get(&cached.id).is_some_and(|entry| !entry.excluded
            && if entry.remote_revision.is_empty() {
                let updated = string(row,&["updatedAt","updateTime"]);
                !updated.is_empty() && !cached.updated_at.is_empty() && updated != cached.updated_at
            } else { entry.remote_revision != remote_revision })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(root: &Path, id: &str) -> (Document, Entry) {
        let mut doc = Document {
            id: id.into(),
            kind: "meeting".into(),
            title: "Local meeting".into(),
            transcript: "Local evidence remains authoritative".into(),
            ai_context_enabled: true,
            ..Default::default()
        };
        doc.refresh_revision();
        let entry = write_document(root, &doc, None).unwrap();
        (doc, entry)
    }

    #[tokio::test]
    async fn cached_text_never_requests_details_even_with_missing_or_changed_remote_timestamps() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let (doc, entry) = fixture(&root, "existing");
        let mut manifest = Manifest::default();
        manifest.entries.insert(doc.id.clone(), entry);
        let original = fs::read(store::paths(&root, &doc.id).0).unwrap();
        for row in [
            json!({"id":"existing"}),
            json!({"id":"existing","updatedAt":"changed","readCount":999}),
        ] {
            let cached = cached_meeting(&root, &manifest, &doc.id).unwrap();
            let (session, server) = super::super::tests::mock_pages(vec![]);
            let loaded = tokio::time::timeout(
                Duration::from_millis(500),
                load_meeting(&session, &row, &[], cached),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(loaded.revision, doc.revision);
            assert_eq!(loaded.transcript, doc.transcript);
            assert!(server.join().unwrap().is_empty());
        }
        assert_eq!(fs::read(store::paths(&root, &doc.id).0).unwrap(), original);
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn missing_notes_fetch_all_three_details() {
        let responses = vec![json!({"code":200,"data":{"content":"Downloaded meeting text"}}); 3];
        let (session, server) = super::super::tests::mock_pages(responses);
        let loaded = load_meeting(
            &session,
            &json!({"id":"new","title":"New meeting"}),
            &[],
            None,
        )
        .await
        .unwrap();
        assert_eq!(loaded.transcript, "Downloaded meeting text");
        let paths = server.join().unwrap();
        assert_eq!(paths.len(), 3);
        for path in ["/trans/get", "/outline/get", "/conclusion/list"] {
            assert!(paths.iter().any(|value| value.contains(path)));
        }
    }

    #[test]
    fn index_recovery_is_account_scoped_and_keeps_source_files_unchanged() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let a = root.join("account-a");
        let b = root.join("account-b");
        let (doc, _) = fixture(&a, "mine");
        fixture(&b, "other-account");
        let original = fs::read(store::paths(&a, &doc.id).0).unwrap();
        let mut manifest = Manifest::default();
        manifest.excluded_sources.push("mine".into());
        assert_eq!(recover_entries(&a, &mut manifest).unwrap(), 1);
        assert_eq!(manifest.entries.len(), 1);
        assert!(!manifest.entries.contains_key("other-account"));
        assert!(manifest.entries["mine"].excluded);
        assert_eq!(
            cached_meeting(&a, &manifest, "mine")
                .unwrap()
                .unwrap()
                .transcript,
            doc.transcript
        );
        assert_eq!(recover_entries(&a, &mut manifest).unwrap(), 0);
        assert_eq!(fs::read(store::paths(&a, "mine").0).unwrap(), original);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn local_files_restore_a_ready_checkpoint_before_the_network_or_pending_backfill() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fixture(&root, "existing");
        let mut manifest = Manifest {
            enabled: true,
            allow_ai: true,
            ..Default::default()
        };
        manifest.entries.insert(
            "missing".into(),
            Entry {
                id: "missing".into(),
                status: "pending".into(),
                ..Default::default()
            },
        );
        assert!(prepare_sync(&root, &mut manifest).unwrap());
        assert!(manifest.bootstrap_valid(&root.to_string_lossy()));
        assert_eq!(manifest.phase, "ready");
        assert!(super::super::wiki::ready(&manifest).is_ok());
        assert!(prepare_sync(&root, &mut manifest).unwrap());
        fs::remove_dir_all(root).unwrap();
        let empty = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        assert!(!prepare_sync(&empty, &mut Manifest::default()).unwrap());
    }

    #[test]
    fn manual_edits_and_corrupt_sources_remain_local_conflicts_without_overwriting() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let (doc, entry) = fixture(&root, "edited");
        fs::write(store::paths(&root, &doc.id).0, "Manual correction").unwrap();
        let mut manifest = Manifest::default();
        manifest.entries.insert(doc.id.clone(), entry);
        assert!(cached_meeting(&root, &manifest, &doc.id).is_err());
        manifest.entries.clear();
        recover_entries(&root, &mut manifest).unwrap();
        assert_eq!(manifest.entries[&doc.id].status, "conflict");
        assert_eq!(
            fs::read_to_string(store::paths(&root, &doc.id).0).unwrap(),
            "Manual correction"
        );
        manifest.entries.clear();
        fs::write(store::paths(&root, &doc.id).1, "broken source").unwrap();
        assert!(recover_entries(&root, &mut manifest).is_err());
        assert_eq!(
            fs::read_to_string(store::paths(&root, &doc.id).1).unwrap(),
            "broken source"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn existing_legacy_markdown_is_evidence_without_inventing_transcript_or_timestamps() {
        let row = json!({"id":"legacy","updatedAt":"new-cloud-time"});
        let markdown = "---\nid: \"legacy\"\ntitle: \"Existing note\"\nsource: lynse\n---\n\n# Existing note\n\n## Summary\nManually corrected project status.";
        let doc = legacy_document(&row, markdown).unwrap();
        assert!(doc.transcript.is_empty());
        assert!(doc.segments.is_empty());
        assert!(doc.outline.contains("Manually corrected project status."));
        let (session, server) = super::super::tests::mock_pages(vec![]);
        assert!(load_meeting(&session, &row, &[], Some(doc.clone()))
            .await
            .unwrap()
            .has_meeting_text());
        assert!(server.join().unwrap().is_empty());
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        assert_eq!(write_document(&root, &doc, None).unwrap().status, "synced");
        assert!(legacy_document(&json!({"id":"other-account"}), markdown).is_none());
        assert!(legacy_document(&row, "---\nid: legacy\nsource: other\n---\nUnrelated").is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reused_text_still_honors_revoked_ai_permission() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let (doc, _) = fixture(&root, "restricted");
        for row in [
            json!({"aiContextEnabled":false}),
            json!({"sensitivity":"private"}),
        ] {
            let restricted = restrict_context(doc.clone(), &row);
            assert!(!restricted.ai_context_enabled);
            assert_ne!(restricted.revision, doc.revision);
            assert!(
                !restrict_context(restricted, &json!({"aiContextEnabled":true})).ai_context_enabled
            );
        }
        fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod folder_scope_tests {
    use super::*;
    #[test]
    fn cached_text_adopts_cloud_folder_moves_without_downloading_or_losing_notes() {
        let mut doc=Document {id:"one".into(),kind:"meeting".into(),folder_id:"work".into(),transcript:"Preserved local text".into(),..Default::default()};doc.refresh_revision();
        let version=doc.revision.clone();let moved=restrict_context(doc.clone(),&json!({"folderId":"team"}));
        assert_eq!(moved.transcript,doc.transcript);assert_eq!(moved.folder_id,"team");assert_ne!(moved.revision,version);
        let unfiled=restrict_context(moved,&json!({"folderId":null}));assert!(unfiled.folder_id.is_empty());
        assert_eq!(restrict_context(doc,&json!({})).folder_id,"work");
    }
}

#[cfg(test)]
mod automatic_refresh_tests {
    use super::*;
    #[test]
    fn only_changed_selected_sources_refresh_automatically_and_resume_catches_up() {
        let mut manifest=Manifest {enabled:true,allow_ai:true,wiki_automation:Some(store::WikiAutomation {folder_ids:vec!["work".into()],include_unfiled:false}),..Default::default()};
        let doc=Document {id:"one".into(),kind:"meeting".into(),folder_id:"work".into(),updated_at:"v1".into(),ai_context_enabled:true,..Default::default()};
        manifest.entries.insert(doc.id.clone(),Entry {id:doc.id.clone(),remote_revision:"old".into(),..Default::default()});
        let row=json!({"folderId":"work","updatedAt":"v2"});
        assert!(needs_automatic_refresh(&manifest,&doc,&row,"new"));
        assert!(!needs_automatic_refresh(&manifest,&doc,&row,"old"));
        assert!(!needs_automatic_refresh(&manifest,&doc,&json!({"folderId":"team"}),"new"));
        manifest.enabled=false;assert!(!needs_automatic_refresh(&manifest,&doc,&row,"new"));
        manifest.enabled=true;assert!(needs_automatic_refresh(&manifest,&doc,&row,"new"));
        manifest.entries.get_mut(&doc.id).unwrap().remote_revision.clear();assert!(needs_automatic_refresh(&manifest,&doc,&row,"new"));
        manifest.entries.get_mut(&doc.id).unwrap().excluded=true;assert!(!needs_automatic_refresh(&manifest,&doc,&row,"new"));
    }
}
