use super::*;

fn source(text: String) -> Document {
    Document {
        id: "source".into(),
        kind: schema::SUMMARY_KIND.into(),
        title: "Review".into(),
        transcript: text,
        revision: "r1".into(),
        ai_context_enabled: true,
        ..Default::default()
    }
}
fn tracking() -> Tracking {
    Tracking {
        scope: "account-one".into(),
        language: "zh".into(),
        selected_sources: BTreeSet::from(["source".into()]),
        ..Default::default()
    }
}
fn complete(tracking: &mut Tracking, doc: &Document) -> Vec<cache::Work> {
    let work = cache::plan(std::slice::from_ref(doc), tracking);
    for item in &work {
        tracking.chunks.insert(
            item.key.clone(),
            Chunk {
                source_id: doc.id.clone(),
                content_revision: item.content_revision.clone(),
                identity: item.identity.clone(),
                profile: cache::PROFILE.into(),
                extraction: Extraction {
                    schema_version: schema::VERSION,
                    ..Default::default()
                },
                ..Default::default()
            },
        );
    }
    work
}

#[test]
fn repeated_processing_and_restart_make_zero_new_model_calls_including_empty_graphs() {
    let document = source(format!(
        "{}{}{}",
        "甲".repeat(12000),
        "乙".repeat(12000),
        "丙".repeat(1000)
    ));
    let mut tracking = tracking();
    assert_eq!(complete(&mut tracking, &document).len(), 3);
    assert!(cache::pending(std::slice::from_ref(&document), &tracking).is_empty());
    let restored: Tracking =
        serde_json::from_str(&serde_json::to_string(&tracking).unwrap()).unwrap();
    assert!(cache::pending(&[document], &restored).is_empty());
}

#[test]
fn insertion_and_local_edit_keep_unchanged_boundaries_and_identities() {
    let mut document = source(format!(
        "{}{}{}",
        "甲".repeat(12000),
        "乙".repeat(12000),
        "丙".repeat(1000)
    ));
    let mut tracking = tracking();
    let original = complete(&mut tracking, &document);
    document.transcript.insert_str(0, "插入的说明。\n");
    document.revision = "new-revision".into();
    let pending = cache::pending(std::slice::from_ref(&document), &tracking);
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].part.transcript, "插入的说明。\n");
    let planned = cache::plan(std::slice::from_ref(&document), &mut tracking);
    for item in original {
        assert!(planned
            .iter()
            .any(|next| next.key == item.key && next.identity == item.identity));
    }
    complete(&mut tracking, &document);
    document.transcript = document.transcript.replacen("乙乙乙", "新内容", 1);
    assert_eq!(cache::pending(&[document], &tracking).len(), 1);
}

#[test]
fn cache_keys_follow_only_effective_input_language_and_scope() {
    let mut document = source("张三负责发布评审。".into());
    let mut tracking = tracking();
    complete(&mut tracking, &document);
    document.folder_id = "moved-folder".into();
    document.updated_at = "new-time".into();
    document.revision = "metadata-revision".into();
    assert!(cache::pending(std::slice::from_ref(&document), &tracking).is_empty());
    tracking.language = "en".into();
    assert_eq!(
        cache::pending(std::slice::from_ref(&document), &tracking).len(),
        1
    );
    tracking.language = "zh".into();
    assert!(cache::pending(std::slice::from_ref(&document), &tracking).is_empty());
    tracking.scope = "another-account".into();
    assert_eq!(
        cache::pending(std::slice::from_ref(&document), &tracking).len(),
        1
    );
    tracking.scope = "account-one".into();
    document.title = "A different reasoning context".into();
    assert_eq!(cache::pending(&[document], &tracking).len(), 1);
}

#[test]
fn cached_citations_rebind_to_current_revision_and_masked_private_values() {
    let mut document = source("张三邮箱 old@example.com。".into());
    let mut tracking = tracking();
    let work = cache::plan(std::slice::from_ref(&document), &mut tracking).remove(0);
    let reference = SourceRef {
        quote: document.transcript.clone(),
        ..document.reference()
    };
    let extraction: Extraction = serde_json::from_value(json!({"schemaVersion":1,"nodes":[{
        "key":"person","kind":"person","title":"张三","description":"参与评审","status":"unknown",
        "modality":"asserted","confidence":0.8,"citations":[reference]}],"relations":[]}))
    .unwrap();
    tracking.chunks.insert(
        work.key.clone(),
        Chunk {
            source_id: document.id.clone(),
            extraction,
            identity: work.identity,
            profile: cache::PROFILE.into(),
            ..Default::default()
        },
    );
    document.revision = "r2".into();
    document.transcript = document.transcript.replace("old@", "new@");
    // Identical transport text can reuse analysis, but original quotes must be restored anew.
    let planned = cache::plan(std::slice::from_ref(&document), &mut tracking);
    assert_eq!(planned[0].key, work.key);
    let quote = &tracking.chunks[&work.key].extraction.nodes[0].citations[0];
    assert_eq!(quote.revision, "r2");
    assert!(quote.quote.contains("new@example.com"));
}

