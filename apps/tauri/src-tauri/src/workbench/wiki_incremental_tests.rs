use super::*;

#[test]
fn an_empty_shared_analysis_does_not_remove_original_input_from_compilation() {
    let doc = source("incomplete-extraction");
    let evidence = vec![CompilationEvidence {
        source: doc.clone(),
        value: json!({"relevant":false,"insufficientEvidence":true,"summary":"","citations":[]}),
    }];
    let parts = compilation_parts(&evidence).unwrap();
    let payload = transport_payload(
        "topic_compile",
        &parts,
        "Assess this topic using original evidence",
        json!(evidence),
    )
    .unwrap();
    assert_eq!(payload["sources"][0]["text"], doc.text().trim());
    assert_eq!(payload["evidence"][0]["insufficientEvidence"], true);
    assert!(payload["sources"][0]["text"]
        .as_str()
        .unwrap()
        .contains("confirmed the evidence"));
}

#[tokio::test]
async fn a_fresh_source_cache_executes_once_for_concurrent_topics_and_rebinds_metadata() {
    let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
    let local = root.join("sources");
    let mut doc = source("shared");
    let config = Models::default();
    let mut manifest = Manifest::default();
    manifest.entries.insert(
        doc.id.clone(),
        store::write_document(&local, &doc, None).unwrap(),
    );
    let key = source_evidence_key(&doc, &config);
    let serial = tokio::sync::Mutex::new(());
    let calls = std::cell::Cell::new(0);
    let result = json!({"summary":"Shared source evidence","citations":[{"id":doc.id,"kind":doc.kind,"revision":doc.revision,"quote":doc.transcript}]});
    let generate = || async {
        calls.set(calls.get() + 1);
        tokio::task::yield_now().await;
        Ok(result.clone())
    };
    let first = cached_compilation(
        &root,
        &key,
        &serial,
        |value| sync::validate_result(&[doc.clone()], &manifest, value),
        true,
        generate(),
    );
    let second = cached_compilation(
        &root,
        &key,
        &serial,
        |value| sync::validate_result(&[doc.clone()], &manifest, value),
        true,
        generate(),
    );
    let (a, b) = future::join(first, second).await;
    assert_eq!(a.unwrap(), b.unwrap());
    assert_eq!(calls.get(), 1);
    doc.folder_id = "another-folder".into();
    doc.updated_at = crate::now();
    doc.refresh_revision();
    let old = manifest.entries.get(&doc.id).cloned();
    manifest.entries.insert(
        doc.id.clone(),
        store::write_document(&local, &doc, old.as_ref()).unwrap(),
    );
    assert_eq!(source_evidence_key(&doc, &config), key);
    let rebound = cached_compilation_prepared(
        &root,
        &key,
        &serial,
        |value| content_cache::rebind(value, &[doc.clone()], &manifest),
        true,
        async { panic!("Metadata cannot re-run source extraction") },
    )
    .await
    .unwrap();
    assert_eq!(rebound["citations"][0]["revision"], doc.revision);
    assert_eq!(calls.get(), 1);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn legacy_whole_source_catalogs_migrate_to_stable_chunks_and_only_inserted_text_is_new_work() {
    let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
    let local = root.join("sources");
    let wiki = root.join("wiki");
    let mut doc = source("long-source");
    doc.transcript = format!(
        "{}{}{}",
        "甲".repeat(12000),
        "乙".repeat(12000),
        "丙".repeat(50)
    );
    doc.refresh_revision();
    let config = Models::default();
    let mut manifest = Manifest::default();
    manifest.entries.insert(
        doc.id.clone(),
        store::write_document(&local, &doc, None).unwrap(),
    );
    let original = source_layout::prepare(&wiki, &doc).unwrap();
    let mut catalog = Catalog::default();
    catalog.layouts.insert(doc.id.clone(), original.clone());
    for (index, text) in original.iter().enumerate() {
        let mut row = catalog_row(&doc, None);
        row.key = format!("issue-{index}");
        row.citations[0].quote = text.chars().take(20).collect();
        catalog.chunks.insert(
            format!("{}:{index}", legacy_input_key(&doc, &config)),
            vec![row],
        );
    }
    cache_upgrade::refresh(&wiki, &mut catalog, &[doc.clone()], &manifest, &config, &[]).unwrap();
    let mut values = Vec::new();
    assert!(
        prepare_catalog(&mut values, &mut catalog, &[doc.clone()], &config)
            .jobs
            .is_empty()
    );
    let old_fact_keys: Vec<_> = original
        .iter()
        .map(|text| source_evidence_key(&analysis::part(&doc, text.clone()), &config))
        .collect();
    doc.transcript = format!("Inserted evidence.\n{}", doc.transcript);
    doc.refresh_revision();
    let old = manifest.entries.get(&doc.id).cloned();
    manifest.entries.insert(
        doc.id.clone(),
        store::write_document(&local, &doc, old.as_ref()).unwrap(),
    );
    let layout = source_layout::prepare(&wiki, &doc).unwrap();
    assert_eq!(&layout[1..], original.as_slice());
    catalog.layouts.insert(doc.id.clone(), layout.clone());
    cache_upgrade::refresh(&wiki, &mut catalog, &[doc.clone()], &manifest, &config, &[]).unwrap();
    let docs = [doc.clone()];
    let plan = prepare_catalog(&mut values, &mut catalog, &docs, &config);
    assert_eq!(plan.jobs.len(), 1);
    assert_eq!(plan.jobs[0].text, "Inserted evidence.\n");
    for (text, key) in layout.iter().skip(1).zip(old_fact_keys) {
        assert_eq!(
            source_evidence_key(&analysis::part(&doc, text.clone()), &config),
            key
        );
    }
    assert_eq!(plan.active.len(), 3);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn deleted_automatic_topics_and_aliases_cannot_be_resurrected_by_cached_catalog_rows() {
    let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
    let doc = source("source");
    let mut catalog = Catalog::default();
    let mut values = Vec::new();
    let rows = vec![catalog_row(&doc, None)];
    let id = apply_catalog(&mut values, &mut catalog, &doc.id, &rows)[0].clone();
    let alias = uuid::Uuid::new_v4().to_string();
    values[0].merged_ids.push(alias.clone());
    save_topics(&root, &values).unwrap();
    topic_store::delete(&root, &mut values, &json!({"id":id})).unwrap();
    catalog.deleted.extend(topic_store::deleted(&root).unwrap());
    assert!(catalog.deleted.contains(&alias));
    let ids = apply_catalog(&mut values, &mut catalog, &doc.id, &rows);
    assert_eq!(ids, vec![String::new()]);
    assert!(values.is_empty());
    assert!(topics(&root).unwrap().is_empty());
    fs::remove_dir_all(root).unwrap();
}

fn source(id: &str) -> Document {
    let mut doc = Document {
        id: id.into(),
        kind: "meeting".into(),
        title: format!("Meeting {id}"),
        transcript: format!("The team confirmed the evidence from meeting {id}."),
        ai_context_enabled: true,
        ..Default::default()
    };
    doc.refresh_revision();
    doc
}

fn catalog_row(source: &Document, existing_id: Option<&str>) -> CatalogTopic {
    CatalogTopic {
        key: "release-plan".into(),
        existing_id: existing_id.map(str::to_owned),
        title: "Release plan".into(),
        kind: "project".into(),
        overview: "Confirmed release decisions".into(),
        citations: vec![SourceRef {
            quote: source.text(),
            ..source.reference()
        }],
    }
}

fn cached_key(source: &Document, config: &Models) -> String {
    format!("{}:0", input_key(source, config))
}

fn saved_page(id: &str, source: &Document) -> Revision {
    let markdown = format!("# Release plan\n\n{}", source.text());
    Revision {
        id: id.into(),
        content_hash: store::digest(&markdown),
        markdown,
        citations: vec![SourceRef {
            quote: source.text(),
            ..source.reference()
        }],
        fingerprint: format!("published-{id}"),
        review: "approved".into(),
        created_at: "2026-11-01T00:00:00Z".into(),
        reviewed_at: "2026-11-01T01:00:00Z".into(),
        ..Default::default()
    }
}

#[test]
fn cached_catalog_restores_merged_source_links_without_scheduling_analysis() {
    let docs = vec![source("first"), source("second")];
    let config = Models::default();
    let id = uuid::Uuid::new_v4().to_string();
    let first_identity = format!("project:first:{}", normalize("release-plan"));
    let second_identity = format!("project:second:{}", normalize("release-plan"));
    let mut catalog = Catalog::default();
    catalog
        .identities
        .insert(first_identity.clone(), id.clone());
    catalog.chunks.insert(
        cached_key(&docs[0], &config),
        vec![catalog_row(&docs[0], None)],
    );
    let mut merged = catalog_row(&docs[1], Some(&id));
    merged.citations.push(docs[0].reference());
    merged
        .citations
        .push(source("outside-current-scope").reference());
    catalog
        .chunks
        .insert(cached_key(&docs[1], &config), vec![merged]);
    let mut values = Vec::new();

    let plan = prepare_catalog(&mut values, &mut catalog, &docs, &config);

    assert!(plan.jobs.is_empty());
    assert_eq!(plan.applied, 2);
    assert_eq!(plan.failures, 0);
    assert_eq!(values.len(), 1);
    assert_eq!(values[0].id, id);
    assert_eq!(catalog.identities.get(&first_identity), Some(&id));
    assert_eq!(catalog.identities.get(&second_identity), Some(&id));
    assert_eq!(
        plan.active.get(&id),
        Some(&BTreeSet::from(["first".into(), "second".into()]))
    );

    reconcile_sources(&mut values, &plan.active, &plan.failed_sources, &docs);
    assert_eq!(values[0].source_ids, vec!["first", "second"]);
}

#[test]
fn mixed_catalog_schedules_only_new_text_and_retains_failed_source_evidence() {
    let docs = vec![source("cached"), source("new"), source("failed")];
    let config = Models::default();
    let id = uuid::Uuid::new_v4().to_string();
    let mut values = vec![Topic {
        id: id.clone(),
        title: "Release plan".into(),
        automatic_key: "project:cached:releaseplan".into(),
        source_ids: vec!["cached".into(), "failed".into(), "removed".into()],
        published: Some(saved_page("preserved-page", &docs[2])),
        ..Default::default()
    }];
    let mut catalog = Catalog::default();
    catalog.chunks.insert(
        cached_key(&docs[0], &config),
        vec![catalog_row(&docs[0], Some(&id))],
    );
    let failed_key = cached_key(&docs[2], &config);
    catalog
        .failed
        .insert(failed_key.clone(), "Invalid Wiki catalog output".into());
    // A latched failure takes precedence even when an older cache entry exists.
    catalog
        .chunks
        .insert(failed_key.clone(), vec![catalog_row(&docs[2], None)]);

    let plan = prepare_catalog(&mut values, &mut catalog, &docs, &config);

    assert_eq!(plan.jobs.len(), 1);
    assert_eq!(plan.jobs[0].doc.id, "new");
    assert_eq!(plan.jobs[0].key, cached_key(&docs[1], &config));
    assert_eq!(plan.jobs[0].text, docs[1].text().trim());
    assert_eq!(plan.applied, 2);
    assert_eq!(plan.failures, 1);
    assert_eq!(plan.failed_sources, BTreeSet::from(["failed".into()]));
    assert_eq!(
        catalog.details.get(&failed_key).unwrap().source_id,
        "failed"
    );
    assert_eq!(values.len(), 1);

    reconcile_sources(&mut values, &plan.active, &plan.failed_sources, &docs);
    assert_eq!(values[0].source_ids, vec!["cached", "failed"]);
    assert_eq!(values[0].published.as_ref().unwrap().id, "preserved-page");
}

#[test]
fn repeated_cached_replay_preserves_published_history_and_completed_versions() {
    let docs = vec![source("first"), source("second")];
    let config = Models {
        text_revision: "unchanged-model".into(),
        ..Default::default()
    };
    let id = uuid::Uuid::new_v4().to_string();
    let mut values = vec![Topic {
        id: id.clone(),
        title: "User-maintained release title".into(),
        purpose: "Retain reviewed decisions".into(),
        notes: "Preserve the user's correction".into(),
        automatic_key: "project:first:releaseplan".into(),
        topic_kind: "project".into(),
        source_ids: vec!["first".into(), "second".into()],
        published: Some(saved_page("published-id", &docs[0])),
        candidate: Some(saved_page("candidate-id", &docs[1])),
        history: vec![saved_page("historical-id", &docs[0])],
        ..Default::default()
    }];
    let version = page_version(&values[0], &docs, &Manifest::default(), &config);
    values[0].last_fingerprint = version.clone();
    values[0].last_attempt_fingerprint = version;
    let mut catalog = Catalog::default();
    for doc in &docs {
        catalog
            .identities
            .insert(format!("project:{}:releaseplan", doc.id), id.clone());
        catalog
            .chunks
            .insert(cached_key(doc, &config), vec![catalog_row(doc, Some(&id))]);
    }
    let original_topics = serde_json::to_value(&values).unwrap();
    let original_catalog = serde_json::to_value(&catalog).unwrap();

    for _ in 0..3 {
        let plan = prepare_catalog(&mut values, &mut catalog, &docs, &config);
        assert!(plan.jobs.is_empty());
        reconcile_sources(&mut values, &plan.active, &plan.failed_sources, &docs);
        assert_eq!(serde_json::to_value(&values).unwrap(), original_topics);
        assert_eq!(serde_json::to_value(&catalog).unwrap(), original_catalog);
    }
}

#[test]
fn cached_empty_catalog_result_remains_a_completed_analysis() {
    let docs = vec![source("no-topic")];
    let config = Models::default();
    let mut catalog = Catalog::default();
    catalog
        .chunks
        .insert(cached_key(&docs[0], &config), Vec::new());
    let mut values = Vec::new();

    let plan = prepare_catalog(&mut values, &mut catalog, &docs, &config);

    assert!(plan.jobs.is_empty());
    assert_eq!(plan.applied, 1);
    assert!(plan.active.is_empty());
    assert!(values.is_empty());
}
