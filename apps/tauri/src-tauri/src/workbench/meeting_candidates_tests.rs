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

fn put_document(root: &Path, manifest: &mut Manifest, document: &mut Document) {
    document.refresh_revision();
    let entry = store::write_document(root, document, manifest.entries.get(&document.id)).unwrap();
    manifest.entries.insert(document.id.clone(), entry);
}

fn next_extraction(
    conn: &mut Connection,
    root: &Path,
    manifest: &Manifest,
    model: &Value,
) -> Option<(Document, Evidence, String)> {
    let existing = receipts(conn).unwrap();
    plan_extraction(conn, root, manifest, "scope", model, &existing).unwrap()
}

#[test]
fn planning_skips_completed_inputs_and_rebinds_only_metadata() {
    let root = temp_root();
    let mut conn = connection(&root).unwrap();
    let mut manifest = Manifest::default();
    let mut document = doc("m1", "原转写。");
    document.conclusions = vec![json!({"conclusionText": "已确认采用方案A"})];
    put_document(&root, &mut manifest, &mut document);
    let model = json!({"model": "m"});
    let (_, input, processor) = next_extraction(&mut conn, &root, &manifest, &model).unwrap();
    let mut candidate = item("已确认采用方案A", "decision");
    candidate["citations"][0]["revision"] = json!(document.revision);
    save_extraction(
        &mut conn,
        "scope",
        &document,
        &processor,
        &input,
        &[candidate],
    )
    .unwrap();

    // Already-receipted sources skip disk reads. Simulate an unavailable source file.
    let (_, file) = store::paths(&root, &document.id);
    let hidden = file.with_extension("hidden");
    fs::rename(&file, &hidden).unwrap();
    assert!(next_extraction(&mut conn, &root, &manifest, &model).is_none());
    fs::rename(hidden, file).unwrap();

    document.transcript = "修改转写，但纪要不变。".into();
    document.title = "新标题".into();
    put_document(&root, &mut manifest, &mut document);
    assert!(next_extraction(&mut conn, &root, &manifest, &model).is_none());
    assert_eq!(
        receipts(&conn).unwrap()["m1"].source_revision,
        document.revision
    );
    assert!(next_extraction(&mut conn, &root, &manifest, &json!({"model": "other"})).is_some());

    document.conclusions[0]["conclusionText"] = json!("改为方案B");
    put_document(&root, &mut manifest, &mut document);
    assert!(next_extraction(&mut conn, &root, &manifest, &model).is_some());
    cleanup(&root);
}

#[test]
fn current_legacy_receipts_are_reused_without_requeueing() {
    let root = temp_root();
    let mut conn = connection(&root).unwrap();
    let mut manifest = Manifest::default();
    let mut document = doc("m1", "方案A");
    document.conclusions = vec![json!({"conclusionText": "已确认采用方案A"})];
    put_document(&root, &mut manifest, &mut document);
    let model = json!({"model":"m"});
    let legacy = legacy_extraction_id("scope", &document, &model);
    record_receipt(&conn, "m1", &legacy, &document.revision).unwrap();
    queue_pending(&conn, "m1", &legacy).unwrap();
    conn.execute("UPDATE publish_queue SET state='done'", [])
        .unwrap();
    assert!(next_extraction(&mut conn, &root, &manifest, &model).is_none());
    assert_ne!(receipts(&conn).unwrap()["m1"].extraction_id, legacy);
    let state: String = conn
        .query_row("SELECT state FROM publish_queue", [], |row| row.get(0))
        .unwrap();
    assert_eq!(state, "done");
    cleanup(&root);
}

#[test]
fn candidate_receipt_and_outbox_commit_together() {
    let root = temp_root();
    let mut conn = connection(&root).unwrap();
    let mut document = doc("m1", "已确认采用方案A");
    document.refresh_revision();
    let input = evidence(&document).unwrap();
    conn.execute_batch("CREATE TRIGGER fail_outbox BEFORE INSERT ON publish_queue BEGIN SELECT RAISE(ABORT, 'test'); END;").unwrap();
    assert!(save_extraction(
        &mut conn,
        "scope",
        &document,
        "processor",
        &input,
        &[item("已确认采用方案A", "decision")]
    )
    .is_err());
    assert!(receipts(&conn).unwrap().is_empty());
    let count: i64 = conn
        .query_row("SELECT count(*) FROM candidate_entries", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 0);
    conn.execute("DROP TRIGGER fail_outbox", []).unwrap();
    save_extraction(&mut conn, "scope", &document, "processor", &input, &[]).unwrap();
    assert_eq!(receipts(&conn).unwrap().len(), 1);
    let state: String = conn
        .query_row("SELECT state FROM publish_queue", [], |row| row.get(0))
        .unwrap();
    assert_eq!(state, "pending");
    cleanup(&root);
}

// --- batch storage (2.3 + 2.4) ----------------------------------------------

