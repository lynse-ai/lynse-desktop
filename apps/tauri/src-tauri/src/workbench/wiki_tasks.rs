//! Durable claims for model work. A dropped future is an unknown outcome, not a retry.
use super::*;

tokio::task_local! { static OPERATION: String; }
tokio::task_local! { static PROFILE: Option<Value>; }
pub(super) const UNKNOWN: &str = "Model outcome is unknown; retry explicitly";
const STATUS_CONFLICT: &str = "Lynclaw synthesis failed (HTTP 409)";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Outcome {
    Retryable,
    Unknown,
    ValidationFailed,
    AuthorizationFailed,
}
impl Outcome {
    /// Self-healing classes: the backend hiccuped but will serve later, and
    /// the recorded failures already skip work within this session. Gates use
    /// this to stay open instead of wedging the pipeline until a restart.
    pub(super) fn recoverable(error: &str) -> bool {
        matches!(
            Self::classify(error),
            Self::Unknown | Self::Retryable
        )
    }
    pub(super) fn classify(error: &str) -> Self {
        if error.contains(UNKNOWN)
            || error == STATUS_CONFLICT
            || error.starts_with("Lynclaw returned invalid synthesis JSON")
            || [500, 502, 503, 504].iter().any(|status| {
                error.starts_with(&format!("Lynclaw synthesis failed (HTTP {status})"))
            })
            || [500, 502, 503, 504].iter().any(|status| {
                error.starts_with(&format!("Model provider failed (HTTP {status})"))
            })
        {
            Self::Unknown
        } else if is_session_failure(error) || error.contains("authorization rejected") {
            Self::AuthorizationFailed
        } else if error.starts_with("Lynclaw synthesis failed (HTTP 429)")
            || error.starts_with("Model provider failed (HTTP 429)")
            || super::super::knowledge_transport::transient(error)
        {
            Self::Retryable
        } else {
            Self::ValidationFailed
        }
    }
    fn state(self) -> &'static str {
        match self {
            Self::Retryable => "retryable",
            Self::Unknown => "unknown",
            Self::ValidationFailed => "validation_failed",
            Self::AuthorizationFailed => "authorization_failed",
        }
    }
}

