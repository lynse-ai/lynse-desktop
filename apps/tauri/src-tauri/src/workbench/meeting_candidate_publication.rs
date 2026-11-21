//! Outbox delivery and replay against the verified cloud publication API.
use super::*;

fn device_identity(conn: &mut Connection) -> CommandResult<(String, String)> {
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let device = config_get(&tx, "device_id")?;
    let credential = config_get(&tx, "device_credential")?;
    if let (Some(device), Some(credential)) = (device, credential) {
        return Ok((device, credential));
    }
    let device = uuid::Uuid::new_v4().to_string();
    let credential = uuid::Uuid::new_v4().to_string();
    config_set(&tx, "device_id", &device)?;
    config_set(&tx, "device_credential", &credential)?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok((device, credential))
}

#[derive(Deserialize)]
struct PublicationFeed {
    head: u64,
    writer: Option<Writer>,
}

#[derive(Deserialize)]
struct Writer {
    device_id: String,
    generation: u64,
}

async fn memory_request(
    state: &WorkbenchState,
    session: &Session,
    path: &str,
    payload: Option<&Value>,
    operation: Option<&str>,
) -> CommandResult<(u16, Value)> {
    state
        .knowledge_transport
        .publication_request(session, path, payload, operation, || {
            require_current(state, session)
        })
        .await
}

fn publish_entries(
    conn: &Connection,
    source_id: &str,
    extraction: &str,
) -> CommandResult<Vec<Value>> {
    // Wiki-lane rows never enter publish_queue, but the explicit lane filter
    // keeps the publication package meeting-only even if a shared extraction
    // id ever pointed here.
    let mut statement = conn.prepare(
        "SELECT id, kind, text, citations FROM candidate_entries
         WHERE source_id=?1 AND extraction_id=?2 AND lane='meeting'
           AND status IN ('candidate','confirmed') AND superseded_by=''
         ORDER BY event_time_ms IS NULL, event_time_ms, created_at, id",
    ).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![source_id, extraction], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    rows.map(|row| {
        let (id, kind, text, citations) = row.map_err(|error| error.to_string())?;
        let citations =
            serde_json::from_str::<Value>(&citations).map_err(|error| error.to_string())?;
        Ok(json!({
            "client_id": id,
            "kind": if kind == "decision" { "decision" } else { "project_fact" },
            "text": text,
            "citations": citations,
        }))
    })
    .collect()
}

struct Publication {
    source_id: String,
    extraction: String,
    source_revision: String,
    fingerprint: String,
    attempt: Option<CommitAttempt>,
}

#[derive(Deserialize, serde::Serialize)]
struct CommitAttempt {
    head: u64,
    generation: u64,
    meeting_date: String,
    entries: Vec<Value>,
}

fn next_publication(conn: &Connection, manifest: &Manifest) -> CommandResult<Option<Publication>> {
    let mut statement = conn
        .prepare(
            "SELECT q.source_id, q.extraction_id, r.source_revision, i.fingerprint, a.body
         FROM publish_queue q JOIN extraction_receipts r USING (source_id)
         JOIN extraction_inputs i USING (source_id)
         LEFT JOIN publication_attempts a ON a.source_id=q.source_id AND a.extraction_id=q.extraction_id
         WHERE q.state='pending' AND q.next_attempt_at<=?1
           AND q.extraction_id=r.extraction_id AND r.source_revision=i.source_revision
         ORDER BY q.updated_at, q.source_id",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([epoch_secs()], |row| {
            Ok(Publication {
                source_id: row.get(0)?,
                extraction: row.get(1)?,
                source_revision: row.get(2)?,
                fingerprint: row.get(3)?,
                attempt: row
                    .get::<_, Option<String>>(4)?
                    .map(|body| {
                        serde_json::from_str(&body).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                4,
                                rusqlite::types::Type::Text,
                                Box::new(error),
                            )
                        })
                    })
                    .transpose()?,
            })
        })
        .map_err(|error| error.to_string())?;
    for row in rows {
        let job = row.map_err(|error| error.to_string())?;
        if manifest
            .entries
            .get(&job.source_id)
            .is_some_and(|entry| is_meeting(entry) && entry.revision == job.source_revision)
        {
            return Ok(Some(job));
        }
    }
    Ok(None)
}

fn settle_publication(
    conn: &mut Connection,
    job: &Publication,
    state: &str,
    delay: i64,
    clear_attempt: bool,
) -> CommandResult<()> {
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let changed = tx.execute(
        "UPDATE publish_queue SET state=?3, next_attempt_at=?4, updated_at=?5
         WHERE source_id=?1 AND extraction_id=?2 AND state='pending'
           AND EXISTS (SELECT 1 FROM extraction_receipts WHERE source_id=?1 AND source_revision=?6)",
        params![
            job.source_id,
            job.extraction,
            state,
            epoch_secs() + delay,
            crate::now(),
            job.source_revision
        ],
    )
    .map_err(|error| error.to_string())?;
    if clear_attempt && changed != 0 {
        tx.execute(
            "DELETE FROM publication_attempts WHERE source_id=?1 AND extraction_id=?2",
            params![job.source_id, job.extraction],
        )
        .map_err(|error| error.to_string())?;
    }
    tx.commit().map_err(|error| error.to_string())
}

