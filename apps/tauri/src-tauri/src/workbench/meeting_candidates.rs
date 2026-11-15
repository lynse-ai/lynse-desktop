//! Distill one meeting at a time, checkpoint the result, and publish the pinned evidence.
use super::*;
#[path = "meeting_candidate_markdown.rs"]
mod markdown_view;
#[path = "meeting_candidate_publication.rs"]
mod publication;
use markdown_view::{mark_render_pending, render_markdown, render_pending};
pub(super) use publication::publish_pending;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

// Retain the rules version used by existing v3 receipts.
const RULES_VERSION: &str = "meeting-candidates-v3";
const RETRY_BACKOFF_SECS: i64 = 600;
const MAX_RETRY_BACKOFF_SECS: i64 = 86_400;
const KINDS: [&str; 4] = ["observation", "proposal", "decision", "unresolved"];

const EXTRACT_QUERY: &str = "Extract durable project facts and explicit decisions from this meeting for the user's memory. Keep proposals as proposal, unresolved conflicts and open questions as unresolved, and negated or refused items as observation preserving the negation. Use kind decision only when the source states an explicit decision; a newer date alone never resolves a conflict. Output budget: return at most 12 items total, cite at most 2 passages per item, and keep every quote under 120 characters; prefer dropping minor items over verbose output. ";

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
        CREATE TABLE IF NOT EXISTS extraction_inputs (
            source_id TEXT PRIMARY KEY, source_revision TEXT NOT NULL,
            processor TEXT NOT NULL, fingerprint TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS publish_queue (
            source_id TEXT PRIMARY KEY, extraction_id TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'pending',
            operation_id TEXT NOT NULL DEFAULT '',
            attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt_at INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL DEFAULT '');
        CREATE INDEX IF NOT EXISTS publish_due ON publish_queue(state, next_attempt_at);
        CREATE TABLE IF NOT EXISTS publication_attempts (
            source_id TEXT PRIMARY KEY, extraction_id TEXT NOT NULL, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS render_receipts (
            path TEXT PRIMARY KEY, hash TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '');
        CREATE TABLE IF NOT EXISTS publish_config (
            key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '');",
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
            '。' | '，'
                | '、'
                | '；'
                | '：'
                | '！'
                | '？'
                | '·'
                | '…'
                | '—'
                | '‘'
                | '’'
                | '“'
                | '”'
                | '（'
                | '）'
                | '【'
                | '】'
                | '《'
                | '》'
                | '「'
                | '」'
                | '『'
                | '』'
                | '〔'
                | '〕'
                | '．'
                | '､'
                | '﹐'
                | '﹔'
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

#[derive(Debug, PartialEq, Eq)]
struct Evidence {
    text: String,
    fingerprint: String,
}

fn evidence(document: &Document) -> Option<Evidence> {
    let summaries: Vec<_> = document
        .conclusions
        .iter()
        .filter_map(|item| {
            [
                "conclusionText",
                "content",
                "text",
                "summary",
                "conclusionContent",
            ]
            .into_iter()
            .filter_map(|key| item[key].as_str().map(str::trim))
            .find(|text| !text.is_empty())
        })
        .collect();
    let text = summaries
        .iter()
        .copied()
        .filter(|text| markdown::is_markdown(text))
        .collect::<Vec<_>>()
        .join("\n\n");
    if text.is_empty() {
        let transcript = document.transcript.trim();
        return (!transcript.is_empty() && markdown::is_markdown(transcript)).then(|| Evidence {
            text: transcript.to_owned(),
            fingerprint: transcript_fingerprint(transcript),
        });
    }
    Some(Evidence {
        text,
        fingerprint: transcript_fingerprint(&summaries.join("\n")),
    })
}

fn extraction_id(processor: &str, input: &Evidence) -> String {
    store::digest(json!([processor, input.fingerprint, input.text]).to_string())
}

#[derive(Debug)]
struct ReceiptRow {
    extraction_id: String,
    source_revision: String,
}

fn receipts(conn: &Connection) -> CommandResult<HashMap<String, ReceiptRow>> {
    let mut query = conn
        .prepare("SELECT source_id, extraction_id, source_revision FROM extraction_receipts")
        .map_err(|error| error.to_string())?;
    let rows = query
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                ReceiptRow {
                    extraction_id: row.get(1)?,
                    source_revision: row.get(2)?,
                },
            ))
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<_, _>>()
        .map_err(|error| error.to_string())
}

