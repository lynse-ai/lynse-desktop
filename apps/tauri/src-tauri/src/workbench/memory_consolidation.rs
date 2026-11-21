//! Nightly dreaming over local candidate memory. Desktop-only by design:
//! merges and corrections land as revocable overlay rows, while the
//! publication outbox and the Markdown export keep reading the original
//! candidate rows — a night-time consolidation can never leak into a cloud
//! commit or a human-confirm package. Batch progress is a keyset cursor plus
//! an attempt counter, never a whole-table timestamp, so one finished batch
//! cannot mark the round complete.
use super::*;

const BATCH_ROWS: usize = 50;
/// The consolidation batch rides in the query; stay inside the direct
/// pipeline's 30k query budget with headroom for the instructions.
const BATCH_CHARS: usize = 24_000;
/// Waves per lane pass: the dream window is hours long, so one pass hands
/// the lane back between waves instead of monopolizing it.
const MAX_WAVES_PER_PASS: usize = 10;
/// A persistently failing batch is skipped after this many attempts instead
/// of wedging the round on the same cursor.
const MAX_BATCH_ATTEMPTS: usize = 3;

const MERGE_KIND: &str = "merge";
const CORRECTION_KIND: &str = "correction";

fn overlay_id(kind: &str, target: &str, payload: &str) -> String {
    store::digest(json!(["memory-overlay-v1", kind, target, payload]).to_string())
}

fn state_get(conn: &Connection, key: &str) -> CommandResult<String> {
    Ok(config_get(conn, key)?.unwrap_or_default())
}

fn state_set(conn: &Connection, key: &str, value: &str) -> CommandResult<()> {
    config_set(conn, key, value)
}

/// Digest of the current active row set — the round's staleness marker. Rows
/// landing mid-round change it, which schedules the follow-up round.
fn active_digest(conn: &Connection) -> CommandResult<String> {
    let mut statement = conn
        .prepare(
            "SELECT id, updated_at FROM candidate_entries
             WHERE status IN ('candidate','confirmed') AND superseded_by='' ORDER BY id",
        )
        .map_err(|error| error.to_string())?;
    let rows: Vec<(String, String)> = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|error| error.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|error| error.to_string())?;
    Ok(store::digest(json!(rows).to_string()))
}

fn protected_ids(manifest: &Manifest) -> std::collections::HashSet<String> {
    manifest
        .memories
        .iter()
        .filter(|item| item["pinned"] == true || item["userEdited"] == true)
        .filter_map(|item| item["id"].as_str().map(String::from))
        .collect()
}

fn fetch_active_row(conn: &Connection, id: &str) -> CommandResult<Option<Value>> {
    let mut statement = conn
        .prepare(
            "SELECT id, kind, status, text, citations, source_revision
             FROM candidate_entries
             WHERE id=?1 AND status IN ('candidate','confirmed') AND superseded_by=''",
        )
        .map_err(|error| error.to_string())?;
    let row = statement
        .query_row(params![id], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "kind": row.get::<_, String>(1)?,
                "status": row.get::<_, String>(2)?,
                "text": row.get::<_, String>(3)?,
                "citations": serde_json::from_str::<Value>(&row.get::<_, String>(4)?)
                    .unwrap_or_else(|_| json!([])),
                "source_revision": row.get::<_, String>(5)?,
            }))
        })
        .optional()
        .map_err(|error| error.to_string())?;
    Ok(row)
}

