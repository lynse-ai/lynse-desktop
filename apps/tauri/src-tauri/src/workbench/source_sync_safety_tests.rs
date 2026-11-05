use super::*;

#[test]
fn source_versions_ignore_server_counters_urls_and_collection_order() {
    let first = json!({"id":"meeting","title":"Plan","updatedAt":"stable","folderId":"work","tags":["b","a"],"readCount":1,"downloadUrl":"old-signed-url"});
    let second = json!({"id":"meeting","title":"Plan","updatedAt":"stable","folderId":"work","tags":["a","b"],"readCount":999,"downloadUrl":"new-signed-url","isSelected":true});
    let tasks = vec![
        json!({"id":"two","fileId":"meeting","title":"Review","completed":false}),
        json!({"id":"one","fileId":"meeting","title":"Ship","completed":true}),
    ];
    let mut reordered = tasks.clone();
    reordered.reverse();
    reordered[0]["readCount"] = json!(500);
    assert_eq!(
        cloud_source_revision(&first, &tasks),
        cloud_source_revision(&second, &reordered)
    );
    let mut changed = second.clone();
    changed["updatedAt"] = json!("content-updated");
    assert_ne!(
        cloud_source_revision(&first, &tasks),
        cloud_source_revision(&changed, &tasks)
    );
    let mut renamed_folder = first.clone();
    renamed_folder["folderName"] = json!("Renamed work folder");
    assert_ne!(
        cloud_source_revision(&first, &tasks),
        cloud_source_revision(&renamed_folder, &tasks)
    );
    let mut changed_tasks = tasks.clone();
    changed_tasks[0]["completed"] = json!(true);
    assert_ne!(
        cloud_source_revision(&first, &tasks),
        cloud_source_revision(&first, &changed_tasks)
    );
}

#[test]
fn source_sync_completion_does_not_hide_an_independently_running_wiki_pass() {
    let mut manifest = Manifest {
        phase: "processing".into(),
        sync_round: "round".into(),
        wiki_progress: Some(store::WikiProgress {
            stage: "compiling".into(),
            completed: 4,
            total: 10,
            ..Default::default()
        }),
        ..Default::default()
    };
    assert!(finish_sync(
        PathBuf::from("unused-empty-source-directory").as_path(),
        &mut manifest
    ));
    assert_eq!(manifest.phase, "processing");
    assert_eq!(manifest.wiki_progress.as_ref().unwrap().completed, 4);
    manifest.wiki_progress.as_mut().unwrap().stage = "complete".into();
    finish_sync(
        PathBuf::from("unused-empty-source-directory").as_path(),
        &mut manifest,
    );
    assert_eq!(manifest.phase, "ready");
}

#[test]
fn local_summaries_survive_proven_metadata_changes_but_never_changed_evidence_or_speakers() {
    let mut previous = Document {
        id: "meeting".into(),
        kind: "meeting".into(),
        title: "Review".into(),
        ai_context_enabled: true,
        folder_id: "old".into(),
        transcript: "We approved the budget".into(),
        segments: vec![json!({"text":"We approved the budget","speakerName":"Alice"})],
        outline: "Budget review".into(),
        conclusions: vec![json!({"conclusionText":"Budget approved"})],
        todos: vec![json!({"title":"Follow up","completed":false})],
        ..Default::default()
    };
    previous.refresh_revision();
    let baseline = json!({"summaries":[{"id":"kept","markdown":"Saved factual summary","sourceRevision":previous.revision},{"id":"old","markdown":"Older summary","sourceRevision":"unrelated-old-version"}]});
    for change in [
        "metadata",
        "transcript",
        "speaker",
        "outline",
        "conclusions",
        "todos",
    ] {
        let mut next = previous.clone();
        next.folder_id = "new".into();
        next.tags = vec!["renamed-folder".into()];
        next.updated_at = "new-metadata-time".into();
        next.playback_path = "/relocated/audio.wav".into();
        next.cloud_file_id = "new-cloud-link".into();
        match change {
            "transcript" => next.transcript = "The budget was rejected".into(),
            "speaker" => next.segments[0]["speakerName"] = json!("Bob"),
            "outline" => next.outline = "Different interpretation".into(),
            "conclusions" => next.conclusions[0]["conclusionText"] = json!("Budget undecided"),
            "todos" => next.todos[0]["completed"] = json!(true),
            _ => {}
        }
        next.refresh_revision();
        let mut manifest = Manifest::default();
        manifest
            .artifacts
            .insert(previous.id.clone(), baseline.clone());
        let migrated = store::preserve_summary_revision(&mut manifest, &previous, &next);
        let rows = &manifest.artifacts[&previous.id]["summaries"];
        if change == "metadata" {
            assert_eq!(migrated, 1);
            assert_eq!(rows[0]["sourceRevision"], next.revision);
            assert_eq!(rows[0]["markdown"], "Saved factual summary");
        } else {
            assert_eq!(
                migrated, 0,
                "Changed evidence must invalidate its summary: {change}"
            );
            assert_eq!(rows[0]["sourceRevision"], previous.revision);
        }
        assert_eq!(rows[1]["sourceRevision"], "unrelated-old-version");
    }
}
