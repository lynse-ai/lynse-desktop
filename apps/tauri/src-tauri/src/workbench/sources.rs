//! Optional source adapters run after meeting bootstrap and never determine its completion.
use super::{load_state, persist, require_current, sync, Document, Session, WorkbenchState};
use crate::CommandResult;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeSet, fs, time::Duration};
use tauri::AppHandle;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub(super) struct Sources {
    pub gmail_enabled: bool,
    pub gmail_account_id: String,
    pub integrations_url: String,
    pub error: String,
    pub updated_at: String,
}
fn path(app: &AppHandle, session: &Session) -> CommandResult<std::path::PathBuf> {
    Ok(super::state_path(app, session)?.with_file_name("wiki-sources.json"))
}
pub(super) fn config(app: &AppHandle, session: &Session) -> CommandResult<Sources> {
    let path = path(app, session)?;
    match fs::read(path) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|_| "Invalid source configuration".into())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Sources::default()),
        Err(e) => Err(e.to_string()),
    }
}
fn save(app: &AppHandle, session: &Session, value: &Sources) -> CommandResult<()> {
    crate::atomic_write(
        &path(app, session)?,
        &serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?,
    )
}
pub(super) fn configure(app: &AppHandle, session: &Session, value: &Value) -> CommandResult<()> {
    let mut next: Sources =
        serde_json::from_value(value.clone()).map_err(|_| "Invalid source settings")?;
    if next.gmail_enabled {
        next.integrations_url = super::normalize_url(&next.integrations_url)?;
        let url =
            url::Url::parse(&next.integrations_url).map_err(|_| "Invalid integrations URL")?;
        if url.scheme() != "https"
            && !matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
        {
            return Err("Use HTTPS for Gmail integration".into());
        }
    }
    next.error.clear();
    save(app, session, &next)?;
    let mut manifest = load_state(app, session)?;
    for entry in manifest.entries.values_mut().filter(|e| e.kind == "gmail") {
        entry.excluded = !next.gmail_enabled || manifest.excluded_sources.contains(&entry.id);
    }
    persist(app, session, &manifest)
}
// Slack and Feishu can implement this same read-only, paginated document boundary.
#[allow(dead_code)]
pub(super) trait SourceAdapter {
    fn kind(&self) -> &'static str;
    fn document(&self, account: &str, row: &Value) -> CommandResult<Document>;
}
struct Gmail;
impl SourceAdapter for Gmail {
    fn kind(&self) -> &'static str {
        "gmail"
    }
    fn document(&self, account: &str, row: &Value) -> CommandResult<Document> {
        let id = row["messageId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("Gmail message has no ID")?;
        let mut doc = Document {
            id: format!("gmail:{account}:{id}"),
            kind: "gmail".into(),
            title: row["subject"].as_str().unwrap_or("Gmail message").into(),
            transcript: row["messageText"].as_str().unwrap_or_default().into(),
            created_at: row["messageTimestamp"].as_str().unwrap_or_default().into(),
            updated_at: row["historyId"].as_str().unwrap_or_default().into(),
            tags: vec![row["sender"].as_str().unwrap_or_default().into()],
            ai_context_enabled: true,
            ..Default::default()
        };
        doc.refresh_revision();
        Ok(doc)
    }
}
async fn read(
    session: &Session,
    source: &Sources,
    operation: &str,
    args: Value,
) -> CommandResult<Value> {
    let token = session
        .token
        .strip_prefix("Bearer ")
        .unwrap_or(&session.token);
    let response=reqwest::Client::builder().timeout(Duration::from_secs(30)).redirect(reqwest::redirect::Policy::none()).build().map_err(|e|e.to_string())?.post(format!("{}/api/v2/integrations/gmail/read",source.integrations_url.trim_end_matches('/'))).bearer_auth(token).json(&json!({"operation":operation,"arguments":args,"account_id":if source.gmail_account_id.is_empty(){Value::Null}else{json!(source.gmail_account_id)}})).send().await.map_err(|_|"Gmail source service is unavailable")?;
    if !response.status().is_success() {
        return Err(format!(
            "Gmail read failed (HTTP {})",
            response.status().as_u16()
        ));
    }
    let value: Value = response
        .json()
        .await
        .map_err(|_| "Invalid Gmail read response")?;
    if value["status"] != "ok" {
        return Err(format!(
            "Gmail: {}",
            value["status"].as_str().unwrap_or("unavailable")
        ));
    }
    Ok(value)
}
async fn pull(
    app: &AppHandle,
    state: &WorkbenchState,
    session: &Session,
    source: &Sources,
) -> CommandResult<()> {
    let mut page = String::new();
    let mut cursors = BTreeSet::new();
    let mut threads = BTreeSet::new();
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(90)).timestamp_millis();
    loop {
        require_current(state, session)?;
        let value = read(
            session,
            source,
            "list_threads",
            json!({"query":"newer_than:90d","max_results":100,"page_token":page}),
        )
        .await?;
        let account = value["account"]["account_id"]
            .as_str()
            .ok_or("Gmail account was not verified")?;
        for thread in value["data"]["threads"]
            .as_array()
            .ok_or("Invalid Gmail thread list")?
        {
            let id = thread["id"]
                .as_str()
                .or_else(|| thread["threadId"].as_str())
                .ok_or("Gmail thread has no ID")?;
            if !threads.insert(id.to_owned()) {
                continue;
            }
            let messages = read(session, source, "read_thread", json!({"thread_id":id})).await?;
            if messages["account"]["account_id"] != account {
                return Err("Gmail account changed during download".into());
            }
            for message in messages["data"]["messages"]
                .as_array()
                .ok_or("Invalid Gmail messages")?
            {
                let millis = message["internalDate"]
                    .as_i64()
                    .or_else(|| {
                        message["internalDate"]
                            .as_str()
                            .and_then(|s| s.parse().ok())
                    })
                    .or_else(|| {
                        message["messageTimestamp"]
                            .as_str()
                            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                            .map(|d| d.timestamp_millis())
                    })
                    .ok_or("Gmail message has no valid timestamp")?;
                if millis < cutoff {
                    continue;
                }
                let document = Gmail.document(account, message)?;
                sync::commit_document(app, state, session, document).await?;
            }
        }
        let next = value["data"]["next_page_token"]
            .as_str()
            .unwrap_or_default();
        if next.is_empty() {
            break;
        }
        if !cursors.insert(next.to_owned()) {
            return Err("Gmail pagination repeated; retry required".into());
        }
        page = next.into();
    }
    Ok(())
}
pub(super) async fn sync_optional(
    app: &AppHandle,
    state: &WorkbenchState,
    session: &Session,
) -> CommandResult<bool> {
    let mut source = config(app, session)?;
    let manifest = load_state(app, session)?;
    if !source.gmail_enabled || !manifest.enabled || !manifest.initial_complete {
        return Ok(false);
    }
    let before: Vec<_> = manifest
        .entries
        .values()
        .filter(|e| e.kind == "gmail")
        .map(|e| (e.id.clone(), e.revision.clone()))
        .collect();
    let result = pull(app, state, session, &source).await;
    let _guard = state.serial.lock().await;
    require_current(state, session)?;
    source.error = result.err().unwrap_or_default();
    source.updated_at = crate::now();
    save(app, session, &source)?;
    // Meeting completion and lexical retrieval remain available when optional connectors fail.
    let latest = load_state(app, session)?;
    let after: Vec<_> = latest
        .entries
        .values()
        .filter(|e| e.kind == "gmail")
        .map(|e| (e.id.clone(), e.revision.clone()))
        .collect();
    persist(app, session, &latest)?;
    Ok(before != after)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gmail_source_ids_and_revisions_are_account_bound() {
        let row = json!({"messageId":"m1","subject":"Decision","messageText":"Ship next week","internalDate":"1000"});
        let a = Gmail.document("a", &row).unwrap();
        let b = Gmail.document("b", &row).unwrap();
        assert_ne!(a.id, b.id);
        assert_ne!(a.revision, b.revision);
        assert!(a.ai_context_enabled);
    }
}