/// Write the plan's overlays after re-verifying every target: protection
/// flags, active status, and (for corrections) that the row still cites a
/// live source at its recorded revision. All-or-nothing per batch.
fn apply_batch_overlays(
    conn: &mut Connection,
    plan: &Value,
    manifest: &Manifest,
    root: &Path,
    protected: &std::collections::HashSet<String>,
) -> CommandResult<usize> {
    let batch_id = store::digest(plan.to_string());
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let now = crate::now();
    let mut applied = 0usize;
    for merge in plan["merges"].as_array().into_iter().flatten() {
        let keep = merge["keep"].as_str().unwrap_or_default();
        if keep.is_empty() || protected.contains(keep) {
            continue;
        }
        if fetch_active_row(&tx, keep)?.is_none() {
            continue;
        }
        for target in merge["supersede"].as_array().into_iter().flatten() {
            let Some(target) = target.as_str() else { continue };
            if target == keep || protected.contains(target) {
                continue;
            }
            if fetch_active_row(&tx, target)?.is_none() {
                continue;
            }
            tx.execute(
                "INSERT INTO consolidation_overlays
                    (id, target_id, kind, supersede_by, corrected_text, reason,
                     batch_id, created_at, revoked_at, original_digest)
                 VALUES (?1,?2,?3,?4,'',?5,?6,?7,'','')
                 ON CONFLICT(id) DO UPDATE SET supersede_by=excluded.supersede_by,
                    reason=excluded.reason, batch_id=excluded.batch_id,
                    created_at=excluded.created_at, revoked_at=''",
                params![
                    overlay_id(MERGE_KIND, target, keep),
                    target,
                    MERGE_KIND,
                    keep,
                    merge["reason"].as_str().unwrap_or_default(),
                    batch_id,
                    now,
                ],
            )
            .map_err(|error| error.to_string())?;
            applied += 1;
        }
    }
    for correction in plan["corrections"].as_array().into_iter().flatten() {
        let Some(target) = correction["id"].as_str() else {
            continue;
        };
        if protected.contains(target) {
            continue;
        }
        let Some(row) = fetch_active_row(&tx, target)? else {
            continue;
        };
        // A correction must still stand on live evidence: the row's own
        // citations have to verify, otherwise the row drifts toward stale
        // and the model's rewrite would fictionalize it.
        let item = json!({
            "id": row["id"], "text": row["text"], "kind": row["kind"],
            "citations": row["citations"],
        });
        if store::memory_document(root, manifest, &item).is_none() {
            continue;
        }
        let text = correction["text"].as_str().unwrap_or_default();
        tx.execute(
            "INSERT INTO consolidation_overlays
                (id, target_id, kind, supersede_by, corrected_text, reason,
                 batch_id, created_at, revoked_at, original_digest)
             VALUES (?1,?2,?3,'',?4,?5,?6,?7,'',?8)
             ON CONFLICT(id) DO UPDATE SET corrected_text=excluded.corrected_text,
                reason=excluded.reason, batch_id=excluded.batch_id,
                created_at=excluded.created_at, revoked_at='', original_digest=excluded.original_digest",
            params![
                overlay_id(CORRECTION_KIND, target, text),
                target,
                CORRECTION_KIND,
                text,
                correction["reason"].as_str().unwrap_or_default(),
                batch_id,
                now,
                store::digest(row["text"].as_str().unwrap_or_default()),
            ],
        )
        .map_err(|error| error.to_string())?;
        applied += 1;
    }
    if applied > 0 {
        set_projection_pending(&tx)?;
    }
    tx.commit().map_err(|error| error.to_string())?;
    Ok(applied)
}

