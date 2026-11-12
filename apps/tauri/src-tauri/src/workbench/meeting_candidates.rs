//! Per-meeting candidate memory: the desktop distills project facts and
//! explicit decisions from each transcript into locally stored candidate
//! entries before anything is published. Entries live in a per-account
//! SQLite store, keyed by a stable identity so re-extraction of the same
//! content is idempotent; a receipt per source tracks the extraction
//! identity (account, source, effective input fingerprint, rules version,
//! model identity) so transcript backfills and body changes reprocess while
//! metadata-only changes merely rebind citation revisions. Nothing here is
//! publishable until the explicit confirmation flow (publication phase)
//! admits it; the pending queue only records what is ready to hand over.
use super::*;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const RULES_VERSION: &str = "meeting-candidates-v1";
const RETRY_BACKOFF_SECS: u64 = 600;
const MAX_RETRY_BACKOFF_SECS: u64 = 86_400;
const KINDS: [&str; 4] = ["observation", "proposal", "decision", "unresolved"];

const EXTRACT_QUERY: &str = "Extract durable project facts and explicit decisions from this meeting for the user's memory. Keep proposals as proposal, unresolved conflicts and open questions as unresolved, and negated or refused items as observation preserving the negation. Use kind decision only when the source states an explicit decision; a newer date alone never resolves a conflict. ";

// ---------------------------------------------------------------------------
// Store: per-account SQLite next to the wiki state.
// ---------------------------------------------------------------------------

fn db_path(root: &Path) -> PathBuf {
    root.join("memory-entries.sqlite")
}

fn connection(root: &Path) -> CommandResult<Connection> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let conn = Connection::open(db_path(root)).map_err(|e| e.to_string())?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS candidate_entries (
            id TEXT PRIMARY KEY, source_id TEXT NOT NULL, kind TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'candidate', text TEXT NOT NULL,
            event_date TEXT NOT NULL DEFAULT '', event_time_ms INTEGER,
            citations TEXT NOT NULL DEFAULT '[]',
            source_revision TEXT NOT NULL DEFAULT '',
            extraction_id TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '',
            superseded_by TEXT NOT NULL DEFAULT '', effective_until TEXT NOT NULL DEFAULT '');
        CREATE INDEX IF NOT EXISTS entries_source ON candidate_entries(source_id);
        CREATE INDEX IF NOT EXISTS entries_day ON candidate_entries(event_date);
        CREATE TABLE IF NOT EXISTS extraction_receipts (
            source_id TEXT PRIMARY KEY, extraction_id TEXT NOT NULL,
            source_revision TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '');
        CREATE TABLE IF NOT EXISTS extraction_backoff (
            source_id TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt_at INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS publish_queue (
            source_id TEXT PRIMARY KEY, extraction_id TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'pending',
            operation_id TEXT NOT NULL DEFAULT '',
            attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt_at INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL DEFAULT '');
        CREATE TABLE IF NOT EXISTS render_receipts (
            path TEXT PRIMARY KEY, hash TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '');",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

fn epoch_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .unwrap_or(0)
}

/// Casefolded normalization that ignores whitespace and punctuation: ASR
/// transcripts insert arbitrary spacing and models reword punctuation, so
/// the entry identity must not move when they do.
fn identity_char(ch: char) -> bool {
    !(ch.is_whitespace()
        || ch.is_ascii_punctuation()
        || matches!(
            ch,
            '。' | '，' | '、' | '；' | '：' | '！' | '？' | '·' | '…' | '—' | '‘' | '’' | '“'
                | '”' | '（' | '）' | '【' | '】' | '《' | '》' | '「' | '」' | '『' | '』' | '〔'
                | '〕' | '．' | '､' | '﹐' | '﹔'
        ))
}

fn normalize_text(text: &str) -> String {
    text.trim()
        .chars()
        .filter(|ch| identity_char(*ch))
        .flat_map(|ch| ch.to_lowercase())
        .collect()
}

fn entry_id(scope: &str, source_id: &str, kind: &str, normalized: &str) -> String {
    store::digest(json!(["meeting-candidate-v1", scope, source_id, kind, normalized]).to_string())
}