fn connection(root: &Path) -> CommandResult<Connection> {
    fs::create_dir_all(root).map_err(|error| error.to_string())?;
    // Task outcomes are authoritative. Corruption must stop work, whereas the
    // separate index database may safely rebuild its expendable indexes.
    let conn =
        Connection::open(root.join("model-tasks.sqlite")).map_err(|error| error.to_string())?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|error| error.to_string())?;
    conn.execute_batch("CREATE TABLE IF NOT EXISTS model_tasks (
        id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, state TEXT NOT NULL,
        error TEXT NOT NULL, updated_at TEXT NOT NULL, output TEXT, retry_at INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS model_task_meta (id TEXT PRIMARY KEY)").map_err(|error| error.to_string())?;
    let columns: std::collections::BTreeSet<String> = {
        let mut statement = conn
            .prepare("PRAGMA table_info(model_tasks)")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<_, _>>()
            .map_err(|error| error.to_string())?
    };
    for (name, definition) in [
        ("output", "TEXT"),
        ("retry_at", "INTEGER NOT NULL DEFAULT 0"),
    ] {
        if !columns.contains(name) {
            conn.execute_batch(&format!(
                "ALTER TABLE model_tasks ADD COLUMN {name} {definition}"
            ))
            .map_err(|error| error.to_string())?;
        }
    }
    conn.execute(
        "UPDATE model_tasks SET state='unknown',error=? WHERE state='done' AND output IS NULL",
        [UNKNOWN],
    )
    .map_err(|error| error.to_string())?;
    // Older clients classified an unqualified 409 as a validation failure and
    // could silently issue a new operation. Its remote outcome is unknown.
    conn.execute(
        "UPDATE model_tasks SET state='unknown' WHERE state='validation_failed' AND error=?",
        [STATUS_CONFLICT],
    )
    .map_err(|error| error.to_string())?;
    if !conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM model_task_meta WHERE id='legacy-outcomes-v2')",
            [],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| error.to_string())?
    {
        let legacy = db(root)?;
        let mut statement = legacy
            .prepare(
                "SELECT id,updated_at,state,error FROM jobs WHERE state IN ('running','failed')",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (key, updated, state, error) = row.map_err(|error| error.to_string())?;
            if state != "running" && Outcome::classify(&error) != Outcome::Unknown {
                continue;
            }
            conn.execute("INSERT OR IGNORE INTO model_tasks(id,operation_id,state,error,updated_at,output,retry_at) VALUES (?1,?2,'unknown',?3,?4,NULL,0)",
                params![key,format!("legacy-{key}"),UNKNOWN,updated]).map_err(|error|error.to_string())?;
        }
        conn.execute(
            "INSERT OR IGNORE INTO model_task_meta VALUES ('legacy-outcomes-v2')",
            [],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(conn)
}

pub(super) fn current_operation() -> Option<String> {
    OPERATION.try_with(Clone::clone).ok()
}
pub(super) fn current_profile() -> Option<Value> {
    PROFILE.try_with(Clone::clone).ok().flatten()
}
pub(super) fn profile_bound() -> bool {
    PROFILE.try_with(|_| ()).is_ok()
}
pub(super) async fn profile_scope<T>(
    profile: Option<Value>,
    work: impl std::future::Future<Output = T>,
) -> T {
    PROFILE.scope(profile, work).await
}

fn claim(root: &Path, key: &str) -> CommandResult<String> {
    let mut conn = connection(root)?;
    let transaction = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let existing: Option<(String, String, String, i64)> = transaction
        .query_row(
            "SELECT operation_id,state,error,retry_at FROM model_tasks WHERE id=?",
            [key],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if existing
        .as_ref()
        .is_some_and(|(_, state, _, _)| matches!(state.as_str(), "running" | "unknown"))
    {
        return Err(UNKNOWN.into());
    }
    if let Some((_, state, error, retry_at)) = &existing {
        if state == "retryable" && *retry_at > chrono::Utc::now().timestamp() {
            return Err(error.clone());
        }
    }
    // Keep the original operation on automatic recovery so the gateway can
    // detect an existing attempt. Only an explicit retry releases a generic
    // conflict to `ready`, permitting a new operation for that retry.
    let explicit_conflict_retry = existing
        .as_ref()
        .is_some_and(|(_, state, error, _)| state == "ready" && error == STATUS_CONFLICT);
    let validation_retry = existing
        .as_ref()
        .is_some_and(|(_, state, _, _)| state == "validation_failed");
    let operation = if explicit_conflict_retry || validation_retry {
        uuid::Uuid::new_v4().to_string()
    } else {
        existing
            .as_ref()
            .map(|(operation, _, _, _)| operation.clone())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
    };
    transaction.execute("INSERT OR REPLACE INTO model_tasks(id,operation_id,state,error,updated_at,output,retry_at) VALUES (?1,?2,'queued','',?3,NULL,0)",
        params![key, operation, crate::now()]).map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(operation)
}

pub(super) fn dispatched(root: &Path, operation: &str) -> CommandResult<()> {
    connection(root)?.execute("UPDATE model_tasks SET state='running',updated_at=?1 WHERE operation_id=?2 AND state='queued'",
        params![crate::now(),operation]).map_err(|error| error.to_string())?;
    Ok(())
}

fn finish(
    root: &Path,
    key: &str,
    operation: &str,
    result: &CommandResult<Value>,
) -> CommandResult<()> {
    let (state, error) = match result {
        Ok(_) => ("done", ""),
        Err(error) => (Outcome::classify(error).state(), error.as_str()),
    };
    let output = result.as_ref().ok().map(Value::to_string);
    let retry_at = if state == "retryable" {
        chrono::Utc::now().timestamp() + 120
    } else {
        0
    };
    connection(root)?.execute("UPDATE model_tasks SET state=?1,error=?2,updated_at=?3,output=?6,retry_at=?7 WHERE id=?4 AND operation_id=?5",
        params![state, error, crate::now(), key, operation, output, retry_at]).map_err(|error| error.to_string())?;
    Ok(())
}

async fn execute_budgeted(
    root: &Path,
    key: &str,
    reuse: bool,
    budget: std::time::Duration,
    generate: impl std::future::Future<Output = CommandResult<Value>>,
) -> CommandResult<Value> {
    type Gate = std::sync::Arc<tokio::sync::Mutex<()>>;
    static GATES: std::sync::OnceLock<
        std::sync::Mutex<
            std::collections::BTreeMap<PathBuf, std::sync::Weak<tokio::sync::Mutex<()>>>,
        >,
    > = std::sync::OnceLock::new();
    let gate: Gate = {
        let mut gates = GATES
            .get_or_init(Default::default)
            .lock()
            .map_err(|_| "Model task queue unavailable")?;
        gates.retain(|_, gate| gate.strong_count() > 0);
        let identity = root.join(key);
        match gates.get(&identity).and_then(std::sync::Weak::upgrade) {
            Some(gate) => gate,
            None => {
                let gate = Gate::default();
                gates.insert(identity, std::sync::Arc::downgrade(&gate));
                gate
            }
        }
    };
    let _guard = gate.lock().await;
    if reuse {
        let saved: Option<String> = connection(root)?
            .query_row(
                "SELECT output FROM model_tasks WHERE id=? AND state='done'",
                [key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if let Some(saved) = saved {
            return serde_json::from_str(&saved).map_err(|error| error.to_string());
        }
    }
    let operation = claim(root, key)?;
    let result = match tokio::time::timeout(budget, OPERATION.scope(operation.clone(), generate)).await
    {
        Ok(result) => result,
        Err(_) => Err(UNKNOWN.into()),
    };
    finish(root, key, &operation, &result)?;
    result
}

pub(super) async fn execute(
    root: &Path,
    key: &str,
    reuse: bool,
    generate: impl std::future::Future<Output = CommandResult<Value>>,
) -> CommandResult<Value> {
    // HTTP has its own 100 second budget; this catches authorization locks,
    // stream decoding, and other future-level stalls without masking success.
    execute_budgeted(
        root,
        key,
        reuse,
        std::time::Duration::from_secs(180),
        generate,
    )
    .await
}

pub(super) fn retry_unknown(root: &Path) -> CommandResult<()> {
    connection(root)?.execute("UPDATE model_tasks SET state='ready',retry_at=0,updated_at=? WHERE state IN ('running','unknown','retryable')",
        [crate::now()]).map_err(|error| error.to_string())?;
    Ok(())
}

/// At worker startup no claim can belong to this process. Releasing an old
/// running row is safe because the next call reuses its operation id; unknown
/// provider outcomes still wait for an explicit retry.
pub(super) fn recover_abandoned(root: &Path) -> CommandResult<bool> {
    let changed = connection(root)?
        .execute(
            "UPDATE model_tasks
             SET state='ready',error='',retry_at=0,updated_at=?
             WHERE state='running'
               AND datetime(updated_at) < datetime('now','-5 minutes')",
            [crate::now()],
        )
        .map_err(|error| error.to_string())?;
    Ok(changed > 0)
}

pub(super) fn invalidate_completed(root: &Path, key: &str) -> CommandResult<()> {
    connection(root)?.execute("UPDATE model_tasks SET state='validation_failed',output=NULL WHERE id=? AND state='done'",[key])
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub(super) fn release_due(root: &Path) -> CommandResult<bool> {
    let changed = connection(root)?
        .execute(
            "UPDATE model_tasks SET state='ready' WHERE state='retryable' AND retry_at<=?",
            [chrono::Utc::now().timestamp()],
        )
        .map_err(|error| error.to_string())?;
    Ok(changed > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn outcomes_distinguish_rate_limits_authorization_validation_and_unknown_provider_results() {
        assert_eq!(
            Outcome::classify("Lynclaw synthesis failed (HTTP 429)"),
            Outcome::Retryable
        );
        assert_eq!(
            Outcome::classify("Cloud knowledge offline"),
            Outcome::Retryable
        );
        for status in [500, 502, 503, 504] {
            assert_eq!(
                Outcome::classify(&format!("Lynclaw synthesis failed (HTTP {status})")),
                Outcome::Unknown
            );
        }
        assert_eq!(
            Outcome::classify("Lynclaw authentication failed; sign in again"),
            Outcome::AuthorizationFailed
        );
        assert_eq!(
            Outcome::classify("AI citation does not match the original source"),
            Outcome::ValidationFailed
        );
    }

    #[tokio::test]
    async fn generic_status_conflict_waits_for_explicit_retry() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let _ = execute(&root, "ledger-conflict", true, async {
            Err("Lynclaw synthesis failed (HTTP 409)".into())
        })
        .await;
        let first: String = connection(&root)
            .unwrap()
            .query_row(
                "SELECT operation_id FROM model_tasks WHERE id='ledger-conflict'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let blocked = execute(&root, "ledger-conflict", true, async {
            panic!("A conflict with an unknown outcome cannot be retried automatically")
        })
        .await;
        assert_eq!(blocked.unwrap_err(), UNKNOWN);
        retry_unknown(&root).unwrap();
        let second = claim(&root, "ledger-conflict").unwrap();
        assert_ne!(first, second);
        let state: String = connection(&root)
            .unwrap()
            .query_row(
                "SELECT state FROM model_tasks WHERE id='ledger-conflict'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(state, "queued");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn old_generic_conflicts_become_unknown_before_they_can_be_claimed() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let conn = connection(&root).unwrap();
        conn.execute(
            "INSERT INTO model_tasks(id,operation_id,state,error,updated_at) VALUES ('old-conflict','old-id','validation_failed',?,?)",
            params![STATUS_CONFLICT, crate::now()],
        )
        .unwrap();
        drop(conn);
        assert_eq!(claim(&root, "old-conflict").unwrap_err(), UNKNOWN);
        retry_unknown(&root).unwrap();
        assert_ne!(claim(&root, "old-conflict").unwrap(), "old-id");
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn provider_unknown_results_stay_blocked_while_known_rate_limits_resume_after_backoff() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let calls = std::cell::Cell::new(0);
        let _ = execute(&root, "unknown", true, async {
            calls.set(calls.get() + 1);
            Err("Lynclaw synthesis failed (HTTP 503)".into())
        })
        .await;
        assert_eq!(
            execute(&root, "unknown", true, async {
                calls.set(calls.get() + 1);
                Ok(json!({}))
            })
            .await
            .unwrap_err(),
            UNKNOWN
        );
        assert_eq!(calls.get(), 1);
        let _ = execute(&root, "limited", true, async {
            calls.set(calls.get() + 1);
            Err("Lynclaw synthesis failed (HTTP 429)".into())
        })
        .await;
        assert!(execute(&root, "limited", true, async {
            calls.set(calls.get() + 1);
            Ok(json!({}))
        })
        .await
        .is_err());
        assert_eq!(calls.get(), 2);
        connection(&root)
            .unwrap()
            .execute("UPDATE model_tasks SET retry_at=0 WHERE id='limited'", [])
            .unwrap();
        assert!(release_due(&root).unwrap());
        execute(&root, "limited", true, async {
            calls.set(calls.get() + 1);
            Ok(json!({"ok":true}))
        })
        .await
        .unwrap();
        assert_eq!(calls.get(), 3);
        assert_eq!(
            execute(&root, "unknown", true, async {
                panic!("Unknown provider work cannot be retried by a heartbeat")
            })
            .await
            .unwrap_err(),
            UNKNOWN
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn legacy_running_receipts_and_schema_upgrade_are_conservative() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        job(&root, "legacy-call", "running", None, "").unwrap();
        job(
            &root,
            "legacy-503",
            "failed",
            None,
            "Lynclaw synthesis failed (HTTP 503)",
        )
        .unwrap();
        Connection::open(root.join("model-tasks.sqlite")).unwrap().execute_batch("CREATE TABLE model_tasks(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,state TEXT NOT NULL,error TEXT NOT NULL,updated_at TEXT NOT NULL)").unwrap();
        let result = execute(&root, "legacy-call", true, async {
            panic!("An interrupted legacy call has an unknown outcome")
        })
        .await;
        assert_eq!(result.unwrap_err(), UNKNOWN);
        assert_eq!(
            execute(&root, "legacy-503", true, async {
                panic!("A legacy failed unknown result cannot be silently resubmitted")
            })
            .await
            .unwrap_err(),
            UNKNOWN
        );
        retry_unknown(&root).unwrap();
        execute(&root, "legacy-call", true, async {
            Ok(json!({"recovered":true}))
        })
        .await
        .unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn concurrent_consumers_share_one_call_and_its_durable_saved_result() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let calls = std::cell::Cell::new(0);
        let generate = || async {
            calls.set(calls.get() + 1);
            tokio::task::yield_now().await;
            Ok(json!({"facts":"shared"}))
        };
        let (first, second) = future::join(
            execute(&root, "source-facts", true, generate()),
            execute(&root, "source-facts", true, generate()),
        )
        .await;
        assert_eq!(first.unwrap(), second.unwrap());
        assert_eq!(calls.get(), 1);
        execute(&root, "source-facts", true, async {
            panic!("A lost secondary receipt must reuse the durable task result")
        })
        .await
        .unwrap();
        assert_eq!(calls.get(), 1);
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn interrupted_work_requires_explicit_retry_and_keeps_an_attempt_identity() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let calls = std::cell::Cell::new(0);
        let first = claim(&root, "same-input").unwrap();
        dispatched(&root, &first).unwrap();
        assert!(!first.is_empty());
        let result = execute(&root, "same-input", true, async {
            calls.set(calls.get() + 1);
            Ok(json!({"ok":true}))
        })
        .await;
        assert_eq!(result.unwrap_err(), UNKNOWN);
        assert_eq!(calls.get(), 0);
        retry_unknown(&root).unwrap();
        let value = execute(&root, "same-input", true, async {
            assert_eq!(current_operation().unwrap(), first);
            calls.set(calls.get() + 1);
            Ok(json!({"ok":true}))
        })
        .await
        .unwrap();
        assert_eq!(value["ok"], true);
        assert_eq!(calls.get(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn an_abandoned_running_claim_resumes_with_its_operation_identity() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let first = claim(&root, "abandoned").unwrap();
        dispatched(&root, &first).unwrap();
        connection(&root)
            .unwrap()
            .execute(
                "UPDATE model_tasks SET updated_at=datetime('now','-10 minutes') WHERE id='abandoned'",
                [],
            )
            .unwrap();
        assert!(recover_abandoned(&root).unwrap());
        assert!(!recover_abandoned(&root).unwrap());
        let value = execute(&root, "abandoned", true, async {
            assert_eq!(current_operation().unwrap(), first);
            Ok(json!({"recovered":true}))
        })
        .await
        .unwrap();
        assert_eq!(value["recovered"], true);
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn a_stalled_model_future_is_classified_as_unknown() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let result = execute_budgeted(
            &root,
            "stalled",
            true,
            std::time::Duration::from_millis(1),
            std::future::pending(),
        )
        .await;
        assert_eq!(result.unwrap_err(), UNKNOWN);
        let state: String = connection(&root)
            .unwrap()
            .query_row("SELECT state FROM model_tasks WHERE id='stalled'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(state, "unknown");
        fs::remove_dir_all(root).unwrap();
    }
}
