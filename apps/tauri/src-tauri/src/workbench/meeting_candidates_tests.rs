//! Candidate-store tests: extraction identity, idempotent batch storage,
//! human-status priority, metadata rebinds, eligibility cleanup, and the
//! preserve-external-edits Markdown export.
use super::*;
use serde_json::json;

/// The store root doubles as the wiki state dir; rendering writes to its
/// parent, so keep that parent inside this run's own temp tree.
fn temp_root() -> std::path::PathBuf {
    std::env::temp_dir()
        .join(uuid::Uuid::new_v4().to_string())
        .join("Meetings")
}

fn cleanup(root: &std::path::Path) {
    if let Some(parent) = root.parent() {
        let _ = std::fs::remove_dir_all(parent);
    }
}

fn doc(id: &str, transcript: &str) -> Document {
    Document {
        id: id.into(),
        kind: "meeting".into(),
        title: id.into(),
        created_at: "2026-11-12T10:00:00+08:00".into(),
        transcript: transcript.into(),
        segments: vec![json!({"id": "s1", "text": transcript, "startMs": 30_000, "endMs": 40_000})],
        ai_context_enabled: true,
        ..Default::default()
    }
}

fn item(text: &str, kind: &str) -> Value {
    json!({"text": text, "kind": kind, "citations": [
        {"id": "m1", "revision": "r1", "kind": "meeting", "quote": "已确认采用方案A", "segmentId": "s1", "startMs": 30_000, "endMs": 40_000}
    ]})
}

// --- extraction identity (2.2) ----------------------------------------------

#[test]
fn metadata_changes_do_not_move_the_extraction_identity() {
    let model = json!({"model": "m", "baseUrl": "https://provider.invalid"});
    let mut document = doc("m1", "已确认采用方案A。");
    let first = extraction_id("scope", &document, &model);
    // Metadata-only: title, folder, tags, timestamps, revision.
    document.title = "renamed".into();
    document.folder_id = "other".into();
    document.tags = vec!["x".into()];
    document.refresh_revision();
    assert_eq!(extraction_id("scope", &document, &model), first);
    // Effective input change: transcript moves the identity.
    document.transcript = "改为方案B。".into();
    assert_ne!(extraction_id("scope", &document, &model), first);
    // Model identity moves the identity.
    assert_ne!(
        extraction_id("scope", &document, &json!({"model": "other"})),
        extraction_id("scope", &document, &json!({"model": "m"}))
    );
    // Account scope is part of the identity.
    assert_ne!(
        extraction_id("other", &document, &model),
        extraction_id("scope", &document, &model)
    );
}

#[test]
fn planning_routes_extract_rebind_and_skip() {
    let model = json!({"model": "m"});
    let mut document = doc("m1", "已确认采用方案A。");
    document.refresh_revision();
    // No receipt: extract.
    assert!(matches!(
        plan_job("scope", &document.revision, &document, &model, None),
        Some(Job::Extract { .. })
    ));
    // Same receipt: skip entirely.
    let extraction = extraction_id("scope", &document, &model);
    let receipt = Some(ReceiptRow {
        extraction_id: extraction.clone(),
        source_revision: document.revision.clone(),
    });
    assert!(plan_job("scope", &document.revision, &document, &model, receipt.as_ref()).is_none());
    // Metadata-only revision change: rebind, no model call.
    let mut rebinding = document.clone();
    rebinding.folder_id = "moved".into();
    rebinding.refresh_revision();
    assert_ne!(rebinding.revision, document.revision);
    match plan_job("scope", &rebinding.revision, &rebinding, &model, receipt.as_ref()) {
        Some(Job::Rebind { from, to, .. }) => {
            assert_eq!(from, document.revision);
            assert_eq!(to, rebinding.revision);
        }
        other => panic!("expected rebind, got {other:?}"),
    }
    // Transcript backfill moves the identity: re-extract.
    let mut backfilled = document.clone();
    backfilled.transcript = "已确认采用方案A。追加决策记录。".into();
    backfilled.refresh_revision();
    assert!(matches!(
        plan_job("scope", &backfilled.revision, &backfilled, &model, receipt.as_ref()),
        Some(Job::Extract { .. })
    ));
}

// --- batch storage (2.3 + 2.4) ----------------------------------------------