/// The extraction identity: rules version, account, source, effective input
/// fingerprint and model identity. Metadata-only changes never move it.
fn extraction_id(scope: &str, document: &Document, model_identity: &Value) -> String {
    let segments: Vec<Value> = document
        .segments
        .iter()
        .map(|segment| {
            json!([
                segment.get("id").cloned().unwrap_or(Value::Null),
                segment.get("text").cloned().unwrap_or(Value::Null),
                segment.get("startMs").cloned().unwrap_or(Value::Null),
                segment.get("endMs").cloned().unwrap_or(Value::Null),
            ])
        })
        .collect();
    store::digest(
        json!([
            RULES_VERSION,
            scope,
            document.id,
            document.text(),
            segments,
            model_identity,
        ])
        .to_string(),
    )
}

pub(super) struct ReceiptRow {
    pub extraction_id: String,
    pub source_revision: String,
}

fn receipt(conn: &Connection, source_id: &str) -> CommandResult<Option<ReceiptRow>> {
    let mut statement = conn
        .prepare("SELECT extraction_id, source_revision FROM extraction_receipts WHERE source_id=?1")
        .map_err(|e| e.to_string())?;
    let row = statement
        .query_row(params![source_id], |row| {
            Ok(ReceiptRow {
                extraction_id: row.get(0)?,
                source_revision: row.get(1)?,
            })
        })
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(row)
}

fn backoff_until(conn: &Connection, source_id: &str) -> CommandResult<bool> {
    let mut statement = conn
        .prepare("SELECT next_attempt_at FROM extraction_backoff WHERE source_id=?1")
        .map_err(|e| e.to_string())?;
    let next = statement
        .query_row(params![source_id], |row| row.get::<_, i64>(0))
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(next.is_some_and(|at| (epoch_secs() as i64) < at))
}