fn is_pending(conn: &Connection, job: &Publication) -> CommandResult<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM publish_queue q JOIN extraction_receipts r USING (source_id)
         WHERE q.source_id=?1 AND q.extraction_id=?2 AND q.state='pending'
           AND r.extraction_id=q.extraction_id AND r.source_revision=?3)",
        params![job.source_id, job.extraction, job.source_revision],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

fn save_attempt(
    conn: &Connection,
    job: &Publication,
    attempt: &CommitAttempt,
) -> CommandResult<()> {
    let body = serde_json::to_string(attempt).map_err(|error| error.to_string())?;
    conn.execute(
        "INSERT INTO publication_attempts (source_id, extraction_id, body) VALUES (?1,?2,?3)
         ON CONFLICT(source_id) DO UPDATE SET extraction_id=excluded.extraction_id, body=excluded.body",
        params![job.source_id, job.extraction, body],
    ).map_err(|error| error.to_string())?;
    Ok(())
}

async fn publication_feed(
    state: &WorkbenchState,
    session: &Session,
) -> CommandResult<PublicationFeed> {
    let (status, feed) =
        memory_request(state, session, "/meeting-publications?limit=1", None, None).await?;
    if status != 200 {
        return Err(format!("Publication feed failed (HTTP {status})"));
    }
    serde_json::from_value(feed).map_err(|_| "Invalid publication feed".into())
}

