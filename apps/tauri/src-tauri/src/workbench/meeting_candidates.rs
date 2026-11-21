//! Distill one meeting at a time, checkpoint the result, and publish the pinned evidence.
use super::*;
#[path = "meeting_candidate_markdown.rs"]
mod markdown_view;
#[path = "meeting_candidate_publication.rs"]
mod publication;
#[path = "memory_consolidation.rs"]
mod consolidation;

/// Lane entry for the nightly dreaming pass; the implementation lives in the
/// consolidation submodule.
pub(super) async fn run_consolidation(
    app: &AppHandle,
    state: &WorkbenchState,
    session: &Session,
) -> CommandResult<bool> {
    consolidation::run_consolidation(app, state, session).await
}
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

// v4 injects the scope purpose into the extraction query; existing v3
// receipts no longer match, which drives the rate-limited re-extraction sweep.
const RULES_VERSION: &str = "meeting-candidates-v4";
const RETRY_BACKOFF_SECS: i64 = 600;
const MAX_RETRY_BACKOFF_SECS: i64 = 86_400;
const KINDS: [&str; 4] = ["observation", "proposal", "decision", "unresolved"];
/// Purpose injection budget inside the extraction query. The stored setting
/// allows 8,000 characters; only this bound amount steers one extraction.
const PURPOSE_QUERY_CHARS: usize = 2_000;

const EXTRACT_QUERY: &str = "Extract durable project facts and explicit decisions from this meeting for the user's memory. Keep proposals as proposal, unresolved conflicts and open questions as unresolved, and negated or refused items as observation preserving the negation. Use kind decision only when the source states an explicit decision; a newer date alone never resolves a conflict. Output budget: return at most 12 items total, cite at most 2 passages per item, and keep every quote under 120 characters; prefer dropping minor items over verbose output. ";

// ---------------------------------------------------------------------------
// Store: per-account SQLite next to the wiki state.
// ---------------------------------------------------------------------------

fn db_path(root: &Path) -> PathBuf {
    root.join("memory-entries.sqlite")
}