fn record_failure(root: &Path, source_id: &str) {
    let Ok(conn) = connection(root) else {
        return;
    };
    let attempts = conn
        .query_row(
            "SELECT attempts FROM extraction_backoff WHERE source_id=?1",
            params![source_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .ok()
        .flatten()
        .unwrap_or(0)
        + 1;
    let delay = RETRY_BACKOFF_SECS
        .saturating_mul(attempts as u64)
        .min(MAX_RETRY_BACKOFF_SECS);
    let _ = conn.execute(
        "INSERT INTO extraction_backoff (source_id, attempts, next_attempt_at) VALUES (?1,?2,?3)
         ON CONFLICT(source_id) DO UPDATE SET attempts=excluded.attempts, next_attempt_at=excluded.next_attempt_at",
        params![source_id, attempts, (epoch_secs() as i64) + delay as i64],
    );
}

fn clear_backoff(conn: &Connection, source_id: &str) {
    let _ = conn.execute("DELETE FROM extraction_backoff WHERE source_id=?1", params![source_id]);
}

/// Upsert one extraction batch. Confirmed and rejected entries keep their
/// human status; reproduced candidates update in place, and candidates the
/// new extraction no longer supports become superseded (still traceable).
fn store_batch(
    conn: &Connection,
    scope: &str,
    source_id: &str,
    source_revision: &str,
    event_date: &str,
    extraction: &str,
    items: &[Value],
) -> CommandResult<usize> {
    let mut stored = 0;
    for item in items {
        let kind = item
            .get("kind")
            .and_then(Value::as_str)
            .filter(|kind| KINDS.contains(kind));
        let text = item
            .get("text")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty());
        let (Some(kind), Some(text)) = (kind, text) else {
            continue;
        };
        let normalized = normalize_text(text);
        if normalized.is_empty() {
            continue;
        }
        let citations = item.get("citations").cloned().unwrap_or_else(|| json!([]));
        let event_time_ms = citations
            .as_array()
            .and_then(|refs| {
                refs.iter()
                    .find_map(|reference| reference.get("startMs").and_then(Value::as_i64))
            });
        let id = entry_id(scope, source_id, kind, &normalized);
        let existing_status: String = conn
            .query_row(
                "SELECT status FROM candidate_entries WHERE id=?1",
                params![id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or_default();
        // 人工修订与确认优先: a human decision is never demoted by a rerun.
        let status = match existing_status.as_str() {
            "confirmed" | "rejected" => existing_status.clone(),
            _ => "candidate".to_owned(),
        };
        let now = crate::now();
        conn.execute(
            "INSERT INTO candidate_entries (id, source_id, kind, status, text, event_date,
                event_time_ms, citations, source_revision, extraction_id, created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11)
             ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, status=excluded.status,
                text=excluded.text, event_date=excluded.event_date,
                event_time_ms=excluded.event_time_ms, citations=excluded.citations,
                source_revision=excluded.source_revision, extraction_id=excluded.extraction_id,
                updated_at=excluded.updated_at",
            params![
                id,
                source_id,
                kind,
                status,
                text,
                event_date,
                event_time_ms,
                citations.to_string(),
                source_revision,
                extraction,
                now,
            ],
        )
        .map_err(|e| e.to_string())?;
        stored += 1;
    }
    // The new receipt is authoritative: unsupported candidates from earlier
    // extractions step aside but stay traceable.
    conn.execute(
        "UPDATE candidate_entries SET status='superseded', updated_at=?3
         WHERE source_id=?1 AND extraction_id!=?2 AND status='candidate'",
        params![source_id, extraction, crate::now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(stored)
}

fn record_receipt(
    conn: &Connection,
    source_id: &str,
    extraction: &str,
    source_revision: &str,
) -> CommandResult<()> {
    conn.execute(
        "INSERT INTO extraction_receipts (source_id, extraction_id, source_revision, updated_at)
         VALUES (?1,?2,?3,?4)
         ON CONFLICT(source_id) DO UPDATE SET extraction_id=excluded.extraction_id,
            source_revision=excluded.source_revision, updated_at=excluded.updated_at",
        params![source_id, extraction, source_revision, crate::now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Metadata-only change: the effective input did not move, so citation
/// revisions are rebound to the new source revision without a model call.
fn rebind_entries(
    conn: &Connection,
    source_id: &str,
    from_revision: &str,
    to_revision: &str,
) -> CommandResult<()> {
    let mut statement = conn
        .prepare("SELECT id, citations FROM candidate_entries WHERE source_id=?1")
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, String)> = statement
        .query_map(params![source_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    for (id, citations) in rows {
        let Ok(mut value) = serde_json::from_str::<Value>(&citations) else {
            continue;
        };
        let mut changed = false;
        if let Some(refs) = value.as_array_mut() {
            for reference in refs.iter_mut() {
                if reference.get("revision").and_then(Value::as_str) == Some(from_revision) {
                    reference["revision"] = json!(to_revision);
                    changed = true;
                }
            }
        }
        if changed {
            conn.execute(
                "UPDATE candidate_entries SET citations=?2, source_revision=?3, updated_at=?4 WHERE id=?1",
                params![id, value.to_string(), to_revision, crate::now()],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Eligibility lost (AI off, conflict, deletion, scope removal): derived
/// content stops being used first, pending work is cancelled.
pub(super) fn forget_source_entries(root: &Path, source_id: &str) {
    let Ok(conn) = connection(root) else {
        return;
    };
    let _ = conn.execute(
        "DELETE FROM candidate_entries WHERE source_id=?1 AND status IN ('candidate','superseded')",
        params![source_id],
    );
    let _ = conn.execute(
        "UPDATE publish_queue SET state='cancelled', updated_at=?2 WHERE source_id=?1",
        params![source_id, crate::now()],
    );
    let _ = conn.execute("DELETE FROM extraction_receipts WHERE source_id=?1", params![source_id]);
    let _ = conn.execute("DELETE FROM extraction_backoff WHERE source_id=?1", params![source_id]);
}

fn queue_pending(conn: &Connection, source_id: &str, extraction: &str) -> CommandResult<()> {
    conn.execute(
        "INSERT INTO publish_queue (source_id, extraction_id, state, updated_at)
         VALUES (?1,?2,'pending',?3)
         ON CONFLICT(source_id) DO UPDATE SET extraction_id=excluded.extraction_id,
            state='pending', updated_at=excluded.updated_at",
        params![source_id, extraction, crate::now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// L1/L2 rendering: entries first, Markdown second, external edits preserved.
// ---------------------------------------------------------------------------

pub(super) struct DayView {
    pub event_date: String,
    pub rows: Vec<Value>,
}

pub(super) fn day_views(conn: &Connection) -> CommandResult<Vec<DayView>> {
    let mut statement = conn
        .prepare(
            "SELECT event_date, id, kind, status, text, citations FROM candidate_entries
             WHERE status IN ('candidate','confirmed') AND superseded_by=''
             ORDER BY event_date DESC, event_time_ms IS NULL, event_time_ms ASC, created_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                json!({
                    "id": row.get::<_, String>(1)?,
                    "kind": row.get::<_, String>(2)?,
                    "status": row.get::<_, String>(3)?,
                    "text": row.get::<_, String>(4)?,
                    "citations": serde_json::from_str::<Value>(&row.get::<_, String>(5)?)
                        .unwrap_or_else(|_| json!([])),
                }),
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut views: Vec<DayView> = Vec::new();
    for (event_date, row) in rows {
        match views.last_mut() {
            Some(view) if view.event_date == event_date => view.rows.push(row),
            _ => views.push(DayView {
                event_date,
                rows: vec![row],
            }),
        }
    }
    Ok(views)
}

fn render_entry(row: &Value) -> String {
    let kind_label = match row["kind"].as_str() {
        Some("decision") => "决定",
        Some("proposal") => "提议",
        Some("unresolved") => "未决",
        _ => "事实",
    };
    let mut line = format!("- 【{kind_label}】{}", row["text"].as_str().unwrap_or_default());
    if let Some(refs) = row["citations"].as_array() {
        let evidence: Vec<String> = refs
            .iter()
            .take(3)
            .map(|reference| {
                let time = reference
                    .get("startMs")
                    .and_then(Value::as_i64)
                    .map(|ms| {
                        let seconds = (ms / 1000).max(0);
                        format!(" · {:02}:{:02}", seconds / 60, seconds % 60)
                    })
                    .unwrap_or_default();
                format!(
                    "「{}」{}",
                    reference
                        .get("quote")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    time
                )
            })
            .collect();
        if !evidence.is_empty() {
            line.push_str(&format!("  证据:{}", evidence.join("；")));
        }
    }
    line.push_str("  <!--candidate:");
    line.push_str(row["id"].as_str().unwrap_or_default());
    line.push_str("-->");
    line
}

/// Render the L1 day view (plus the L2 confirmed section). An externally
/// edited file is preserved verbatim and the fresh render goes to a separate
/// incoming file for manual merging.
pub(super) fn render_markdown(root: &Path) -> CommandResult<()> {
    let Some(memory_root) = root.parent().map(Path::to_path_buf) else {
        return Ok(());
    };
    let relative = "entries/meeting-candidates.md";
    let target = memory::safe_path(&memory_root, relative)?;
    let incoming = memory::safe_path(&memory_root, "entries/meeting-candidates.incoming.md")?;
    let conn = connection(root)?;
    let views = day_views(&conn)?;
    let mut document = String::from("# 会议候选记忆\n\n待确认条目由桌面逐篇提炼；确认后才会进入发布与召回。\n");
    for view in &views {
        let day = if view.event_date.is_empty() {
            "未知日期"
        } else {
            &view.event_date
        };
        document.push_str(&format!("\n## {day}\n\n"));
        let confirmed = view
            .rows
            .iter()
            .filter(|row| row["status"] == "confirmed")
            .count();
        for row in &view.rows {
            if row["status"] == "confirmed" {
                document.push_str(&render_entry(row));
                document.push_str("（已确认）\n");
            } else {
                document.push_str(&render_entry(row));
                document.push('\n');
            }
        }
        if confirmed > 0 {
            document.push_str(&format!("\n本日已确认 {confirmed} 条。\n"));
        }
    }
    let receipt_hash: Option<String> = conn
        .query_row(
            "SELECT hash FROM render_receipts WHERE path=?1",
            params![relative],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let existing = fs::read(&target).ok();
    let externally_edited = match (&existing, &receipt_hash) {
        (Some(bytes), Some(hash)) => store::digest(bytes) != *hash,
        (Some(_), None) => true,
        (None, _) => false,
    };
    let write_target = if externally_edited { &incoming } else { &target };
    if externally_edited {
        log::warn!(
            "[meeting-candidates] externally edited export preserved; fresh render staged at {}",
            incoming.display()
        );
    }
    let bytes = document.as_bytes();
    if fs::read(write_target).is_ok_and(|previous| previous == bytes) {
        return Ok(());
    }
    fs::create_dir_all(write_target.parent().ok_or("Invalid memory path")?)
        .map_err(|e| e.to_string())?;
    crate::atomic_write(write_target, bytes).map_err(|e| e.to_string())?;
    if !externally_edited {
        conn.execute(
            "INSERT INTO render_receipts (path, hash, updated_at) VALUES (?1,?2,?3)
             ON CONFLICT(path) DO UPDATE SET hash=excluded.hash, updated_at=excluded.updated_at",
            params![relative, store::digest(bytes), crate::now()],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The extraction pass.
// ---------------------------------------------------------------------------

#[derive(Debug)]
enum Job {
    Extract {
        source_id: String,
        document: Document,
        extraction: String,
    },
    Rebind {
        source_id: String,
        extraction: String,
        from: String,
        to: String,
    },
}

fn plan_job(
    scope: &str,
    entry_revision: &str,
    document: &Document,
    model_identity: &Value,
    receipt: Option<&ReceiptRow>,
) -> Option<Job> {
    let extraction = extraction_id(scope, document, model_identity);
    match receipt {
        None => Some(Job::Extract {
            source_id: document.id.clone(),
            document: document.clone(),
            extraction,
        }),
        Some(prior) if prior.extraction_id != extraction => Some(Job::Extract {
            source_id: document.id.clone(),
            document: document.clone(),
            extraction,
        }),
        Some(prior) if prior.source_revision != entry_revision => Some(Job::Rebind {
            source_id: document.id.clone(),
            extraction: prior.extraction_id.clone(),
            from: prior.source_revision.clone(),
            to: entry_revision.to_owned(),
        }),
        _ => None,
    }
}

/// Wiki-lane follow-up: distill one eligible meeting per pass. Errors are
/// recorded as per-source backoff and never fail the lane.
pub(super) async fn run(
    app: &AppHandle,
    state: &WorkbenchState,
    session: &Session,
) -> CommandResult<()> {
    let manifest = load_state(app, session)?;
    if wiki::ready(&manifest).is_err() || session.model_override.is_none() {
        return Ok(());
    }
    let (root, _) = roots(app, session)?;
    let conn = connection(&root)?;
    let model_identity = wiki::model_cache_identity(session.model_override.as_ref().unwrap());
    let documents = wiki::sources_for(&root, &manifest);
    // 逐篇: pick the first source that actually owes work, in stable order.
    let mut planned: Option<Job> = None;
    for document in &documents {
        if document.transcript.trim().is_empty() {
            // 只有大纲的会议等待转写; memory tasks wait for the transcript.
            continue;
        }
        if backoff_until(&conn, &document.id)? {
            continue;
        }
        let prior = receipt(&conn, &document.id)?;
        if let Some(job) = plan_job(&session.scope, &document.revision, document, &model_identity, prior.as_ref()) {
            planned = Some(job);
            break;
        }
    }
    let Some(job) = planned else {
        return Ok(());
    };
    match job {
        Job::Rebind {
            source_id,
            extraction,
            from,
            to,
        } => {
            rebind_entries(&conn, &source_id, &from, &to)?;
            record_receipt(&conn, &source_id, &extraction, &to)?;
            log::info!("[meeting-candidates] rebound {source_id} to revision {to}");
            Ok(())
        }
        Job::Extract {
            source_id,
            document,
            extraction,
        } => {
            let source_revision = document.revision.clone();
            let event_date = document.created_at.chars().take(10).collect::<String>();
            let result = wiki::synthesize(
                app,
                session,
                "memory_extract",
                std::slice::from_ref(&document),
                Some(&(EXTRACT_QUERY.to_owned() + super::wiki::MEMORY_KIND_GUIDANCE)),
            )
            .await;
            let result = match result {
                Ok(value) => value,
                Err(error) => {
                    record_failure(&root, &source_id);
                    return Err(error);
                }
            };
            let items = result
                .get("memoryItems")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if result.get("insufficientEvidence").and_then(Value::as_bool) == Some(true)
                && items.is_empty()
            {
                // A stable empty receipt still counts: no re-spam per pass.
                record_receipt(&conn, &source_id, &extraction, &source_revision)?;
                log::info!("[meeting-candidates] no supported candidates for {source_id}");
                return Ok(());
            }
            let stored = store_batch(
                &conn,
                &session.scope,
                &source_id,
                &source_revision,
                &event_date,
                &extraction,
                &items,
            )?;
            record_receipt(&conn, &source_id, &extraction, &source_revision)?;
            clear_backoff(&conn, &source_id);
            queue_pending(&conn, &source_id, &extraction)?;
            drop(conn);
            render_markdown(&root)?;
            log::info!(
                "[meeting-candidates] distilled {stored} candidates from {source_id} (revision {})",
                &source_revision[..source_revision.len().min(8)]
            );
            Ok(())
        }
    }
}

#[cfg(test)]
#[path = "meeting_candidates_tests.rs"]
mod tests;
