use super::*;
fn doc() -> Document {
    let mut doc = Document {
        id: "one".into(),
        kind: "meeting".into(),
        title: "Meeting".into(),
        transcript: "张三负责A项目，周五前给李四预算表。".into(),
        conclusions: vec![json!({"conclusionText":"张三负责A项目，周五前给李四预算表。"})],
        ai_context_enabled: true,
        segments: vec![
            json!({"id":"s1","text":"张三负责A项目，周五前给李四预算表。","startMs":12000,"endMs":18000,"speakerName":"Speaker 1"}),
        ],
        ..Default::default()
    };
    doc.refresh_revision();
    doc
}
fn summary(doc: &Document) -> Document {
    schema::summary_source(doc, &Manifest::default()).unwrap()
}
#[test]
fn graph_inputs_use_only_existing_summaries_without_transcript_fallback() {
    let mut document = doc();
    document.transcript = "PRIVATE_TRANSCRIPT_ONLY".into();
    document.outline = "PRIVATE_OUTLINE_ONLY".into();
    document.todos = vec![json!({"title":"PRIVATE_TODO_ONLY"})];
    document.conclusions = vec![
        json!({"conclusionText":"张三负责A项目，联系 zhang@example.com。"}),
        json!({"conclusionText":"<html>PRIVATE_RENDERED_PAGE</html>"}),
    ];
    document.refresh_revision();
    let mut manifest = Manifest::default();
    manifest.artifacts.insert(document.id.clone(), json!({"summaries":[
        {"markdown":"本地已编辑总结。","sourceRevision":document.revision},
        {"markdown":"STALE_SUMMARY_ONLY","sourceRevision":"old"}
    ]}));
    let source = schema::summary_source(&document, &manifest).unwrap();
    assert!(source.transcript.contains("本地已编辑总结"));
    let copy = schema::transport(&source).unwrap();
    let payload = serde_json::to_string(&copy).unwrap();
    for forbidden in ["PRIVATE_", "STALE_SUMMARY_ONLY", "example.com"] {
        assert!(!payload.contains(forbidden), "{forbidden}");
    }
    assert!(copy.segments.is_empty());
    assert_eq!(copy.kind, "meeting_summary");
    assert!(schema::transport(&document).is_err());
    let tracking = Tracking { selected_sources: BTreeSet::from([document.id.clone()]), ..Default::default() };
    assert!(pending_chunks(&[document.clone()], &tracking).is_empty());
    document.conclusions.clear();
    assert!(schema::summary_source(&document, &Manifest::default()).is_none());
    document.ai_context_enabled = false;
    assert!(schema::summary_source(&document, &manifest).is_none());
}