#[test]
fn legacy_results_and_manual_state_survive_until_explicit_refresh() {
    let document = source("张三负责评审。".into());
    let mut tracking = tracking();
    let old_key = store::digest(
        json!([
            schema::VERSION,
            document.id,
            schema::content_revision(&document),
            0,
            store::digest(&document.transcript)
        ])
        .to_string(),
    );
    tracking.chunks.insert(
        old_key.clone(),
        Chunk {
            source_id: document.id.clone(),
            content_revision: schema::content_revision(&document),
            extraction: Extraction {
                schema_version: 1,
                ..Default::default()
            },
            ..Default::default()
        },
    );
    tracking
        .reviews
        .insert("entity:manual".into(), json!({"review":"confirmed"}));
    tracking
        .merges
        .insert("entity:one".into(), "entity:two".into());
    tracking
        .todo_links
        .insert("entity:manual".into(), "todo-id".into());
    assert!(cache::pending(std::slice::from_ref(&document), &tracking).is_empty());
    let planned = cache::plan(std::slice::from_ref(&document), &mut tracking);
    assert_eq!(planned[0].identity, old_key);
    tracking.refresh_legacy = true;
    let next = cache::pending(&[document], &tracking);
    assert_eq!(next.len(), 1);
    assert_eq!(next[0].identity, old_key);
    assert_eq!(tracking.reviews["entity:manual"]["review"], "confirmed");
    assert_eq!(tracking.todo_links["entity:manual"], "todo-id");
    assert!(tracking.chunks.contains_key(&old_key));
}

#[test]
fn unknown_outcomes_and_validation_errors_are_not_automatic_cache_hits_or_retries() {
    let document = source("需要处理的会议。".into());
    let mut tracking = tracking();
    let item = cache::plan(std::slice::from_ref(&document), &mut tracking).remove(0);
    tracking.chunks.insert(
        item.key.clone(),
        Chunk {
            source_id: document.id.clone(),
            error: "unknown outcome".into(),
            ..Default::default()
        },
    );
    assert!(cache::pending(std::slice::from_ref(&document), &tracking).is_empty());
    assert!(!tracking.chunks[&item.key].error.is_empty());
    tracking.chunks.retain(|_, chunk| chunk.error.is_empty());
    assert_eq!(cache::pending(&[document], &tracking).len(), 1);
}

#[test]
fn retry_keeps_live_claims_and_restart_blocks_unknown_outcomes_until_explicit_retry() {
    let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
    let document = source("需要处理的会议。".into());
    let mut tracking = tracking();
    let work = cache::plan(std::slice::from_ref(&document), &mut tracking).remove(0);
    tracking.chunks.insert(
        work.key.clone(),
        Chunk {
            source_id: document.id.clone(),
            in_flight: true,
            error: "unknown pending request".into(),
            ..Default::default()
        },
    );
    tracking.chunks.insert(
        "failed".into(),
        Chunk {
            error: "validation error".into(),
            ..Default::default()
        },
    );
    write_json(&path(&root), &tracking).unwrap();
    configure(&root, &json!({"action":"tracking_retry"})).unwrap();
    let mut restored: Tracking = read_json(&path(&root)).unwrap();
    assert!(restored.chunks[&work.key].in_flight);
    assert!(!restored.chunks.contains_key("failed"));
    assert_eq!(recover_interrupted(&mut restored), 1);
    assert_eq!(restored.metrics.unknown_calls, 1);
    assert!(!restored.chunks[&work.key].in_flight);
    assert!(cache::pending(std::slice::from_ref(&document), &restored).is_empty());
    write_json(&path(&root), &restored).unwrap();
    configure(&root, &json!({"action":"tracking_retry"})).unwrap();
    let retry: Tracking = read_json(&path(&root)).unwrap();
    assert_eq!(cache::pending(&[document], &retry).len(), 1);
    std::fs::remove_dir_all(root).unwrap();
}