#[test]
fn batches_are_idempotent_and_keep_human_status() {
    let root = temp_root();
    let conn = connection(&root).unwrap();
    let extraction = "ex-1";
    let stored = store_batch(
        &conn, "scope", "m1", "r1", "2026-11-12", extraction,
        &[item("已确认采用方案A", "decision"), item("预算仍未批准", "unresolved")],
    )
    .unwrap();
    assert_eq!(stored, 2);
    // Deterministic identity: rewording punctuation/spacing keeps the id.
    let again = store_batch(
        &conn, "scope", "m1", "r1", "2026-11-12", extraction,
        &[item("已确认  采用方案a。", "decision")],
    )
    .unwrap();
    assert_eq!(again, 1);
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM candidate_entries", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 2);
    // Human status survives a rerun; unsupported earlier candidates supersede.
    conn.execute(
        "UPDATE candidate_entries SET status='confirmed' WHERE kind='decision'",
        [],
    )
    .unwrap();
    store_batch(
        &conn, "scope", "m1", "r1", "2026-11-12", "ex-2",
        &[item("已确认采用方案A", "decision")],
    )
    .unwrap();
    let (status, extraction_id): (String, String) = conn
        .query_row(
            "SELECT status, extraction_id FROM candidate_entries WHERE kind='decision'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(status, "confirmed");
    assert_eq!(extraction_id, "ex-2");
    let unresolved: String = conn
        .query_row(
            "SELECT status FROM candidate_entries WHERE kind='unresolved'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(unresolved, "superseded");
    cleanup(&root);
}

#[test]
fn invalid_or_unsupported_items_are_dropped() {
    let root = temp_root();
    let conn = connection(&root).unwrap();
    let stored = store_batch(
        &conn, "scope", "m1", "r1", "2026-11-12", "ex-1",
        &[
            json!({"text": "  ", "kind": "decision"}),
            json!({"text": "no kind"}),
            json!({"text": " translated kind ", "kind": "决定"}),
            item("有效事实", "observation"),
        ],
    )
    .unwrap();
    assert_eq!(stored, 1);
    cleanup(&root);
}

// --- metadata rebind (2.2) ---------------------------------------------------

#[test]
fn rebind_updates_citation_revisions_without_touching_text() {
    let root = temp_root();
    let conn = connection(&root).unwrap();
    store_batch(
        &conn, "scope", "m1", "r1", "2026-11-12", "ex-1",
        &[item("已确认采用方案A", "decision")],
    )
    .unwrap();
    rebind_entries(&conn, "m1", "r1", "r2").unwrap();
    let citations: String = conn
        .query_row(
            "SELECT citations FROM candidate_entries WHERE source_id='m1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let value: Value = serde_json::from_str(&citations).unwrap();
    assert_eq!(value[0]["revision"], json!("r2"));
    assert_eq!(value[0]["startMs"], json!(30_000));
    let text: String = conn
        .query_row(
            "SELECT text FROM candidate_entries WHERE source_id='m1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(text, "已确认采用方案A");
    cleanup(&root);
}

// --- eligibility cleanup (2.2) ----------------------------------------------

#[test]
fn forgetting_a_source_purges_candidates_and_cancels_the_queue() {
    let root = temp_root();
    let conn = connection(&root).unwrap();
    store_batch(
        &conn, "scope", "m1", "r1", "2026-11-12", "ex-1",
        &[item("已确认采用方案A", "decision"), item("普通候选", "observation")],
    )
    .unwrap();
    queue_pending(&conn, "m1", "ex-1").unwrap();
    drop(conn);
    forget_source_entries(&root, "m1");
    let conn = connection(&root).unwrap();
    let candidates: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM candidate_entries WHERE source_id='m1' AND status IN ('candidate','superseded')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(candidates, 0);
    let queue: String = conn
        .query_row(
            "SELECT state FROM publish_queue WHERE source_id='m1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(queue, "cancelled");
    let receipt = receipt(&conn, "m1").unwrap();
    assert!(receipt.is_none());
    cleanup(&root);
}

// --- L1/L2 rendering + external-edit preservation (2.4) ----------------------

#[test]
fn markdown_export_groups_days_and_preserves_external_edits() {
    let root = temp_root();
    let conn = connection(&root).unwrap();
    store_batch(
        &conn, "scope", "m1", "r1", "2026-11-12", "ex-1",
        &[item("已确认采用方案A", "decision")],
    )
    .unwrap();
    store_batch(
        &conn, "scope", "m2", "r1", "2026-11-10", "ex-1",
        &[item("客户希望月底交付", "observation")],
    )
    .unwrap();
    drop(conn);
    render_markdown(&root).unwrap();
    let target = root
        .parent()
        .unwrap()
        .join("entries")
        .join("meeting-candidates.md");
    let first = fs::read_to_string(&target).unwrap();
    assert!(first.contains("## 2026-11-12"));
    assert!(first.contains("【决定】已确认采用方案A"));
    assert!(first.contains("已确认采用方案A") && first.contains("00:30"));
    // A second render with no change is a no-op.
    render_markdown(&root).unwrap();
    assert_eq!(fs::read_to_string(&target).unwrap(), first);
    // External edit: the user file is preserved, the fresh render is staged.
    fs::write(&target, "# 我的手工笔记\n").unwrap();
    render_markdown(&root).unwrap();
    assert_eq!(fs::read_to_string(&target).unwrap(), "# 我的手工笔记\n");
    let incoming = root
        .parent()
        .unwrap()
        .join("entries")
        .join("meeting-candidates.incoming.md");
    let staged = fs::read_to_string(&incoming).unwrap();
    assert!(staged.contains("【决定】已确认采用方案A"));
    cleanup(&root);
}

#[test]
fn empty_days_render_without_entries_and_backoff_blocks_retry() {
    let root = temp_root();
    let conn = connection(&root).unwrap();
    render_markdown(&root).unwrap();
    let target = root
        .parent()
        .unwrap()
        .join("entries")
        .join("meeting-candidates.md");
    assert!(fs::read_to_string(&target).unwrap().contains("# 会议候选记忆"));
    // Backoff: within the window the planner may be skipped by the caller.
    record_failure(&root, "m1");
    let conn = connection(&root).unwrap();
    assert!(backoff_until(&conn, "m1").unwrap());
    assert!(!backoff_until(&conn, "missing").unwrap());
    cleanup(&root);
}