pub(in crate::workbench) async fn publish_pending(
    app: &AppHandle,
    state: &WorkbenchState,
    session: &Session,
) -> CommandResult<bool> {
    require_current(state, session)?;
    let Ok((root, _)) = roots(app, session) else {
        return Ok(false);
    };
    if !db_path(&root).is_file() {
        return Ok(false);
    }
    let (job, (device_id, credential)) = {
        let mut conn = connection(&root)?;
        let due = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM publish_queue WHERE state='pending' AND next_attempt_at<=?1)",
                [epoch_secs()],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|error| error.to_string())?;
        if !due {
            return Ok(false);
        }
        let manifest = load_state(app, session)?;
        if wiki::ready(&manifest).is_err() {
            return Ok(false);
        }
        let Some(job) = next_publication(&conn, &manifest)? else {
            return Ok(false);
        };
        // The gateway can verify only meetings with an authoritative cloud ID.
        if job.source_id.starts_with("local:") {
            settle_publication(&mut conn, &job, "local", 0, true)?;
            return Ok(true);
        }
        (job, device_identity(&mut conn)?)
    };

    let result = async {
        let writer = if job.attempt.is_some() {
            None
        } else {
            let feed = publication_feed(state, session).await?;
            let generation = match feed.writer {
                Some(writer) if writer.device_id == device_id => writer.generation,
                Some(_) => return Ok(("pending", 3600, false)),
                None => {
                    let payload = json!({"device_id": device_id, "device_credential": credential});
                    let operation =
                        store::digest(json!(["meeting-writer", device_id, feed.head]).to_string());
                    let (status, value) = memory_request(
                        state,
                        session,
                        "/meeting-publications/writer",
                        Some(&payload),
                        Some(&operation),
                    )
                    .await?;
                    match (status, value["generation"].as_u64()) {
                        (200..=299, Some(generation)) => generation,
                        (409, _) => return Ok(("pending", 60, false)),
                        _ => return Err(format!("Writer registration failed (HTTP {status})")),
                    }
                }
            };
            Some((feed.head, generation))
        };
        let new_attempt;
        let attempt = {
            let _guard = state.serial.lock().await;
            require_current(state, session)?;
            let conn = connection(&root)?;
            if !is_pending(&conn, &job)? {
                return Ok(("pending", 0, false));
            }
            let latest = load_state(app, session)?;
            wiki::ready(&latest)?;
            let current_source = latest
                .entries
                .get(&job.source_id)
                .filter(|entry| is_meeting(entry) && entry.revision == job.source_revision)
                .and_then(|entry| store::read_document(&root, entry).ok())
                .filter(|doc| allowed(doc, &latest));
            let Some(document) = current_source else {
                return Ok(("pending", 120, false));
            };
            if let Some((head, generation)) = writer {
                new_attempt = CommitAttempt {
                    head,
                    generation,
                    meeting_date: document.created_at.chars().take(10).collect(),
                    entries: publish_entries(&conn, &job.source_id, &job.extraction)?,
                };
                save_attempt(&conn, &job, &new_attempt)?;
                &new_attempt
            } else {
                job.attempt.as_ref().ok_or("Missing publication attempt")?
            }
        };
        let payload = json!({
            "writer": {"device_id":device_id, "device_credential":credential},
            "writer_generation": attempt.generation,
            "base_version": attempt.head,
            "meeting_id": job.source_id,
            "meeting_date": attempt.meeting_date,
            "transcript_fingerprint": job.fingerprint,
            "rules_version": RULES_VERSION,
            "source_complete": true,
            "entries": attempt.entries,
        });
        // The same request is replayed after interruption. A fresh base
        // version is needed only after the server rejects the saved attempt.
        let operation =
            store::digest(json!(["meeting-publication", job.extraction, payload]).to_string());
        let (status, value) = memory_request(
            state,
            session,
            "/meeting-publications/commit",
            Some(&payload),
            Some(&operation),
        )
        .await?;
        let code = value["error"]["code"].as_str().unwrap_or_default();
        Ok(match (status, code) {
            (200..=299, _) if value["version"].is_u64() => ("done", 0, true),
            (409, "version_conflict" | "writer_conflict") | (403, "writer_unregistered") => {
                ("pending", 5, true)
            }
            (403, "writer_credential_mismatch") => ("pending", 3600, true),
            (409, "extraction_paused") => ("pending", 300, true),
            (409, "transcript_fingerprint_mismatch" | "transcript_unavailable") => {
                ("pending", 1800, true)
            }
            (422, "citation_outside_transcript") => {
                log::warn!(
                    "[meeting-publish] gateway rejected citations for {}",
                    job.source_id
                );
                ("cancelled", 0, true)
            }
            (429 | 502 | 503 | 504, _) => ("pending", 60, false),
            _ => return Err(format!("Publication commit failed (HTTP {status}): {code}")),
        })
    }
    .await;
    require_current(state, session)?;
    let mut conn = connection(&root)?;
    match result {
        Ok((status, delay, clear_attempt)) => {
            settle_publication(&mut conn, &job, status, delay, clear_attempt)?;
            Ok(true)
        }
        Err(error) => {
            settle_publication(&mut conn, &job, "pending", 600, false)?;
            log::warn!("[meeting-candidates] publication deferred: {error}");
            // The job is already settled 600s out; tell the loop to idle so a
            // dead gateway/session doesn't parade the whole queue past it at
            // the 1s cadence.
            Ok(false)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retries_reuse_the_durable_body_until_a_conflict_is_confirmed() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let mut conn = connection(&root).unwrap();
        let mut manifest = Manifest::default();
        let document = Document {
            id: "meeting".into(),
            kind: "meeting".into(),
            revision: "r1".into(),
            transcript: "A decision".into(),
            ..Default::default()
        };
        manifest.entries.insert(
            document.id.clone(),
            store::Entry {
                id: document.id.clone(),
                kind: "meeting".into(),
                revision: "r1".into(),
                status: "synced".into(),
                ..Default::default()
            },
        );
        let input = evidence(&document).unwrap();
        save_extraction(&mut conn, "scope", &document, "processor", &input, &[]).unwrap();

        let job = next_publication(&conn, &manifest).unwrap().unwrap();
        let attempt = CommitAttempt {
            head: 11,
            generation: 2,
            meeting_date: String::new(),
            entries: Vec::new(),
        };
        save_attempt(&conn, &job, &attempt).unwrap();
        settle_publication(&mut conn, &job, "pending", 0, false).unwrap();
        drop(conn);

        let mut conn = connection(&root).unwrap();
        let reopened = next_publication(&conn, &manifest).unwrap().unwrap();
        assert_eq!(
            serde_json::to_value(&reopened.attempt).unwrap(),
            serde_json::to_value(attempt).unwrap()
        );
        settle_publication(&mut conn, &reopened, "pending", 0, true).unwrap();
        assert!(next_publication(&conn, &manifest)
            .unwrap()
            .unwrap()
            .attempt
            .is_none());
        assert_eq!(receipts(&conn).unwrap().len(), 1);
        drop(conn);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn outdated_publication_cannot_settle_the_replacement_job() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let mut conn = connection(&root).unwrap();
        let mut manifest = Manifest::default();
        let mut document = Document {
            id: "meeting".into(),
            kind: "meeting".into(),
            revision: "r1".into(),
            transcript: "A decision".into(),
            ..Default::default()
        };
        manifest.entries.insert(
            document.id.clone(),
            store::Entry {
                id: document.id.clone(),
                kind: "meeting".into(),
                revision: "r1".into(),
                status: "synced".into(),
                ..Default::default()
            },
        );
        let input = evidence(&document).unwrap();
        save_extraction(&mut conn, "scope", &document, "processor", &input, &[]).unwrap();
        let original = next_publication(&conn, &manifest).unwrap().unwrap();
        document.revision = "r2".into();
        manifest.entries.get_mut(&document.id).unwrap().revision = document.revision.clone();
        let previous = receipts(&conn).unwrap().remove(&document.id).unwrap();
        reuse_extraction(&mut conn, &document, "processor", &input, &previous).unwrap();
        assert!(!is_pending(&conn, &original).unwrap());
        settle_publication(&mut conn, &original, "done", 0, true).unwrap();
        let replacement = next_publication(&conn, &manifest).unwrap().unwrap();
        assert_eq!(replacement.extraction, original.extraction);
        assert_eq!(replacement.source_revision, "r2");
        drop(conn);
        fs::remove_dir_all(root).unwrap();
    }
}