fn scanned_revisions(conn: &Connection, processor: &str) -> CommandResult<HashMap<String, String>> {
    let mut query = conn
        .prepare("SELECT source_id, source_revision FROM extraction_inputs WHERE processor=?1")
        .map_err(|error| error.to_string())?;
    let rows = query
        .query_map([processor], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<_, _>>()
        .map_err(|error| error.to_string())
}

fn record_input(
    conn: &Connection,
    document: &Document,
    processor: &str,
    fingerprint: &str,
) -> CommandResult<()> {
    conn.execute(
        "INSERT INTO extraction_inputs (source_id, source_revision, processor, fingerprint)
         VALUES (?1,?2,?3,?4)
         ON CONFLICT(source_id) DO UPDATE SET source_revision=excluded.source_revision,
            processor=excluded.processor, fingerprint=excluded.fingerprint",
        params![document.id, document.revision, processor, fingerprint],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

// Recognize valid v3 receipts once. Their key included the entire document;
// matching it lets existing batches adopt the content key without a model call.
fn legacy_extraction_id(scope: &str, document: &Document, model: &Value) -> String {
    let segments: Vec<_> = document
        .segments
        .iter()
        .map(|segment| {
            json!([
                segment["id"],
                segment["text"],
                segment["startMs"],
                segment["endMs"]
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
            model
        ])
        .to_string(),
    )
}

fn legacy_evidence_matches(document: &Document, input: &Evidence) -> bool {
    let mut parts: Vec<_> = document
        .conclusions
        .iter()
        .filter_map(|item| item["conclusionText"].as_str())
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .collect();
    parts.dedup();
    let text = if parts.is_empty() {
        document.transcript.trim().to_owned()
    } else {
        parts.join("\n\n")
    };
    transcript_fingerprint(&text) == input.fingerprint
}

fn deferred_extractions(conn: &Connection) -> CommandResult<std::collections::HashSet<String>> {
    let mut statement = conn
        .prepare("SELECT source_id FROM extraction_backoff WHERE next_attempt_at>?1")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([epoch_secs()], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

fn record_failure(conn: &Connection, source_id: &str) -> CommandResult<()> {
    conn.execute(
        "INSERT INTO extraction_backoff (source_id, attempts, next_attempt_at) VALUES (?1,1,?2+?3)
         ON CONFLICT(source_id) DO UPDATE SET attempts=attempts+1,
            next_attempt_at=?2+MIN(?3*(attempts+1),?4)",
        params![
            source_id,
            epoch_secs(),
            RETRY_BACKOFF_SECS,
            MAX_RETRY_BACKOFF_SECS
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

/// Defer without burning an attempt: cloud/auth outages are not evidence the
/// source is bad, so a long offline stretch must not push healthy sources
/// toward the 24h backoff ceiling.
fn defer_transient(conn: &Connection, source_id: &str, delay: i64) -> CommandResult<()> {
    conn.execute(
        "INSERT INTO extraction_backoff (source_id, attempts, next_attempt_at) VALUES (?1,0,?2+?3)
         ON CONFLICT(source_id) DO UPDATE SET next_attempt_at=MAX(next_attempt_at, ?2+?3)",
        params![source_id, epoch_secs(), delay],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
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
    let now = crate::now();
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
        let event_time_ms = citations.as_array().and_then(|refs| {
            refs.iter()
                .find_map(|reference| reference.get("startMs").and_then(Value::as_i64))
        });
        let id = entry_id(scope, source_id, kind, &normalized);
        conn.execute(
            "INSERT INTO candidate_entries (id, source_id, kind, status, text, event_date,
                event_time_ms, citations, source_revision, extraction_id, created_at, updated_at)
             VALUES (?1,?2,?3,'candidate',?4,?5,?6,?7,?8,?9,?10,?10)
             ON CONFLICT(id) DO UPDATE SET
                status=CASE WHEN candidate_entries.status IN ('confirmed','rejected')
                    THEN candidate_entries.status ELSE excluded.status END,
                text=excluded.text, event_date=excluded.event_date,
                event_time_ms=excluded.event_time_ms, citations=excluded.citations,
                source_revision=excluded.source_revision, extraction_id=excluded.extraction_id,
                updated_at=excluded.updated_at",
            params![
                id,
                source_id,
                kind,
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
        params![source_id, extraction, now],
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

fn forget_source_entries(conn: &Connection, source_id: &str) -> CommandResult<()> {
    conn.execute(
        "DELETE FROM candidate_entries WHERE source_id=?1 AND status IN ('candidate','superseded')",
        [source_id],
    )
    .map_err(|error| error.to_string())?;
    conn.execute("DELETE FROM publish_queue WHERE source_id=?1", [source_id])
        .map_err(|error| error.to_string())?;
    conn.execute(
        "DELETE FROM publication_attempts WHERE source_id=?1",
        [source_id],
    )
    .map_err(|error| error.to_string())?;
    conn.execute(
        "DELETE FROM extraction_receipts WHERE source_id=?1",
        [source_id],
    )
    .map_err(|error| error.to_string())?;
    conn.execute(
        "DELETE FROM extraction_backoff WHERE source_id=?1",
        [source_id],
    )
    .map_err(|error| error.to_string())?;
    conn.execute(
        "DELETE FROM extraction_inputs WHERE source_id=?1",
        [source_id],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub(super) fn withdraw_source(root: &Path, source_id: &str) -> CommandResult<()> {
    if db_path(root).is_file() {
        let mut conn = connection(root)?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        forget_source_entries(&tx, source_id)?;
        mark_render_pending(&tx)?;
        tx.commit().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn queue_pending(conn: &Connection, source_id: &str, extraction: &str) -> CommandResult<()> {
    conn.execute(
        "INSERT INTO publish_queue (source_id, extraction_id, state, updated_at)
         VALUES (?1,?2,'pending',?3)
         ON CONFLICT(source_id) DO UPDATE SET extraction_id=excluded.extraction_id,
            state='pending', operation_id='', attempts=0, next_attempt_at=0, updated_at=excluded.updated_at",
        params![source_id, extraction, crate::now()],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM publication_attempts WHERE source_id=?1",
        [source_id],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Publication uplink: the desktop publishes each distilled meeting to the
// gateway, which re-verifies the transcript fingerprint and every citation
// against the business cloud before the write transaction runs.
// ---------------------------------------------------------------------------

/// Shared transcript normalization for publication fingerprints. Byte-for-
/// byte parity with the gateway's `normalize_transcript` (runtime/
/// knowledge_proxy.py): strip each line, drop empties, join with single
/// newlines. The fingerprint test vectors below pin both sides together.
fn normalize_transcript(text: &str) -> String {
    text.split([
        '\r', '\n', '\x0b', '\x0c', '\x1c', '\x1d', '\x1e', '\u{85}', '\u{2028}', '\u{2029}',
    ])
    .map(str::trim)
    .filter(|line| !line.is_empty())
    .collect::<Vec<_>>()
    .join("\n")
}

fn transcript_fingerprint(text: &str) -> String {
    store::digest(normalize_transcript(text))
}

fn config_get(conn: &Connection, key: &str) -> CommandResult<Option<String>> {
    conn.query_row(
        "SELECT value FROM publish_config WHERE key=?1",
        [key],
        |row| row.get(0),
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn config_set(conn: &Connection, key: &str, value: &str) -> CommandResult<()> {
    conn.execute(
        "INSERT INTO publish_config (key, value, updated_at) VALUES (?1,?2,?3)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
        params![key, value, crate::now()],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// The extraction pass.
// ---------------------------------------------------------------------------

fn is_meeting(entry: &store::Entry) -> bool {
    store::eligible(entry) && entry.kind == "meeting"
}

fn allowed(document: &Document, manifest: &Manifest) -> bool {
    document.ai_context_enabled && wiki::allows_source(document, manifest)
}

fn save_extraction(
    conn: &mut Connection,
    scope: &str,
    document: &Document,
    processor: &str,
    input: &Evidence,
    items: &[Value],
) -> CommandResult<()> {
    let extraction = extraction_id(processor, input);
    let date = document.created_at.chars().take(10).collect::<String>();
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    store_batch(
        &tx,
        scope,
        &document.id,
        &document.revision,
        &date,
        &extraction,
        items,
    )?;
    record_receipt(&tx, &document.id, &extraction, &document.revision)?;
    record_input(&tx, document, processor, &input.fingerprint)?;
    tx.execute(
        "DELETE FROM extraction_backoff WHERE source_id=?1",
        [&document.id],
    )
    .map_err(|error| error.to_string())?;
    queue_pending(&tx, &document.id, &extraction)?;
    mark_render_pending(&tx)?;
    tx.commit().map_err(|error| error.to_string())
}

fn reuse_extraction(
    conn: &mut Connection,
    document: &Document,
    processor: &str,
    input: &Evidence,
    previous: &ReceiptRow,
) -> CommandResult<()> {
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let id = &document.id;
    let extraction = extraction_id(processor, input);
    let date = document.created_at.chars().take(10).collect::<String>();
    rebind_entries(&tx, id, &previous.source_revision, &document.revision)?;
    let changed = tx
        .execute(
            "UPDATE candidate_entries SET extraction_id=?3, event_date=?4
         WHERE source_id=?1 AND extraction_id=?2 AND (event_date!=?4 OR extraction_id!=?3)",
            params![id, previous.extraction_id, extraction, date],
        )
        .map_err(|error| error.to_string())?;
    tx.execute(
        "UPDATE publish_queue SET extraction_id=?3 WHERE source_id=?1 AND extraction_id=?2",
        params![id, previous.extraction_id, extraction],
    )
    .map_err(|error| error.to_string())?;
    tx.execute(
        "UPDATE publication_attempts SET extraction_id=?3 WHERE source_id=?1 AND extraction_id=?2",
        params![id, previous.extraction_id, extraction],
    )
    .map_err(|error| error.to_string())?;
    record_receipt(&tx, id, &extraction, &document.revision)?;
    record_input(&tx, document, processor, &input.fingerprint)?;
    if changed != 0 {
        mark_render_pending(&tx)?;
    }
    tx.commit().map_err(|error| error.to_string())
}

fn plan_extraction(
    conn: &mut Connection,
    root: &Path,
    manifest: &Manifest,
    scope: &str,
    model: &Value,
    receipts: &HashMap<String, ReceiptRow>,
) -> CommandResult<Option<(Document, Evidence, String)>> {
    let model = wiki::model_cache_identity(model);
    let processor = store::digest(json!([RULES_VERSION, model]).to_string());
    let scanned = scanned_revisions(conn, &processor)?;
    let deferred = deferred_extractions(conn)?;
    for entry in manifest.entries.values().filter(|entry| is_meeting(entry)) {
        if scanned.get(&entry.id) == Some(&entry.revision) || deferred.contains(&entry.id) {
            continue;
        }
        let Ok(raw) = store::read_document(root, entry) else {
            continue;
        };
        if !allowed(&raw, manifest) {
            continue;
        }
        let Some(input) = evidence(&raw) else {
            record_input(conn, &raw, &processor, "")?;
            continue;
        };
        let document = raw;
        let extraction = extraction_id(&processor, &input);
        if let Some(previous) = receipts.get(&entry.id).filter(|previous| {
            previous.extraction_id == extraction
                || (previous.source_revision == entry.revision
                    && markdown::source(document.clone()).is_some_and(|legacy| {
                        previous.extraction_id == legacy_extraction_id(scope, &legacy, &model)
                            && legacy_evidence_matches(&legacy, &input)
                    }))
        }) {
            reuse_extraction(conn, &document, &processor, &input, previous)?;
            continue;
        }
        return Ok(Some((document, input, processor)));
    }
    Ok(None)
}

fn prune_sources(
    conn: &mut Connection,
    manifest: &Manifest,
    active: &HashMap<String, ReceiptRow>,
) -> CommandResult<()> {
    let removed: Vec<_> = active
        .keys()
        .filter(|id| !manifest.entries.get(*id).is_some_and(is_meeting))
        .collect();
    if removed.is_empty() {
        return Ok(());
    }
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    for id in removed {
        forget_source_entries(&tx, id)?;
    }
    mark_render_pending(&tx)?;
    tx.commit().map_err(|error| error.to_string())
}

pub(super) async fn extract_pending(
    app: &AppHandle,
    state: &WorkbenchState,
    session: &Session,
) -> CommandResult<bool> {
    let (root, document, input, processor) = {
        let _guard = state.serial.lock().await;
        require_current(state, session)?;
        let manifest = load_state(app, session)?;
        if !manifest.enabled {
            return Ok(false);
        }
        let (root, memory_root) = roots(app, session)?;
        let model = session
            .model_override
            .as_ref()
            .filter(|_| wiki::ready(&manifest).is_ok());
        if model.is_none() && !db_path(&root).is_file() {
            return Ok(false);
        }
        let mut conn = connection(&root)?;
        let receipts = receipts(&conn)?;
        prune_sources(&mut conn, &manifest, &receipts)?;
        let job = model
            .map(|model| {
                plan_extraction(
                    &mut conn,
                    &root,
                    &manifest,
                    &session.scope,
                    model,
                    &receipts,
                )
            })
            .transpose()?
            .flatten();
        if render_pending(&conn)? {
            if let Err(error) = render_markdown(&conn, &memory_root) {
                log::warn!("[meeting-candidates] Markdown export deferred: {error}");
            }
        }
        let Some((document, input, processor)) = job else {
            return Ok(false);
        };
        (root, document, input, processor)
    };

    let source = json!({
        "id": document.id, "revision": document.revision, "kind": document.kind,
        "title": document.title, "text": input.text.chars().take(12_000).collect::<String>(),
        "segments": [],
    });
    let result = wiki::synthesize_source(
        app,
        session,
        "memory_extract",
        source,
        &(EXTRACT_QUERY.to_owned() + wiki::MEMORY_KIND_GUIDANCE),
    )
    .await;
    let _guard = state.serial.lock().await;
    require_current(state, session)?;
    if wiki::require_task_model(state, session, "memory_extract").is_err()
        || matches!(result.as_ref(), Err(error) if error == wiki::TEXT_MODEL_CHANGED)
    {
        return Ok(true);
    }
    let manifest = load_state(app, session)?;
    if wiki::ready(&manifest).is_err()
        || !manifest.entries.get(&document.id).is_some_and(|entry| {
            is_meeting(entry)
                && entry.revision == document.revision
                && store::read_document(&root, entry).is_ok()
        })
        || !allowed(&document, &manifest)
    {
        return Ok(false);
    }
    let mut conn = connection(&root)?;
    let items = match result
        .as_ref()
        .map(|result| result["memoryItems"].as_array())
    {
        Ok(Some(items)) => items,
        Ok(None) => {
            record_failure(&conn, &document.id)?;
            log::warn!("[meeting-candidates] model returned no candidate list");
            return Ok(true);
        }
        Err(error) => {
            // Cloud/auth outages defer the pass without counting against the
            // source; only model or protocol failures burn backoff attempts.
            if super::knowledge_transport::transient(&error) {
                defer_transient(&conn, &document.id, RETRY_BACKOFF_SECS)?;
            } else {
                record_failure(&conn, &document.id)?;
            }
            log::warn!("[meeting-candidates] extraction deferred: {error}");
            return Ok(true);
        }
    };
    save_extraction(
        &mut conn,
        &session.scope,
        &document,
        &processor,
        &input,
        items,
    )?;
    state.publication_wakeup.notify_one();
    Ok(true)
}

#[cfg(test)]
#[path = "meeting_candidates_tests.rs"]
mod tests;