pub(super) fn connection(root: &Path) -> CommandResult<Connection> {
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
            superseded_by TEXT NOT NULL DEFAULT '', effective_until TEXT NOT NULL DEFAULT '',
            lane TEXT NOT NULL DEFAULT 'meeting');
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
            key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '');
        CREATE TABLE IF NOT EXISTS consolidation_overlays (
            id TEXT PRIMARY KEY, target_id TEXT NOT NULL, kind TEXT NOT NULL,
            supersede_by TEXT NOT NULL DEFAULT '', corrected_text TEXT NOT NULL DEFAULT '',
            reason TEXT NOT NULL DEFAULT '', batch_id TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT '', revoked_at TEXT NOT NULL DEFAULT '',
            original_digest TEXT NOT NULL DEFAULT '');
        CREATE INDEX IF NOT EXISTS overlays_target ON consolidation_overlays(target_id);",
    )
    .map_err(|e| e.to_string())?;
    // Lanes were added after v3 shipped: existing databases keep their rows
    // under the default meeting lane via the ALTER below.
    let has_lane: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('candidate_entries') WHERE name='lane'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count > 0)
        .map_err(|e| e.to_string())?;
    if !has_lane {
        conn.execute(
            "ALTER TABLE candidate_entries ADD COLUMN lane TEXT NOT NULL DEFAULT 'meeting'",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
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

/// Entry identity is namespaced per lane: meeting rows keep the v1 salt that
/// existing databases (and the cloud canonical_key scheme) were built on, so
/// a wiki-lane row with identical text can never collide with — and overwrite
/// — the meeting row's `extraction_id` through ON CONFLICT.
fn entry_id(scope: &str, source_id: &str, kind: &str, normalized: &str, lane: &str) -> String {
    store::digest(
        json!([format!("{lane}-candidate-v1"), scope, source_id, kind, normalized]).to_string(),
    )
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
/// Supersede and identity are lane-scoped: the meeting and wiki pipelines
/// harvest the same meetings independently and must never overwrite or step
/// aside for each other. Any stored or superseded row marks both local
/// projections pending in the same transaction, so the Markdown views can
/// never drift behind the store.
fn store_batch(
    conn: &Connection,
    scope: &str,
    source_id: &str,
    source_revision: &str,
    event_date: &str,
    extraction: &str,
    lane: &str,
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
        let id = entry_id(scope, source_id, kind, &normalized, lane);
        conn.execute(
            "INSERT INTO candidate_entries (id, source_id, kind, status, text, event_date,
                event_time_ms, citations, source_revision, extraction_id, created_at, updated_at, lane)
             VALUES (?1,?2,?3,'candidate',?4,?5,?6,?7,?8,?9,?10,?10,?11)
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
                lane,
            ],
        )
        .map_err(|e| e.to_string())?;
        stored += 1;
    }
    // The new receipt is authoritative: unsupported candidates from earlier
    // extractions step aside but stay traceable — within this lane only.
    let superseded = conn
        .execute(
            "UPDATE candidate_entries SET status='superseded', updated_at=?3
             WHERE source_id=?1 AND lane=?2 AND extraction_id!=?4 AND status='candidate'",
            params![source_id, lane, now, extraction],
        )
        .map_err(|e| e.to_string())?;
    if stored > 0 || superseded > 0 {
        mark_render_pending(conn)?;
        set_projection_pending(conn)?;
    }
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
        set_projection_pending(&tx)?;
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

pub(super) fn config_get(conn: &Connection, key: &str) -> CommandResult<Option<String>> {
    conn.query_row(
        "SELECT value FROM publish_config WHERE key=?1",
        [key],
        |row| row.get(0),
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub(super) fn config_set(conn: &Connection, key: &str, value: &str) -> CommandResult<()> {
    conn.execute(
        "INSERT INTO publish_config (key, value, updated_at) VALUES (?1,?2,?3)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
        params![key, value, crate::now()],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Wiki-lane harvest: shared source_analysis memory items become local
// candidates in their own lane.
// ---------------------------------------------------------------------------

/// Memory-item cap per source per harvest, mirroring the meeting lane's
/// extraction budget. This is a mechanical batch bound, not a significance
/// rule — what to keep stays the model's call.
pub(super) const WIKI_HARVEST_CAP: usize = 12;

/// One source's aggregated harvest payload. All chunks of a document converge
/// on a single per-source extraction id, so a re-harvest replaces the whole
/// batch in one transaction instead of per-chunk batches superseding each
/// other's rows.
#[derive(Clone)]
pub(super) struct WikiHarvest {
    pub(super) source_id: String,
    pub(super) source_revision: String,
    pub(super) event_date: String,
    pub(super) extraction: String,
    pub(super) items: Vec<Value>,
}

pub(super) fn wiki_extraction_id(
    scope: &str,
    source_id: &str,
    source_revision: &str,
    processor_revision: &str,
) -> String {
    store::digest(
        json!([
            "wiki-candidate-extraction-v1",
            scope,
            source_id,
            source_revision,
            processor_revision
        ])
        .to_string(),
    )
}

/// Persist a wiki harvest. Idempotent by content identity; a zero-item source
/// is a legal empty result, and store_batch owns the pending-flag bookkeeping
/// for any stored or superseded row. The per-source cap truncates here so
/// every harvest path shares the same mechanical bound.
pub(super) fn store_wiki_harvest(
    meetings_root: &Path,
    scope: &str,
    sources: &[WikiHarvest],
) -> CommandResult<usize> {
    let mut conn = connection(meetings_root)?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let mut stored = 0;
    for source in sources {
        stored += store_batch(
            &tx,
            scope,
            &source.source_id,
            &source.source_revision,
            &source.event_date,
            &source.extraction,
            "wiki",
            &source.items[..source.items.len().min(WIKI_HARVEST_CAP)],
        )?;
    }
    tx.commit().map_err(|error| error.to_string())?;
    Ok(stored)
}

// ---------------------------------------------------------------------------
// Replayable local projection: candidate rows -> manifest.memories -> views.
// ---------------------------------------------------------------------------

/// Writers bump an epoch; the projection records the epoch it reconciled and
/// acknowledges exactly that value. A write landing between the row read and
/// the acknowledge therefore keeps the projection pending instead of being
/// silently cleared with the rest.
fn set_projection_pending(conn: &Connection) -> CommandResult<()> {
    let current: i64 = config_get(conn, "projection_epoch")?
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    config_set(conn, "projection_epoch", &(current + 1).to_string())
}

fn projection_pending(conn: &Connection) -> CommandResult<(bool, i64)> {
    let epoch: i64 = config_get(conn, "projection_epoch")?
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let ack: i64 = config_get(conn, "projection_ack")?
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    Ok((epoch > ack, epoch))
}

/// Pure reconciliation between the candidate store and the manifest memory
/// list. Items the projection manages (ids present in the store) refresh from
/// the store; ids that left the active set are dropped unless a human flag
/// keeps them (then stale). Items whose evidence no longer matches the
/// manifest become stale instead of being resurrected against a moved source.
/// Items with unknown ids are user or legacy entries and pass through
/// untouched. Consolidation overlays reshape the projected view only: a
/// merge folds its target into the keep row (skipped when the keep row left),
/// a correction swaps the displayed text while the stored row stays original.
fn reconcile_memories(
    root: &Path,
    manifest: &Manifest,
    active: &[Value],
    managed: &std::collections::HashSet<String>,
    overlays: &[Value],
) -> Vec<Value> {
    let merged: std::collections::HashSet<&str> = overlays
        .iter()
        .filter(|overlay| overlay["kind"] == "merge")
        .filter_map(|overlay| overlay["target_id"].as_str())
        .collect();
    let corrections: std::collections::HashMap<&str, &str> = overlays
        .iter()
        .filter(|overlay| overlay["kind"] == "correction")
        .filter_map(|overlay| {
            Some((
                overlay["target_id"].as_str()?,
                overlay["corrected_text"].as_str()?,
            ))
        })
        .collect();
    let mut projected: Vec<Value> = Vec::new();
    for row in active {
        let Some(id) = row["id"].as_str() else {
            projected.push(row.clone());
            continue;
        };
        if merged.contains(id) {
            // Fold only while the keep target is still active; when it left
            // the set the overlay self-invalidates and the original returns.
            let keep_active = overlays
                .iter()
                .find(|overlay| {
                    overlay["kind"] == "merge" && overlay["target_id"] == row["id"]
                })
                .and_then(|overlay| overlay["supersede_by"].as_str())
                .is_some_and(|keep| active.iter().any(|row| row["id"] == json!(keep)));
            if keep_active {
                continue;
            }
        }
        let mut row = row.clone();
        if let Some(text) = corrections.get(id).filter(|text| !text.is_empty()) {
            // A correction rides on the text it was written against: a later
            // extraction that reworded the row invalidates it.
            let overlay = overlays
                .iter()
                .find(|overlay| overlay["kind"] == "correction" && overlay["target_id"] == row["id"]);
            let matches_original = overlay
                .and_then(|overlay| overlay["original_digest"].as_str())
                .is_none_or(|digest| {
                    digest == store::digest(row["text"].as_str().unwrap_or_default())
                });
            if matches_original {
                row["text"] = json!(text);
                row["consolidated"] = json!(true);
            }
        }
        projected.push(row);
    }
    let active = &projected[..];
    let mut next: Vec<Value> = Vec::new();
    for item in manifest.memories.iter() {
        let id = item["id"].as_str().unwrap_or_default().to_string();
        if !managed.contains(&id) {
            next.push(item.clone());
            continue;
        }
        let Some(row) = active.iter().find(|row| row["id"] == item["id"]) else {
            if item["userEdited"] == true || item["pinned"] == true {
                let mut kept = item.clone();
                kept["stale"] = json!(true);
                next.push(kept);
            }
            continue;
        };
        let mut merged = row.clone();
        for key in ["pinned", "excluded", "userEdited"] {
            if item.get(key).is_some() {
                merged[key] = item[key].clone();
            }
        }
        merged["stale"] = json!(store::memory_document(root, manifest, &merged).is_none());
        next.push(merged);
    }
    for row in active.iter() {
        if !manifest.memories.iter().any(|item| item["id"] == row["id"])
            && store::memory_document(root, manifest, row).is_some()
        {
            next.push(row.clone());
        }
    }
    next
}

/// Consume the pending flag: reconcile candidate rows into manifest.memories,
/// persist, and force the local Markdown views to re-render — persist()'s
/// content gate alone would skip them after a crash between derived.json and
/// the views. The acknowledgement lands only after the views are on disk, so
/// any earlier failure replays on the next call.
pub(super) async fn sync_manifest_memories(
    app: &AppHandle,
    state: &WorkbenchState,
    session: &Session,
) -> CommandResult<bool> {
    let (root, memory_root) = roots(app, session)?;
    if !db_path(&root).is_file() {
        return Ok(false);
    }
    let mut conn = connection(&root)?;
    let (pending, epoch) = projection_pending(&conn)?;
    if !pending {
        return Ok(false);
    }
    let _guard = state.serial.lock().await;
    require_current(state, session)?;
    let manifest = load_state(app, session)?;
    let mut active = Vec::new();
    {
        let mut statement = conn
            .prepare(
                "SELECT id, source_id, kind, status, text, citations, updated_at
                 FROM candidate_entries
                 WHERE status IN ('candidate','confirmed') AND superseded_by=''",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                let source_id: String = row.get(1)?;
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "sourceId": source_id,
                    "kind": row.get::<_, String>(2)?,
                    "status": row.get::<_, String>(3)?,
                    "text": row.get::<_, String>(4)?,
                    "citations": serde_json::from_str::<Value>(&row.get::<_, String>(5)?)
                        .unwrap_or_else(|_| json!([])),
                    "updatedAt": row.get::<_, String>(6)?,
                    "sourceTitle": manifest
                        .entries
                        .get(&source_id)
                        .map(|entry| entry.title.clone())
                        .unwrap_or_default(),
                    "stale": false,
                }))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            active.push(row.map_err(|error| error.to_string())?);
        }
    }
    let managed: std::collections::HashSet<String> = {
        let mut statement = conn
            .prepare("SELECT id FROM candidate_entries")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<std::collections::HashSet<_>, _>>()
            .map_err(|error| error.to_string())?
    };
    let overlays: Vec<Value> = {
        let mut statement = conn
            .prepare(
                "SELECT target_id, kind, supersede_by, corrected_text, original_digest
                 FROM consolidation_overlays WHERE revoked_at=''",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok(json!({
                    "target_id": row.get::<_, String>(0)?,
                    "kind": row.get::<_, String>(1)?,
                    "supersede_by": row.get::<_, String>(2)?,
                    "corrected_text": row.get::<_, String>(3)?,
                    "original_digest": row.get::<_, String>(4)?,
                }))
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };
    let next = reconcile_memories(&root, &manifest, &active, &managed, &overlays);
    let changed = manifest.memories != next;
    let mut manifest = manifest;
    if changed {
        manifest.memories = next;
        persist(app, session, &manifest)?;
    }
    store::write_memory_views(&memory_root, &manifest)?;
    config_set(&mut conn, "projection_ack", &epoch.to_string())?;
    Ok(changed)
}

