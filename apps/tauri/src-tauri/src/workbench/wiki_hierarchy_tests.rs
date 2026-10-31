use super::*;

fn fixture() -> (PathBuf, PathBuf, Manifest, Vec<Topic>) {
    let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
    let local = root.join("sources");
    let mut manifest = Manifest::default();
    let mut values = Vec::new();
    for (id, title) in [
        ("meeting-a", "WiFi transfer"),
        ("meeting-b", "Offline transcription"),
    ] {
        let mut doc = Document {
            id: id.into(),
            kind: "meeting".into(),
            title: title.into(),
            transcript: "Friday remains tentative".into(),
            ai_context_enabled: true,
            ..Default::default()
        };
        doc.refresh_revision();
        let entry = store::write_document(&local, &doc, None).unwrap();
        manifest.entries.insert(id.into(), entry);
        let markdown = format!("# {title}\n\nFriday remains tentative");
        let topic = Topic {
            id: uuid::Uuid::new_v4().to_string(),
            title: title.into(),
            automatic_key: format!("auto:{id}"),
            notes: "Keep my correction".into(),
            pinned: id == "meeting-a",
            source_ids: vec![id.into()],
            last_fingerprint: "old-success".into(),
            published: Some(Revision {
                id: format!("page-{id}"),
                markdown: markdown.clone(),
                content_hash: store::digest(markdown),
                review: "approved".into(),
                overview: "Friday remains tentative".into(),
                citations: vec![SourceRef {
                    quote: doc.text().trim().into(),
                    ..doc.reference()
                }],
                ..Default::default()
            }),
            ..Default::default()
        };
        save_page(&root, &topic, topic.published.as_ref().unwrap(), false).unwrap();
        values.push(topic);
    }
    save_topics(&root, &values).unwrap();
    (root, local, manifest, values)
}

#[test]
fn manual_group_preserves_original_pages_reviews_notes_and_distinct_meetings() {
    let (root, local, manifest, mut values) = fixture();
    let originals = values.clone();
    let id=group(&root,&mut values,&json!({"ids":originals.iter().map(|t|&t.id).collect::<Vec<_>>(),"title":"Product development"})).unwrap();
    refresh(&root, &local, &manifest, "en").unwrap();
    let values = topics(&root).unwrap();
    let parent = values.iter().find(|t| t.id == id).unwrap();
    assert_eq!(parent.source_ids.len(), 2);
    assert_eq!(parent.collection.as_ref().unwrap().links.len(), 2);
    assert!(root.join(&id).join("published.md").exists());
    for original in originals {
        let child = values.iter().find(|t| t.id == original.id).unwrap();
        assert_eq!(
            serde_json::to_value(&child.published).unwrap(),
            serde_json::to_value(&original.published).unwrap()
        );
        assert_eq!(child.notes, original.notes);
        assert_eq!(child.pinned, original.pinned);
        assert_eq!(child.last_fingerprint, "old-success");
        assert!(child.grouping_manual);
    }
    let before = fs::read(root.join("topics.json")).unwrap();
    refresh(&root, &local, &manifest, "en").unwrap();
    assert_eq!(before, fs::read(root.join("topics.json")).unwrap());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn regroup_and_remove_are_persistent_decisions_without_deleting_topics() {
    let (root, local, manifest, mut values) = fixture();
    let child = values[0].id.clone();
    let other = values[1].id.clone();
    let a = group(
        &root,
        &mut values,
        &json!({"ids":[child,other],"title":"First"}),
    )
    .unwrap();
    let b = group(&root, &mut values, &json!({"ids":[child],"title":"Second"})).unwrap();
    assert_eq!(
        values
            .iter()
            .find(|t| t.id == a)
            .unwrap()
            .collection
            .as_ref()
            .unwrap()
            .links
            .iter()
            .find(|l| l.target_id == child)
            .unwrap()
            .state,
        "excluded"
    );
    let request = json!({"id":b,"targetId":child,"state":"excluded"});
    collections::edit_link(&mut values, &request).unwrap();
    manual_link(&mut values, &request).unwrap();
    save_topics(&root, &values).unwrap();
    refresh(&root, &local, &manifest, "en").unwrap();
    let values = topics(&root).unwrap();
    assert!(
        values
            .iter()
            .find(|t| t.id == child)
            .unwrap()
            .grouping_manual
    );
    assert!(values
        .iter()
        .find(|t| t.id == b)
        .unwrap()
        .published
        .is_none());
    assert_eq!(values.len(), 4);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn excluded_sources_are_removed_from_aggregate_quotes_and_counts() {
    let (root, local, mut manifest, mut values) = fixture();
    let ids: Vec<_> = values.iter().map(|t| t.id.clone()).collect();
    let id = group(&root, &mut values, &json!({"ids":ids,"title":"Product"})).unwrap();
    manifest.entries.get_mut("meeting-a").unwrap().excluded = true;
    refresh(&root, &local, &manifest, "en").unwrap();
    let values = topics(&root).unwrap();
    let parent = values.iter().find(|t| t.id == id).unwrap();
    assert!(!parent
        .published
        .as_ref()
        .unwrap()
        .citations
        .iter()
        .any(|r| r.id == "meeting-a"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn grouping_output_cannot_drop_duplicate_invent_or_nest_topics() {
    let good = json!({"groups":[{"title":"Product","existingId":null,"topicIds":["t0","t1"]}],"unassigned":["t2"]});
    assert!(validate(good.clone(), 3, 0).is_ok());
    for bad in [
        json!({"groups":[],"unassigned":["t0"]}),
        json!({"groups":[],"unassigned":["t0","t1","t1"]}),
        json!({"groups":[{"title":"Product","existingId":"g99","topicIds":["t0","t1"]}],"unassigned":["t2"]}),
        json!({"groups":[{"title":"Product","existingId":null,"topicIds":["t0"]}],"unassigned":["t1","t2"]}),
    ] {
        assert!(validate(bad, 3, 1).is_err());
    }
}

#[test]
fn metadata_is_bounded_and_grouping_versions_ignore_api_keys_and_unrelated_sources() {
    let (root, _, _, mut values) = fixture();
    let config = Models::default();
    let a = version(&values[0], "zh", &config);
    assert_ne!(a, version(&values[0], "en", &config));
    values[1].title = "Unrelated edit".into();
    assert_eq!(a, version(&values[0], "zh", &config));
    let metadata = metadata(&values[0], "t0");
    assert_eq!(metadata["id"], "t0");
    assert!(!metadata.to_string().contains("old-success"));
    let key = "completed-grouping";
    job(
        &root,
        key,
        "done",
        Some(&json!({"groups":[],"unassigned":["t0"]})),
        "",
    )
    .unwrap();
    assert!(receipt(&root, key).unwrap().is_some());
    job(&root, "failed", "failed", None, "offline").unwrap();
    assert!(receipt(&root, "failed").unwrap().is_none());
    fs::remove_dir_all(root).unwrap();
}