#[test]
fn summary_quotes_never_gain_audio_positions_and_only_summary_edits_invalidate_extraction() {
    let mut document = doc();
    let source = summary(&document);
    let reference = SourceRef { quote: source.transcript.clone(), ..source.reference() };
    // Even a summary that happens to match a spoken segment is summary evidence only.
    let located = schema::locate(&reference, &source);
    assert_eq!(located["kind"], "meeting_summary");
    assert!(located.get("startMs").is_none());
    assert!(located["positions"].as_array().unwrap().is_empty());
    document.transcript.push_str("新转写文本");
    document.refresh_revision();
    assert_eq!(schema::content_revision(&summary(&document)), schema::content_revision(&source));
    document.conclusions[0]["conclusionText"] = json!("修改后的总结");
    assert_ne!(schema::content_revision(&summary(&document)), schema::content_revision(&source));
}
fn output(doc: &Document) -> Value {
    let reference = json!(SourceRef {
        quote: doc.transcript.clone(),
        ..doc.reference()
    });
    let node = |key: &str, kind: &str, title: &str| json!({"key":key,"kind":kind,"title":title,"description":title,"status":"unknown","modality":"asserted","confidence":0.8,"timeText":"","dueText":"","citations":[reference]});
    json!({"schemaVersion":1,"nodes":[node("p","person","张三"),node("a","project","A项目"),{"key":"t","kind":"task","title":"提交预算表","description":"计划提交预算表","status":"unknown","modality":"planned","confidence":0.8,"timeText":"","dueText":"周五","citations":[reference]}],"relations":[{"subject":"p","target":"a","predicate":"responsible_for","modality":"asserted","confidence":0.8,"citations":[reference]},{"subject":"t","target":"p","predicate":"owner","modality":"planned","confidence":0.8,"citations":[reference]}]})
}
#[test]
fn contract_keeps_plans_dates_and_verifies_each_relation() {
    let doc = summary(&doc());
    let value = output(&doc);
    let graph = schema::validate(value.clone(), &doc).unwrap();
    assert_eq!(graph.nodes[2].modality, "planned");
    assert_eq!(graph.nodes[2].due_text, "周五");
    for bad in [
        "endpoint", "quote", "position", "time", "kind", "role", "version",
    ] {
        let mut changed = value.clone();
        match bad {
            "endpoint" => changed["relations"][0]["target"] = json!("missing"),
            "quote" => changed["relations"][0]["citations"][0]["quote"] = json!("invented"),
            "position" => changed["nodes"][0]["citations"][0]["startMs"] = json!(123),
            "time" => changed["nodes"][2]["dueText"] = json!("2026-10-23"),
            "kind" => changed["nodes"][0]["kind"] = json!("goal"),
            "role" => changed["relations"][0]["predicate"] = json!("owner"),
            _ => changed["schemaVersion"] = json!(99),
        }
        assert!(schema::validate(changed, &doc).is_err(), "{bad}");
    }
}
#[test]
fn entity_and_topic_titles_are_model_labels_backed_by_verbatim_citations() {
    let doc = summary(&doc());
    let mut value = output(&doc);
    let reference = value["nodes"][0]["citations"][0].clone();
    value["nodes"].as_array_mut().unwrap().push(json!({
        "key":"theme","kind":"topic","title":"春节版本提审","description":"本周冲刺春节版本提审",
        "status":"unknown","modality":"asserted","confidence":0.8,"timeText":"","dueText":"",
        "citations":[reference.clone()]
    }));
    value["relations"].as_array_mut().unwrap().push(json!({
        "subject":"p","target":"theme","predicate":"topic","modality":"asserted","confidence":0.8,"citations":[reference.clone()]
    }));
    value["nodes"].as_array_mut().unwrap().push(json!({
        "key":"proj","kind":"project","title":"春节版本提审准备","description":"准备春节版本提审",
        "status":"unknown","modality":"asserted","confidence":0.8,"timeText":"","dueText":"",
        "citations":[reference]
    }));
    let graph = schema::validate(value, &doc).unwrap();
    assert_eq!(graph.nodes[3].kind, "topic");
    assert_eq!(graph.nodes[4].title, "春节版本提审准备");
}
#[test]
fn privacy_mask_keeps_character_offsets_and_restores_only_local_quotes() {
    let mut doc = doc();
    doc.conclusions = vec![json!({"conclusionText":"张三邮箱 zhang@example.com，电话 13812345678。"})];
    doc.refresh_revision();
    let doc = summary(&doc);
    let masked = schema::mask(&doc.transcript);
    assert_eq!(masked.chars().count(), doc.transcript.chars().count());
    assert!(!masked.contains("example"));
    let mut value = output(&doc);
    value["nodes"].as_array_mut().unwrap().truncate(1);
    value["relations"] = json!([]);
    value["nodes"][0]["citations"][0]["quote"] = json!(masked);
    let result = schema::validate(value, &doc).unwrap();
    assert_eq!(result.nodes[0].citations[0].quote, doc.transcript);
    assert!(!serde_json::to_string(&schema::transport(&doc).unwrap())
        .unwrap()
        .contains("example.com"));
}
#[test]
fn audio_positions_are_local_and_ambiguous_matches_remain_candidates() {
    let mut doc = doc();
    let reference = SourceRef {
        quote: doc.transcript.clone(),
        ..doc.reference()
    };
    let located = schema::locate(&reference, &doc);
    assert_eq!(located["startMs"], 12000);
    assert_eq!(located["speaker"], "Speaker 1");
    doc.segments
        .push(json!({"id":"s2","text":doc.transcript,"startMs":24000}));
    let located = schema::locate(&reference, &doc);
    assert!(located.get("startMs").is_none());
    assert_eq!(located["positions"].as_array().unwrap().len(), 2);
}
#[test]
fn projection_invalidates_revoked_content_but_rebinds_metadata_and_scopes_names() {
    let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
    let local = root.join("sources");
    let mut manifest = Manifest::default();
    manifest.enabled = true;
    manifest.allow_ai = true;
    let mut doc = doc();
    manifest.entries.insert(
        doc.id.clone(),
        store::write_document(&local, &doc, None).unwrap(),
    );
    let mut tracking = Tracking::default();
    tracking.selected_sources.insert(doc.id.clone());
    let source = summary(&doc);
    let extraction = schema::validate(output(&source), &source).unwrap();
    assert!(pending_chunks(&[doc.clone()], &Tracking::default()).is_empty());
    let (key, _) = pending_chunks(&[source.clone()], &tracking).remove(0);
    tracking.chunks.insert(
        key.clone(),
        Chunk {
            source_id: doc.id.clone(),
            content_revision: schema::content_revision(&source),
            extraction: extraction.clone(),
            ..Default::default()
        },
    );
    write_json(&path(&root), &tracking).unwrap();
    let projection =
        |manifest: &Manifest| view(&root, &local, manifest, &[], &Models::default()).unwrap();
    assert_eq!(projection(&manifest)["nodes"].as_array().unwrap().len(), 4);
    let identity = node_id(&key, &extraction.nodes[0]);
    assert_ne!(identity, node_id("another-source", &extraction.nodes[0]));
    configure(&root,&json!({"action":"tracking_review","id":identity,"review":"confirmed","description":"用户修正"})).unwrap();
    doc.title = "Renamed".into();
    doc.playback_path = "/new/path".into();
    doc.refresh_revision();
    manifest.entries.insert(
        doc.id.clone(),
        store::write_document(&local, &doc, None).unwrap(),
    );
    manifest.allow_ai = false;
    assert!(projection(&manifest)["nodes"]
        .as_array()
        .unwrap()
        .is_empty());
    manifest.allow_ai = true;
    let renamed = projection(&manifest);
    let person = renamed["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|node| node["id"] == identity)
        .unwrap();
    assert_eq!(person["description"], "用户修正");
    assert_eq!(person["citations"][0]["revision"], doc.revision);
    assert!(pending_chunks(&[summary(&doc)], &read_json(&path(&root)).unwrap()).is_empty());
    manifest.entries.get_mut(&doc.id).unwrap().excluded = true;
    assert!(projection(&manifest)["nodes"]
        .as_array()
        .unwrap()
        .is_empty());
    manifest.entries.get_mut(&doc.id).unwrap().excluded = false;
    doc.conclusions[0]["conclusionText"] = json!("总结内容改变");
    doc.refresh_revision();
    manifest.entries.insert(
        doc.id.clone(),
        store::write_document(&local, &doc, None).unwrap(),
    );
    assert!(projection(&manifest)["nodes"]
        .as_array()
        .unwrap()
        .is_empty());
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn old_cache_is_never_loaded_and_selection_does_not_start_extraction() {
    let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("knowledge-graph.json"), "old incompatible cache").unwrap();
    configure(&root, &json!({"action":"tracking_sources","ids":["one"]})).unwrap();
    let tracking: Tracking = read_json(&path(&root)).unwrap();
    assert!(!tracking.enabled);
    configure(&root, &json!({"action":"tracking","enabled":true})).unwrap();
    configure(&root, &json!({"action":"tracking_sources","ids":[]})).unwrap();
    assert!(configure(&root, &json!({"action":"tracking","enabled":true})).is_err());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn manual_identity_merge_is_reversible_and_does_not_merge_claims() {
    let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
    let one = doc();
    let mut second = one.clone();
    second.id = "two".into();
    second.refresh_revision();
    let mut tracking = Tracking::default();
    let first_source = summary(&one);
    let other_source = summary(&second);
    let first = schema::validate(output(&first_source), &first_source).unwrap();
    let other = schema::validate(output(&other_source), &other_source).unwrap();
    tracking.chunks.insert(
        "first".into(),
        Chunk {
            extraction: first.clone(),
            ..Default::default()
        },
    );
    tracking.chunks.insert(
        "second".into(),
        Chunk {
            extraction: other.clone(),
            ..Default::default()
        },
    );
    write_json(&path(&root), &tracking).unwrap();
    let a = node_id("first", &first.nodes[0]);
    let b = node_id("second", &other.nodes[0]);
    let project = node_id("second", &other.nodes[1]);
    assert!(configure(
        &root,
        &json!({"action":"tracking_merge","id":a,"target":project})
    )
    .is_err());
    configure(&root, &json!({"action":"tracking_merge","id":a,"target":b})).unwrap();
    assert!(configure(&root, &json!({"action":"tracking_merge","id":b,"target":a})).is_err());
    tracking = read_json(&path(&root)).unwrap();
    let mut nodes = BTreeMap::from([
        (
            a.clone(),
            json!({"id":a,"kind":"entity","subtype":"person","description":"first statement","citations":[one.reference()]}),
        ),
        (
            b.clone(),
            json!({"id":b,"kind":"entity","subtype":"person","description":"second statement","citations":[second.reference()]}),
        ),
    ]);
    let original = nodes.clone();
    let mut edges = BTreeMap::from([("role".into(), json!({"source":"event","target":a}))]);
    merge_entities(&mut nodes, &mut edges, &tracking);
    assert_eq!(nodes.len(), 1);
    assert_eq!(nodes[&b]["members"].as_array().unwrap().len(), 2);
    assert_eq!(edges["role"]["target"], b);
    assert_eq!(nodes[&b]["description"], "second statement");
    configure(&root, &json!({"action":"tracking_unmerge","id":b})).unwrap();
    tracking = read_json(&path(&root)).unwrap();
    let mut nodes = original;
    merge_entities(&mut nodes, &mut BTreeMap::new(), &tracking);
    assert_eq!(nodes.len(), 2);
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
#[ignore = "requires the loopback synthetic Lynclaw fixture; run pnpm test:graph:local"]
async fn local_graph_service_smoke() {
    let origin = std::env::var("LYNSE_GRAPH_LOCAL_URL").expect("local graph service URL");
    let parsed = reqwest::Url::parse(&origin).unwrap();
    assert_eq!(parsed.scheme(), "http");
    assert!(matches!(parsed.host_str(), Some("127.0.0.1" | "localhost")));
    let endpoint = format!("{origin}/api/desktop/synthesize");
    let client = super::super::synthesis_client(&origin).unwrap();
    let mut document = doc();
    document.id = "graph-http-smoke".into();
    document.title = "本地合成会议 · 图谱联调".into();
    document.transcript = "张三负责A项目，周五前给李四预算表。会议决定采用方案B。李四担忧预算超支。联系邮箱 zhang@example.com，电话13812345678。".into();
    document.conclusions = vec![json!({"conclusionText":document.transcript})];
    document.transcript = "TRANSCRIPT_ONLY_MUST_NOT_LEAVE_DESKTOP".into();
    document.segments = vec![
        json!({"id":"smoke-segment","text":document.transcript,"startMs":12000,"endMs":18000,"speakerName":"合成说话人"}),
    ];
    document.refresh_revision();
    let source = summary(&document);
    let copy = schema::transport(&source).unwrap();
    assert!(!copy.transcript.contains("example.com"));
    assert!(!copy.transcript.contains("13812345678"));
    assert!(!copy.transcript.contains("TRANSCRIPT_ONLY"));
    let session = Session {
        scope: "local-graph-smoke".into(),
        user_id: "graph-smoke-user".into(),
        base_url: origin.clone(),
        agent_url: origin.clone(),
        model_override: None,
        token: "synthetic-local-graph-token".into(),
        generation: 1,
        locale: "zh-Hans".into(),
    };
    let body = super::super::lynclaw_payload(
        &session,
        "graph_extract",
        json!({"sources":[{"id":copy.id,"revision":copy.revision,"kind":copy.kind,"title":copy.title,"text":copy.transcript,"segments":[]}]}),
    );
    for token in [None, Some("rejected-synthetic-token")] {
        let mut request = client.post(&endpoint).json(&body);
        if let Some(token) = token {
            request = request.header("Authorization", token);
        }
        assert_eq!(request.send().await.unwrap().status().as_u16(), 401);
    }
    let mut forged = body.clone();
    forged["userId"] = json!("another-user");
    assert_eq!(
        client
            .post(&endpoint)
            .header("Authorization", &session.token)
            .json(&forged)
            .send()
            .await
            .unwrap()
            .status()
            .as_u16(),
        422
    );
    let value =
        super::super::send_synthesis(&client, &endpoint, &session.token, body.clone(), || Ok(()))
            .await
            .unwrap();
    let extraction = schema::validate(value, &source).unwrap();
    assert_eq!(extraction.nodes.len(), 7);
    assert!(extraction
        .nodes
        .iter()
        .flat_map(|node| &node.citations)
        .all(|reference| reference.quote.contains("zhang@example.com")));
    let mut invalid = body.clone();
    invalid["query"] = json!("fixture-invalid-quote");
    let invalid = client
        .post(&endpoint)
        .header("Authorization", &session.token)
        .json(&invalid)
        .send()
        .await
        .unwrap();
    assert_eq!(invalid.status().as_u16(), 422);
    assert_eq!(
        invalid.json::<Value>().await.unwrap()["detail"],
        "Citation does not match source evidence"
    );
    let revoked = super::super::send_synthesis(&client, &endpoint, &session.token, body, || {
        Err("Synthetic session revoked".into())
    })
    .await
    .unwrap_err();
    assert_eq!(revoked, "Synthetic session revoked");
    let health: Value = client
        .get(format!("{origin}/health"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(health["modelCalls"], 2);
    assert_eq!(health["allMasked"], true);
    let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
    let local = root.join("sources");
    let mut manifest = Manifest::default();
    manifest.enabled = true;
    manifest.allow_ai = true;
    manifest.entries.insert(
        document.id.clone(),
        store::write_document(&local, &document, None).unwrap(),
    );
    let mut tracking = Tracking::default();
    tracking.selected_sources.insert(document.id.clone());
    let (key, _) = pending_chunks(&[source.clone()], &tracking).remove(0);
    tracking.chunks.insert(
        key,
        Chunk {
            source_id: document.id.clone(),
            content_revision: schema::content_revision(&source),
            extracted_at: crate::now(),
            extraction,
            error: String::new(),
        },
    );
    write_json(&path(&root), &tracking).unwrap();
    let graph = view(&root, &local, &manifest, &[], &Models::default()).unwrap();
    assert_eq!(graph["nodes"].as_array().unwrap().len(), 8);
    let task = graph["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|node| node["subtype"] == "task")
        .unwrap();
    assert_eq!(task["dueText"], "周五");
    assert_eq!(task["modality"], "planned");
    assert_eq!(task["citations"][0]["kind"], "meeting_summary");
    assert!(task["citations"][0].get("startMs").is_none());
    assert!(task["citations"][0]["positions"].as_array().unwrap().is_empty());
    assert!(manifest.artifacts.is_empty());
    let record = json!({"document":document,"markdown":document.markdown(),"artifacts":null});
    let artifact = std::env::var("LYNSE_GRAPH_LOCAL_RESULT").expect("local graph result path");
    fs::write(
        artifact,
        serde_json::to_vec_pretty(
            &json!({"graph":graph,"record":record,"health":health,"serviceUrl":origin}),
        )
        .unwrap(),
    )
    .unwrap();
    fs::remove_dir_all(root).unwrap();
    println!("Local HTTP -> Rust evidence validation -> graph storage passed; unauthorized/forged requests and unsupported evidence rejected.");
}

#[test]
fn automatic_details_follow_folder_scope_without_overwriting_legacy_selections() {
    let mut manifest=Manifest::default();
    manifest.wiki_automation=Some(store::WikiAutomation {folder_ids:vec!["work".into()],include_unfiled:false});
    let original=Tracking {selected_sources:BTreeSet::from(["legacy".into()]),..Default::default()};
    let effective=effective_tracking(&original,&manifest,&[summary(&doc())]);
    assert!(effective.enabled); assert!(effective.selected_sources.contains("one"));
    assert_eq!(original.selected_sources,BTreeSet::from(["legacy".into()])); assert!(!original.enabled);
    assert!(effective_tracking(&original,&manifest,&[]).selected_sources.is_empty());
}