#[test]
fn batches_are_idempotent_and_keep_human_status() {
    let root = temp_root();
    let conn = connection(&root).unwrap();
    let extraction = "ex-1";
    let stored = store_batch(
        &conn,
        "scope",
        "m1",
        "r1",
        "2026-11-12",
        extraction,
        &[
            item("已确认采用方案A", "decision"),
            item("预算仍未批准", "unresolved"),
        ],
    )
    .unwrap();
    assert_eq!(stored, 2);
    // Deterministic identity: rewording punctuation/spacing keeps the id.
    let again = store_batch(
        &conn,
        "scope",
        "m1",
        "r1",
        "2026-11-12",
        extraction,
        &[item("已确认  采用方案a。", "decision")],
    )
    .unwrap();
    assert_eq!(again, 1);
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM candidate_entries", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 2);
    // Human status survives a rerun; unsupported earlier candidates supersede.
    conn.execute(
        "UPDATE candidate_entries SET status='confirmed' WHERE kind='decision'",
        [],
    )
    .unwrap();
    store_batch(
        &conn,
        "scope",
        "m1",
        "r1",
        "2026-11-12",
        "ex-2",
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
        &conn,
        "scope",
        "m1",
        "r1",
        "2026-11-12",
        "ex-1",
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
        &conn,
        "scope",
        "m1",
        "r1",
        "2026-11-12",
        "ex-1",
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
fn removing_a_source_prunes_its_candidates_and_marks_the_view_dirty() {
    let root = temp_root();
    let mut conn = connection(&root).unwrap();
    let mut document = doc("m1", "已确认采用方案A");
    document.refresh_revision();
    save_extraction(
        &mut conn,
        "scope",
        &document,
        "processor",
        &evidence(&document).unwrap(),
        &[item("已确认采用方案A", "decision")],
    )
    .unwrap();
    let existing = receipts(&conn).unwrap();
    prune_sources(&mut conn, &Manifest::default(), &existing).unwrap();
    for table in ["candidate_entries", "publish_queue", "extraction_receipts"] {
        let count: i64 = conn
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0, "{table}");
    }
    assert!(render_pending(&conn).unwrap());
    cleanup(&root);
}

// --- L1/L2 rendering + external-edit preservation (2.4) ----------------------

#[test]
fn markdown_export_groups_days_and_preserves_external_edits() {
    let root = temp_root();
    let conn = connection(&root).unwrap();
    store_batch(
        &conn,
        "scope",
        "m1",
        "r1",
        "2026-11-12",
        "ex-1",
        &[item("已确认采用方案A", "decision")],
    )
    .unwrap();
    store_batch(
        &conn,
        "scope",
        "m2",
        "r1",
        "2026-11-10",
        "ex-1",
        &[item("客户希望月底交付", "observation")],
    )
    .unwrap();
    render_markdown(&conn, root.parent().unwrap()).unwrap();
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
    render_markdown(&conn, root.parent().unwrap()).unwrap();
    assert_eq!(fs::read_to_string(&target).unwrap(), first);
    // External edit: the user file is preserved, the fresh render is staged.
    fs::write(&target, "# 我的手工笔记\n").unwrap();
    render_markdown(&conn, root.parent().unwrap()).unwrap();
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
    render_markdown(&conn, root.parent().unwrap()).unwrap();
    let target = root
        .parent()
        .unwrap()
        .join("entries")
        .join("meeting-candidates.md");
    assert!(fs::read_to_string(&target)
        .unwrap()
        .contains("# 会议候选记忆"));
    // Backoff: within the window the planner may be skipped by the caller.
    record_failure(&conn, "m1").unwrap();
    assert_eq!(
        deferred_extractions(&conn).unwrap(),
        ["m1".to_owned()].into()
    );
    cleanup(&root);
}

// --- publication uplink ------------------------------------------------------

/// Shared fingerprint test vectors: the expected digests were computed by the
/// gateway's normalize_transcript (runtime/knowledge_proxy.py). Any change on
/// either side must keep these green and re-pin the other side in one release.
#[test]
fn transcript_fingerprint_matches_the_gateway_spec() {
    // Shared vectors: digests computed by the gateway normalize_transcript.
    let cases = [
        (
            "  第一行\n\n第二行  \n\n\n  第三行",
            "ae4f6df039c62b53932681965f7c478cc013f6f05c9ded1c881b56cb47c97fb2",
        ),
        (
            "会议开始\n我们最终决定采用方案A\n散会\n",
            "bf73b0ed29c91898e077c91ea229d4fd234b5663a22cf25c66db25c11d25eeb7",
        ),
        (
            "",
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        ),
        (
            "   \n  \n",
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        ),
        (
            "中文 内容 与 English mixed\r\nwindows 换行",
            "79034818544a75d77716ebfaf126118520d1b96b46748209824f1d0897edca3c",
        ),
    ];
    for (text, expected) in cases {
        assert_eq!(transcript_fingerprint(text), expected, "vector {text:?}");
    }
}

#[test]
fn summary_selection_matches_the_gateway_fingerprint_and_excludes_html_from_model_input() {
    let mut document = doc("m1", "冗长转写");
    document.conclusions = vec![
        json!({"conclusionText": "决定采用方案A"}),
        json!({"conclusionText": "决定采用方案A"}),
        json!({"content": "另一份摘要"}),
        json!({"conclusionText": "<html><p>Visual report</p></html>"}),
    ];
    let input = evidence(&document).unwrap();
    assert_eq!(input.text, "决定采用方案A\n\n决定采用方案A\n\n另一份摘要");
    assert_eq!(
        input.fingerprint,
        transcript_fingerprint(
            "决定采用方案A\n决定采用方案A\n另一份摘要\n<html><p>Visual report</p></html>"
        )
    );
    document.conclusions.clear();
    assert_eq!(evidence(&document).unwrap().text, "冗长转写");
    document.transcript.clear();
    assert!(evidence(&document).is_none());
}