// ---------------------------------------------------------------------------
// The extraction pass.
// ---------------------------------------------------------------------------

pub(super) fn is_meeting(entry: &store::Entry) -> bool {
    store::eligible(entry) && entry.kind == "meeting"
}

pub(super) fn allowed(document: &Document, manifest: &Manifest) -> bool {
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
        "meeting",
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
        set_projection_pending(&tx)?;
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
    set_projection_pending(&tx)?;
    tx.commit().map_err(|error| error.to_string())
}

pub(super) async fn extract_pending(
    app: &AppHandle,
    state: &WorkbenchState,
    session: &Session,
) -> CommandResult<bool> {
    let (root, document, input, processor, purpose) = {
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
        (root, document, input, processor, manifest.purpose.trim().to_owned())
    };

    let source = json!({
        "id": document.id, "revision": document.revision, "kind": document.kind,
        "title": document.title, "text": input.text.chars().take(12_000).collect::<String>(),
        "segments": [],
    });
    // The scope purpose steers what is worth remembering (single-writer +
    // purpose-aware extraction per the memory research), bounded so one
    // overlong setting cannot crowd the extraction query.
    let mut query = EXTRACT_QUERY.to_owned();
    if !purpose.is_empty() {
        let purpose: String = purpose.chars().take(PURPOSE_QUERY_CHARS).collect();
        query.push_str(&format!(
            "The user set this purpose for the knowledge scope: \"{purpose}\". Prefer memory items that directly serve this purpose. "
        ));
    }
    query.push_str(wiki::MEMORY_KIND_GUIDANCE);
    let purpose_digest = store::digest(&purpose);
    let result = wiki::synthesize_source(app, session, "memory_extract", source, &query).await;
    let _guard = state.serial.lock().await;
    require_current(state, session)?;
    if wiki::require_task_model(state, session, "memory_extract").is_err()
        || matches!(result.as_ref(), Err(error) if error == wiki::TEXT_MODEL_CHANGED)
    {
        return Ok(true);
    }
    let manifest = load_state(app, session)?;
    if store::digest(manifest.purpose.trim()) != purpose_digest {
        // The purpose moved while the request was in flight: retry with the
        // fresh one instead of landing items extracted under stale steering.
        return Ok(true);
    }
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