/// One dreaming attempt. Returns whether any consolidation work happened.
pub(super) async fn run_consolidation(
    app: &AppHandle,
    state: &WorkbenchState,
    session: &Session,
) -> CommandResult<bool> {
    // Night window only: consolidation spends model calls, so it mirrors the
    // wiki dream gate and runs while the machine is otherwise idle.
    if !super::super::wiki::is_dream_time() {
        return Ok(false);
    }
    let (root, _) = roots(app, session)?;
    if !db_path(&root).is_file() {
        return Ok(false);
    }
    {
        let mut conn = connection(&root)?;
        let phase = state_get(&conn, "consolidation_phase")?;
        let seen = state_get(&conn, "consolidation_seen")?;
        let digest = active_digest(&conn)?;
        if phase != "running" && digest == seen {
            return Ok(false);
        }
        if phase != "running" {
            let tx = conn.transaction().map_err(|error| error.to_string())?;
            state_set(&tx, "consolidation_phase", "running")?;
            state_set(&tx, "consolidation_cursor", "")?;
            state_set(&tx, "consolidation_attempts", "0")?;
            tx.commit().map_err(|error| error.to_string())?;
        }
    }

    let mut worked = false;
    let mut round_done = false;
    for _ in 0..MAX_WAVES_PER_PASS {
        let _guard = state.serial.lock().await;
        require_current(state, session)?;
        let manifest = load_state(app, session)?;
        let ready = wiki::ready(&manifest).is_ok() && session.model_override.is_some();
        drop(_guard);
        if !ready {
            // Phase stays running; the next tick resumes from the cursor.
            return Ok(worked);
        }
        let mut conn = connection(&root)?;
        let cursor = state_get(&conn, "consolidation_cursor")?;
        let batch = {
            let mut statement = conn
                .prepare(
                    "SELECT id, kind, status, text, citations, source_revision, event_date
                     FROM candidate_entries
                     WHERE status IN ('candidate','confirmed') AND superseded_by='' AND id>?1
                     ORDER BY id LIMIT ?2",
                )
                .map_err(|error| error.to_string())?;
            let rows = statement
                .query_map(params![cursor, BATCH_ROWS as i64], |row| {
                    Ok(json!({
                        "id": row.get::<_, String>(0)?,
                        "kind": row.get::<_, String>(1)?,
                        "status": row.get::<_, String>(2)?,
                        "text": row.get::<_, String>(3)?,
                        "citations": serde_json::from_str::<Value>(&row.get::<_, String>(4)?)
                            .unwrap_or_else(|_| json!([])),
                        "source_revision": row.get::<_, String>(5)?,
                        "event_date": row.get::<_, String>(6)?,
                    }))
                })
                .map_err(|error| error.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?
        };
        if batch.is_empty() {
            round_done = true;
            break;
        }

        let _guard = state.serial.lock().await;
        require_current(state, session)?;
        let manifest = load_state(app, session)?;
        let protected = protected_ids(&manifest);
        // Phase A (free): a row whose citations no longer verify against its
        // source is superseded outright — a moved source must not survive
        // dreaming and re-enter the projection.
        let invalid: Vec<String> = batch
            .iter()
            .filter(|row| !protected.contains(row["id"].as_str().unwrap_or_default()))
            .filter(|row| {
                let item = json!({
                    "id": row["id"], "text": row["text"], "kind": row["kind"],
                    "citations": row["citations"],
                });
                store::memory_document(&root, &manifest, &item).is_none()
            })
            .filter_map(|row| row["id"].as_str().map(String::from))
            .collect();
        drop(_guard);
        if !invalid.is_empty() {
            let tx = conn.transaction().map_err(|error| error.to_string())?;
            for id in &invalid {
                tx.execute(
                    "UPDATE candidate_entries SET status='superseded', updated_at=?2
                     WHERE id=?1 AND status IN ('candidate','confirmed')",
                    params![id, crate::now()],
                )
                .map_err(|error| error.to_string())?;
            }
            set_projection_pending(&tx)?;
            tx.commit().map_err(|error| error.to_string())?;
            worked = true;
        }

        // Phase B: merge duplicates and correct contradictions. Protected
        // rows are excluded from correction targets; the model is told to
        // prefer them as merge keeps and the applier enforces it again.
        let mut query = String::from(
            "Consolidate this batch of the user's memory candidates. Return merges for duplicate or overlapping statements and corrections only where the statement clearly contradicts its own wording or date. Batch: ",
        );
        let mut sent: Vec<&Value> = Vec::new();
        for row in batch
            .iter()
            .filter(|row| !invalid.iter().any(|id| Some(id.as_str()) == row["id"].as_str()))
            .filter(|row| !protected.contains(row["id"].as_str().unwrap_or_default()))
        {
            let payload = json!({
                "id": row["id"], "kind": row["kind"], "text": row["text"],
                "date": row["event_date"],
            })
            .to_string();
            if sent.len() >= BATCH_ROWS
                || query.chars().count() + payload.chars().count() > BATCH_CHARS
            {
                break;
            }
            query.push_str(&payload);
            sent.push(row);
        }
        if !sent.is_empty() {
            let result =
                wiki::synthesize_query(app, session, "memory_consolidate", &query).await;
            let _guard = state.serial.lock().await;
            require_current(state, session)?;
            if matches!(result.as_ref(), Err(error) if error == super::super::wiki::TEXT_MODEL_CHANGED)
            {
                return Ok(worked);
            }
            let manifest = load_state(app, session)?;
            let protected = protected_ids(&manifest);
            let attempts: i64 = state_get(&conn, "consolidation_attempts")?
                .parse()
                .unwrap_or(0);
            match result {
                Ok(plan) => {
                    let applied =
                        apply_batch_overlays(&mut conn, &plan, &manifest, &root, &protected)?;
                    worked |= applied > 0;
                    state_set(&conn, "consolidation_attempts", "0")?;
                }
                Err(error) => {
                    if attempts + 1 >= MAX_BATCH_ATTEMPTS as i64 {
                        log::warn!(
                            "[memory-consolidation] batch skipped after {attempts} attempts: {error}"
                        );
                        state_set(&conn, "consolidation_attempts", "0")?;
                    } else {
                        state_set(
                            &conn,
                            "consolidation_attempts",
                            &(attempts + 1).to_string(),
                        )?;
                        log::warn!("[memory-consolidation] batch deferred: {error}");
                        return Ok(worked);
                    }
                }
            }
        }
        // Advance the keyset cursor past this batch in the same commit as
        // the attempt bookkeeping.
        let last = batch
            .last()
            .and_then(|row| row["id"].as_str())
            .unwrap_or_default()
            .to_owned();
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        state_set(&tx, "consolidation_cursor", &last)?;
        tx.commit().map_err(|error| error.to_string())?;
    }

    // Finalize only when the cursor actually drained the active set; a wave
    // budget exit keeps phase=running and resumes from the cursor next tick.
    if round_done {
        let mut conn = connection(&root)?;
        let digest = active_digest(&conn)?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        state_set(&tx, "consolidation_phase", "idle")?;
        state_set(&tx, "consolidation_seen", &digest)?;
        state_set(&tx, "consolidation_cursor", "")?;
        tx.commit().map_err(|error| error.to_string())?;
    }
    Ok(worked)
}
