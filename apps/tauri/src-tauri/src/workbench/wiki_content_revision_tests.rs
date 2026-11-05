use super::*;

#[test]
fn progress_and_receipts_do_not_invalidate_browsing_but_content_and_permissions_do() {
    let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
    let memory = root.join("memory");
    let settings = root.join("settings");
    fs::create_dir_all(memory.join("wiki")).unwrap();
    let mut state = Manifest::default();
    let original = wiki_content_revision(&memory, &settings, &state);
    state.phase = "processing".into();
    state.updated_at = "new-progress".into();
    state.wiki_progress = Some(store::WikiProgress {
        stage: "compiling".into(),
        completed: 5,
        total: 100,
        ..Default::default()
    });
    state
        .knowledge_events
        .insert("topic".into(), "delivered".into());
    assert_eq!(wiki_content_revision(&memory, &settings, &state), original);
    fs::write(memory.join("wiki/topics.json"), "[]").unwrap();
    let content = wiki_content_revision(&memory, &settings, &state);
    assert_ne!(content, original);
    state.allow_ai = true;
    assert_ne!(wiki_content_revision(&memory, &settings, &state), content);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn source_failure_preserves_wiki_progress_and_remains_visible_after_wiki_completion() {
    let mut state = Manifest {
        phase: "processing".into(),
        ..Default::default()
    };
    record_source_error(&mut state, "Source server unavailable".into());
    assert_eq!(state.phase, "processing");
    assert!(state.error.is_empty());
    state.phase = "ready".into();
    let session = Session {
        scope: "account".into(),
        user_id: "user".into(),
        base_url: String::new(),
        agent_url: String::new(),
        model_override: None,
        token: String::new(),
        generation: 1,
        locale: "en".into(),
    };
    assert_eq!(
        public_status(&session, &state)["error"],
        "Source server unavailable"
    );
}
