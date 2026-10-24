use super::*;

fn root() -> PathBuf {
    std::env::temp_dir().join(uuid::Uuid::new_v4().to_string())
}
fn doc(id: &str, folder: &str) -> Document {
    let mut doc = Document {
        id: id.into(),
        kind: "meeting".into(),
        title: "同名项目".into(),
        folder_id: folder.into(),
        transcript: "A项目周五提交预算，日期待确认。".into(),
        ai_context_enabled: true,
        ..Default::default()
    };
    doc.refresh_revision();
    doc
}
fn manifest() -> Manifest {
    Manifest {
        wiki_automation: Some(store::WikiAutomation {
            folder_ids: vec!["work".into()],
            include_unfiled: false,
        }),
        ..Default::default()
    }
}
fn add(local: &Path, manifest: &mut Manifest, doc: &Document) {
    let entry = store::write_document(local, doc, None).unwrap();
    manifest.entries.insert(doc.id.clone(), entry);
}
fn row(doc: &Document) -> CatalogTopic {
    CatalogTopic {
        key: "a-project".into(),
        title: "同名项目".into(),
        kind: "project".into(),
        overview: "预算待确认".into(),
        citations: vec![SourceRef {
            quote: doc.text(),
            ..doc.reference()
        }],
        ..Default::default()
    }
}
fn page(topic: &Topic, doc: &Document, manifest: &Manifest, text: &str) -> Revision {
    let refs = vec![SourceRef {
        quote: doc.text(),
        ..doc.reference()
    }];
    Revision {
        id: uuid::Uuid::new_v4().to_string(),
        markdown: text.into(),
        content_hash: store::digest(text),
        fingerprint: page_fingerprint(topic, manifest, &Models::default(), &refs),
        citations: refs.clone(),
        review: "auto_validated".into(),
        changes: vec![WikiChange {
            id: "stable-change".into(),
            text: "预算待确认".into(),
            created_at: "2026-10-23".into(),
            citations: refs,
        }],
        ..Default::default()
    }
}
#[test]
fn setup_requires_an_explicit_nonempty_range_and_keeps_unfiled_separate() {
    assert!(validate_automation(&store::WikiAutomation {
        folder_ids: vec![],
        include_unfiled: false
    })
    .is_err());
    let mut manifest = manifest();
    assert!(allows(&doc("in", "work"), &manifest));
    assert!(!allows(&doc("out", "work/child"), &manifest));
    assert!(!allows(&doc("unfiled", ""), &manifest));
    manifest.wiki_automation.as_mut().unwrap().include_unfiled = true;
    assert!(allows(&doc("unfiled", ""), &manifest));
    assert!(validate_automation(manifest.wiki_automation.as_ref().unwrap()).is_ok());
}
#[test]
fn source_selection_covers_new_meetings_movement_exclusion_and_unavailable_sources() {
    let local = root();
    let mut manifest = manifest();
    for (id, folder) in [
        ("first", "work"),
        ("new", "work"),
        ("outside", "team"),
        ("unfiled", ""),
    ] {
        add(&local, &mut manifest, &doc(id, folder));
    }
    assert_eq!(documents(&local, &manifest).len(), 2);
    manifest.entries.get_mut("first").unwrap().excluded = true;
    assert_eq!(
        documents(&local, &manifest)
            .iter()
            .map(|doc| doc.id.as_str())
            .collect::<Vec<_>>(),
        vec!["new"]
    );
    move_sources(&local, &mut manifest, &["new".into()], "team").unwrap();
    assert!(documents(&local, &manifest).is_empty());
    assert!(ai_manifest(&local, &manifest).entries["new"].excluded);
    manifest.wiki_automation.as_mut().unwrap().folder_ids = vec!["team".into()];
    assert_eq!(documents(&local, &manifest).len(), 2);
    manifest.entries.get_mut("new").unwrap().status = "failed".into();
    assert_eq!(documents(&local, &manifest).len(), 1);
    fs::remove_dir_all(local).unwrap();
}
#[test]
fn summaries_are_preferred_independently_and_transcripts_are_a_real_fallback() {
    let mut source = doc("one", "work");
    source.transcript = "TRANSCRIPT_ONLY".into();
    source.conclusions = vec![
        json!({"conclusionText":"<html>INVALID_PAGE</html>"}),
        json!({"conclusionText":"预算尚未确认。"}),
    ];
    source.refresh_revision();
    let mut manifest = manifest();
    manifest.artifacts.insert(source.id.clone(),json!({"summaries":[{"markdown":"本地总结修订。","sourceRevision":source.revision},{"markdown":"STALE","sourceRevision":"old"}]}));
    let summary = preferred(source.clone(), &manifest);
    assert_eq!(summary.kind, "meeting_summary");
    assert!(summary.text().contains("本地总结修订"));
    for forbidden in ["TRANSCRIPT_ONLY", "INVALID_PAGE", "STALE"] {
        assert!(!summary.text().contains(forbidden));
    }
    assert!(summary.segments.is_empty());
    source.conclusions.clear();
    manifest.artifacts.clear();
    assert_eq!(preferred(source.clone(), &manifest).kind, "meeting");
    source.transcript.clear();
    let local = root();
    add(&local, &mut manifest, &source);
    assert!(documents(&local, &manifest).is_empty());
    fs::remove_dir_all(local).unwrap();
}
#[test]
fn catalog_identity_is_stable_but_same_names_from_different_contexts_stay_separate() {
    let root = root();
    let mut topics = vec![];
    let mut catalog = Catalog::default();
    let one = doc("one", "work");
    let two = doc("two", "work");
    let first = apply_catalog(&mut topics, &mut catalog, &one.id, &[row(&one)])[0].clone();
    assert_eq!(
        apply_catalog(&mut topics, &mut catalog, &one.id, &[row(&one)])[0],
        first
    );
    let second = apply_catalog(&mut topics, &mut catalog, &two.id, &[row(&two)])[0].clone();
    assert_ne!(first, second);
    save_topics(&root, &topics).unwrap();
    assert_eq!(super::super::topics(&root).unwrap().len(), 2);
    let mut related = row(&two);
    related.existing_id = Some(first.clone());
    related.citations.push(row(&one).citations.remove(0));
    assert_eq!(
        apply_catalog(&mut topics, &mut catalog, &two.id, &[related])[0],
        first
    );
    assert!(topics[0].source_ids.contains(&two.id));
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn catalog_rejects_forgery_unanchored_identity_unknown_fields_and_duplicate_keys() {
    let local = root();
    let mut manifest = manifest();
    let one = doc("one", "work");
    let two = doc("two", "work");
    add(&local, &mut manifest, &one);
    add(&local, &mut manifest, &two);
    let old = Topic {
        id: uuid::Uuid::new_v4().to_string(),
        source_ids: vec![one.id.clone()],
        topic_kind: "project".into(),
        ..Default::default()
    };
    let mut item = row(&two);
    item.existing_id = Some(old.id.clone());
    assert!(validate_catalog(
        &json!({"topics":[item]}),
        &[two.clone(), one.clone()],
        &manifest,
        &[old.clone()]
    )
    .is_err());
    item.citations.push(row(&one).citations.remove(0));
    assert!(validate_catalog(
        &json!({"topics":[item.clone()]}),
        &[two.clone(), one.clone()],
        &manifest,
        &[old.clone()]
    )
    .is_ok());
    let mut bad_key = item.clone();
    bad_key.key = "!!!".into();
    assert!(validate_catalog(
        &json!({"topics":[bad_key]}),
        &[two.clone(), one.clone()],
        &manifest,
        &[old.clone()]
    )
    .is_err());
    item.citations[0].quote = "made up".into();
    assert!(validate_catalog(
        &json!({"topics":[item]}),
        &[two.clone(), one],
        &manifest,
        &[old]
    )
    .is_err());
    assert!(validate_catalog(
        &json!({"topics":[row(&two),row(&two)]}),
        &[two.clone()],
        &manifest,
        &[]
    )
    .is_err());
    assert!(
        validate_catalog(&json!({"topics":[],"publish":true}), &[two], &manifest, &[]).is_err()
    );
    fs::remove_dir_all(local).unwrap();
}
#[test]
fn masked_quotes_restore_original_characters_without_fabricated_audio_positions() {
    let mut source = doc("one", "work");
    source.kind = "meeting_summary".into();
    source.transcript = "请联系 zhang@example.com 确认预算。".into();
    let mut value = json!({"citations":[{"id":source.id,"revision":source.revision,"quote":mask(&source.text()),"startMs":123,"segmentId":"invented"}]});
    restore_refs(&mut value, &[source.clone()]).unwrap();
    assert_eq!(value["citations"][0]["quote"], source.text());
    assert_eq!(value["citations"][0]["kind"], "meeting_summary");
    assert!(value["citations"][0].get("startMs").is_none());
    value["citations"][0]["id"] = json!("outside");
    assert!(restore_refs(&mut value, &[source.clone()]).is_err());
    source.transcript = "a@example.com b@example.com".into();
    assert!(restore_refs(&mut json!({"citations":[{"id":source.id,"revision":source.revision,"quote":"*************"}]}),&[source]).is_err());
}
#[test]
fn only_current_scoped_valid_versions_are_citable_and_errors_preserve_the_last_page() {
    let local = root();
    let mut manifest = manifest();
    let source = doc("one", "work");
    add(&local, &mut manifest, &source);
    let mut topic = Topic {
        id: uuid::Uuid::new_v4().to_string(),
        title: "预算".into(),
        ..Default::default()
    };
    topic.published = Some(page(&topic, &source, &manifest, "# 预算\n\n日期待确认。"));
    assert!(citable(&topic, &local, &manifest, &Models::default()));
    let saved = topic.published.as_ref().unwrap().markdown.clone();
    topic.error = "Service unavailable".into();
    assert!(!citable(&topic, &local, &manifest, &Models::default()));
    assert_eq!(topic.published.as_ref().unwrap().markdown, saved);
    topic.error.clear();
    manifest.entries.get_mut(&source.id).unwrap().excluded = true;
    assert!(!citable(&topic, &local, &manifest, &Models::default()));
    manifest.entries.get_mut(&source.id).unwrap().excluded = false;
    manifest.wiki_automation.as_mut().unwrap().folder_ids = vec!["team".into()];
    assert!(!citable(&topic, &local, &manifest, &Models::default()));
    manifest.wiki_automation.as_mut().unwrap().folder_ids = vec!["work".into()];
    topic.notes = "人工纠正".into();
    assert!(!citable(&topic, &local, &manifest, &Models::default()));
    topic.notes.clear();
    topic
        .published
        .as_mut()
        .unwrap()
        .markdown
        .push_str("edited");
    assert!(!citable(&topic, &local, &manifest, &Models::default()));
    fs::remove_dir_all(local).unwrap();
}
#[test]
fn publication_is_idempotent_preserves_human_notes_and_keeps_legacy_drafts_in_history() {
    let root = root();
    let manifest = manifest();
    let source = doc("one", "work");
    let mut topic = Topic {
        id: uuid::Uuid::new_v4().to_string(),
        notes: "人工补充，无会议依据".into(),
        ..Default::default()
    };
    let initial = page(&topic, &source, &manifest, "# A\n\n第一次整理");
    let original_id = initial.id.clone();
    publish_automatic(&root, &mut topic, initial, "v1").unwrap();
    publish_automatic(
        &root,
        &mut topic,
        page(&Topic::default(), &source, &manifest, "# A\n\n第一次整理"),
        "v1",
    )
    .unwrap();
    assert_eq!(topic.published.as_ref().unwrap().id, original_id);
    assert!(topic.history.is_empty());
    topic.candidate = Some(Revision {
        id: uuid::Uuid::new_v4().to_string(),
        markdown: "未确认旧草稿".into(),
        ..Default::default()
    });
    let next = page(&topic, &source, &manifest, "# A\n\n第二次整理");
    publish_automatic(&root, &mut topic, next, "v2").unwrap();
    assert_eq!(topic.history.len(), 2);
    assert!(topic.published.as_ref().unwrap().changes.is_empty());
    assert!(topic.candidate.is_none());
    assert_eq!(topic.notes, "人工补充，无会议依据");
    assert_eq!(topic.published.as_ref().unwrap().review, "auto_validated");
    assert!(topic.published.as_ref().unwrap().reviewed_at.is_empty());
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn page_cache_changes_for_notes_and_scope_but_source_cache_is_incremental() {
    let mut manifest = manifest();
    let mut topic = Topic::default();
    let config = Models::default();
    let source = doc("one", "work");
    let source_key = input_key(&source, &config);
    let initial = page_version(&topic, &[source.clone()], &manifest, &config);
    topic.notes = "人工纠正".into();
    assert_ne!(
        page_version(&topic, &[source.clone()], &manifest, &config),
        initial
    );
    topic.notes.clear();
    manifest.wiki_automation.as_mut().unwrap().include_unfiled = true;
    assert_ne!(
        page_version(&topic, &[source.clone()], &manifest, &config),
        initial
    );
    assert_eq!(input_key(&source, &config), source_key);
    assert_ne!(
        page_version(&topic, &[source, doc("new", "work")], &manifest, &config),
        initial
    );
}
#[test]
fn graph_edges_are_shared_evidence_only_and_outside_topics_are_hidden() {
    let first = Topic {
        id: "one".into(),
        topic_kind: "project".into(),
        published: Some(Revision {
            citations: vec![SourceRef {
                id: "shared".into(),
                ..Default::default()
            }],
            ..Default::default()
        }),
        ..Default::default()
    };
    let second = Topic {
        id: "two".into(),
        published: first.published.clone(),
        ..Default::default()
    };
    let items = vec![
        json!({"id":"one","inScope":true}),
        json!({"id":"two","inScope":true}),
    ];
    let graph = topic_graph(&[first.clone(), second.clone()], &items);
    assert_eq!(graph["edges"][0]["kind"], "shared_source");
    let graph = topic_graph(
        &[first, second],
        &[
            json!({"id":"one","inScope":true}),
            json!({"id":"two","inScope":false}),
        ],
    );
    assert_eq!(graph["nodes"].as_array().unwrap().len(), 1);
    assert!(graph["edges"].as_array().unwrap().is_empty());
}

#[tokio::test]
#[ignore = "Run with the loopback-only synthetic Lynclaw service"]
async fn local_automatic_service_smoke() {
    let origin = std::env::var("LYNSE_GRAPH_LOCAL_URL").unwrap();
    let url = reqwest::Url::parse(&origin).unwrap();
    assert_eq!(url.scheme(), "http");
    assert!(matches!(url.host_str(), Some("127.0.0.1" | "localhost")));
    let session = Session {
        scope: "wiki-http-smoke".into(),
        user_id: "graph-smoke-user".into(),
        base_url: origin.clone(),
        agent_url: origin.clone(),
        model_override: None,
        token: "synthetic-local-graph-token".into(),
        generation: 1,
        locale: "zh-Hans".into(),
    };
    async fn send(
        session: &Session,
        task: &str,
        docs: &[Document],
        query: &str,
        evidence: Value,
    ) -> Value {
        let client = synthesis_client(&session.agent_url).unwrap();
        let payload = transport_payload(task, docs, query, evidence).unwrap();
        let wire = payload.to_string();
        assert!(!wire.contains("example.com"));
        assert!(!wire.contains("TRANSCRIPT_ONLY"));
        let body = lynclaw_payload(session, task, payload);
        let mut value = send_synthesis(
            &client,
            &format!("{}/api/desktop/synthesize", session.agent_url),
            &session.token,
            body,
            || Ok(()),
        )
        .await
        .unwrap();
        restore_refs(&mut value, docs).unwrap();
        value
    }
    let root = root();
    let local = root.join("sources");
    let wiki_root = root.join("wiki");
    let mut manifest = manifest();
    let mut source = doc("wiki-http-source", "work");
    source.title = "本地合成会议 · 自动整理联调".into();
    source.conclusions = vec![
        json!({"conclusionText":"张三负责A项目，周五前给李四预算表。会议决定采用方案B。李四担忧预算超支。联系邮箱 zhang@example.com，电话13812345678。"}),
    ];
    source.transcript = "TRANSCRIPT_ONLY_MUST_NOT_LEAVE_DESKTOP".into();
    source.refresh_revision();
    add(&local, &mut manifest, &source);
    let preferred = preferred(source.clone(), &manifest);
    let docs = vec![preferred.clone()];
    let query = json!({"newSourceId":source.id,"existingTopics":[]}).to_string();
    let catalog_result = send(&session, "wiki_catalog", &docs, &query, Value::Null).await;
    let rows = validate_catalog(&catalog_result, &docs, &manifest, &[]).unwrap();
    let mut catalog = Catalog::default();
    let mut topics = vec![];
    apply_catalog(&mut topics, &mut catalog, &source.id, &rows);
    let mut topic = topics.remove(0);
    let analysis = send(
        &session,
        "source_analysis",
        &docs,
        &topic.title,
        Value::Null,
    )
    .await;
    sync::validate_result(&docs, &manifest, &analysis).unwrap();
    let compiled = send(
        &session,
        "topic_compile",
        &docs,
        &topic.title,
        json!([analysis]),
    )
    .await;
    sync::validate_result(&docs, &manifest, &compiled).unwrap();
    for change in compiled["changes"].as_array().unwrap() {
        sync::validate_result(&docs, &manifest, change).unwrap();
    }
    let citations: Vec<SourceRef> = serde_json::from_value(compiled["citations"].clone()).unwrap();
    let markdown = compiled["summary"].as_str().unwrap().to_owned();
    let mut page = Revision {
        id: uuid::Uuid::new_v4().to_string(),
        content_hash: store::digest(&markdown),
        markdown,
        citations,
        review: "auto_validated".into(),
        overview: compiled["overview"].as_str().unwrap().into(),
        created_at: crate::now(),
        ..Default::default()
    };
    page.fingerprint = page_fingerprint(&topic, &manifest, &Models::default(), &page.citations);
    page.changes = serde_json::from_value::<Vec<Value>>(compiled["changes"].clone())
        .unwrap()
        .into_iter()
        .map(|value| WikiChange {
            id: store::digest(value.to_string()),
            text: value["text"].as_str().unwrap().into(),
            created_at: crate::now(),
            citations: serde_json::from_value(value["citations"].clone()).unwrap(),
        })
        .collect();
    assert!(valid_page(&local, &manifest, &page));
    let version = page_version(&topic, &docs, &manifest, &Models::default());
    publish_automatic(&wiki_root, &mut topic, page.clone(), &version).unwrap();
    publish_automatic(&wiki_root, &mut topic, page, &version).unwrap();
    assert!(topic.history.is_empty());
    assert!(citable(&topic, &local, &manifest, &Models::default()));
    assert!(topic
        .published
        .as_ref()
        .unwrap()
        .citations
        .iter()
        .all(|reference| reference.kind == "meeting_summary"
            && reference.start_ms.is_none()
            && reference.quote.contains("zhang@example.com")));
    save_topics(&wiki_root, &[topic.clone()]).unwrap();
    let loaded = super::super::topics(&wiki_root).unwrap();
    assert_eq!(loaded[0].id, topic.id);
    let topic_graph = topic_graph(&loaded, &[json!({"id":topic.id,"inScope":true})]);
    let artifact = std::env::var("LYNSE_WIKI_LOCAL_RESULT").unwrap();
    fs::write(artifact,serde_json::to_vec_pretty(&json!({"topics":loaded,"topicGraph":topic_graph,"record":{"document":source,"markdown":source.markdown(),"artifacts":null}})).unwrap()).unwrap();
    move_sources(&local, &mut manifest, &[source.id.clone()], "outside").unwrap();
    assert!(!citable(&topic, &local, &manifest, &Models::default()));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn every_model_request_rechecks_current_scope_version_and_per_source_consent() {
    let local = root();
    let mut manifest = manifest();
    let source = doc("one", "work");
    add(&local, &mut manifest, &source);
    let payload =
        transport_payload("source_analysis", &[source.clone()], "A", Value::Null).unwrap();
    assert!(validate_request_sources(&local, &manifest, &payload).is_ok());
    manifest.entries.get_mut(&source.id).unwrap().excluded = true;
    assert!(validate_request_sources(&local, &manifest, &payload).is_err());
    manifest.entries.get_mut(&source.id).unwrap().excluded = false;
    manifest.wiki_automation.as_mut().unwrap().folder_ids = vec!["outside".into()];
    assert!(validate_request_sources(&local, &manifest, &payload).is_err());
    manifest.wiki_automation.as_mut().unwrap().folder_ids = vec!["work".into()];
    let mut changed = source.clone();
    changed.transcript.push_str("新内容");
    changed.refresh_revision();
    add(&local, &mut manifest, &changed);
    assert!(validate_request_sources(&local, &manifest, &payload).is_err());
    fs::remove_dir_all(local).unwrap();
}

#[test]
fn legacy_published_ids_and_exclusions_survive_adoption_without_publishing_drafts() {
    let source = doc("one", "work");
    let manifest = manifest();
    let mut old = Topic {
        id: uuid::Uuid::new_v4().to_string(),
        title: "A项目".into(),
        notes: "人工备注".into(),
        ..Default::default()
    };
    old.published = Some(page(&old, &source, &manifest, "# Existing page"));
    let draft = Topic {
        id: uuid::Uuid::new_v4().to_string(),
        candidate: old.published.clone(),
        ..Default::default()
    };
    let mut values = vec![old.clone(), draft];
    assert!(adopt_legacy_sources(&mut values));
    assert!(values[1].source_ids.is_empty());
    let mut row = row(&source);
    row.existing_id = Some(old.id.clone());
    let mut catalog = Catalog::default();
    assert_eq!(
        apply_catalog(&mut values, &mut catalog, &source.id, &[row.clone()])[0],
        old.id
    );
    assert_eq!(values[0].notes, old.notes);
    assert_eq!(
        values[0].published.as_ref().unwrap().id,
        old.published.as_ref().unwrap().id
    );
    values[0].excluded = true;
    assert_eq!(
        apply_catalog(&mut values, &mut catalog, &source.id, &[row])[0],
        ""
    );
    assert!(values[0].excluded);
}

#[test]
fn new_session_retries_service_failures_and_keeps_completed_work() {
    let root = root();
    let local = root.join("sources");
    let mut manifest = manifest();
    manifest.error = "Wiki catalog failed for 2 sources; retry automatic organization".into();
    manifest.wiki_attempted_fingerprint = "previous-session".into();
    let source = doc("ready", "work");
    add(&local, &mut manifest, &source);
    let mut catalog = Catalog::default();
    catalog.chunks.insert("completed".into(), vec![row(&source)]);
    catalog.identities.insert("project".into(), "stable-identity".into());
    catalog.failed.insert("expired".into(), "Lynclaw could not verify this server".into());
    catalog.failed.insert("evidence".into(), "Invalid Wiki catalog output".into());
    catalog.failed.insert("version".into(), "Lynclaw synthesis failed (HTTP 422): Unknown synthesis task".into());
    write_json(&catalog_path(&root), &catalog).unwrap();
    let mut topic = Topic { id: uuid::Uuid::new_v4().to_string(), title: "Saved topic".into(), error: "Lynclaw authentication failed; sign in again".into(), last_attempt_fingerprint: "failed-session".into(), ..Default::default() };
    topic.published = Some(page(&topic, &source, &manifest, "Saved knowledge"));
    let saved = topic.published.clone().unwrap();
    save_topics(&root, &[topic]).unwrap();
    resume_session_at(&root, &mut manifest).unwrap();
    let catalog: Catalog = read_json(&catalog_path(&root)).unwrap();
    assert!(!catalog.failed.contains_key("expired"));
    assert!(!catalog.failed.contains_key("version"));
    assert!(catalog.failed.contains_key("evidence"));
    assert!(catalog.chunks.contains_key("completed"));
    assert_eq!(catalog.identities["project"], "stable-identity");
    let topics = topics(&root).unwrap();
    assert!(topics[0].error.is_empty());
    assert!(topics[0].last_attempt_fingerprint.is_empty());
    assert_eq!(topics[0].published.as_ref().unwrap().id, saved.id);
    assert_eq!(topics[0].published.as_ref().unwrap().markdown, saved.markdown);
    assert!(manifest.error.is_empty());
    assert!(manifest.wiki_attempted_fingerprint.is_empty());
    assert!(!retry_service_failures(&root).unwrap());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn session_failure_classification_does_not_retry_evidence_failures() {
    for error in [
        "Lynclaw could not verify this server",
        "Lynclaw authentication failed; sign in again",
        "Lynclaw synthesis failed (HTTP 401)",
        "Lynclaw synthesis failed (HTTP 403)",
    ] { assert!(is_session_failure(error)); }
    for error in ["Invalid Wiki catalog output", "Citation does not match source evidence", "Lynclaw synthesis failed (HTTP 422)"] {
        assert!(!is_session_failure(error));
    }
    assert_eq!(synthesis_error(401, &json!({"detail":"private provider text"})), "Lynclaw authentication failed; sign in again");
}

#[test]
fn automatic_source_chunks_keep_the_remote_text_budget_without_empty_padding() {
    let mut source = doc("long", "work");
    source.transcript = "x".repeat(12000);
    source.refresh_revision();
    let chunks = sync::split_text(source.text().trim(), 12000);
    assert_eq!(chunks.len(), 1);
    let part = analysis::part(&source, chunks[0].clone());
    assert!(part.text().chars().count() > 12000);
    let payload = transport_payload("source_analysis", &[part], "Project", Value::Null).unwrap();
    assert_eq!(payload["sources"][0]["text"].as_str().unwrap().chars().count(), 12000);
    assert_eq!(source.transcript.chars().count(), 12000);
    assert!(is_service_failure("Lynclaw synthesis failed (HTTP 422): Unknown synthesis task"));
    assert!(!is_service_failure("Lynclaw synthesis failed (HTTP 422): Invalid source text"));
}

#[test]
fn compilation_snippets_preserve_consent_and_reject_revoked_sources() {
    let local = root();
    let mut manifest = manifest();
    let mut source = doc("compile", "work");
    add(&local, &mut manifest, &source);
    let evidence = json!({"citations":[{"id":source.id,"kind":source.kind,"revision":source.revision,"quote":source.transcript}]});
    let parts = compilation_parts(&[source.clone()], &[evidence.clone()]).unwrap();
    assert!(sync::validate_result(&parts, &manifest, &evidence).is_ok());
    assert_eq!(parts[0].folder_id, "work");
    source.ai_context_enabled = false;
    let revoked = compilation_parts(&[source], &[evidence.clone()]).unwrap();
    assert!(sync::validate_result(&revoked, &manifest, &evidence).is_err());
    fs::remove_dir_all(local).unwrap();
}
