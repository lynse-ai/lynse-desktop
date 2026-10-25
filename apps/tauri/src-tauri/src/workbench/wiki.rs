//! Reviewed, file-backed Wiki pages. SQLite contains only rebuildable indexes and work receipts.
#[path = "wiki_graph.rs"]
mod graph;
#[path = "wiki_topics.rs"]
mod topic_store;
#[path = "wiki_analysis.rs"]
mod analysis;
#[path = "wiki_automation.rs"]
mod automation;
#[path = "wiki_collections.rs"]
mod collections;
pub(super) use automation::{ai_manifest, validate_automation};
pub(super) fn in_automatic_scope(doc: &Document, manifest: &Manifest) -> bool {
    manifest.wiki_automation.is_some() && automation::allows(doc,manifest)
}
use super::store::WikiProgress;
use super::{
    current, invalidate_runtime, load_state, persist, require_current, roots, start_worker, store,
    sync, knowledge_cloud, Document, Manifest, Session, SourceRef, WorkbenchState,
};
use crate::CommandResult;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::{AppHandle, Manager, State};

const MEMORY_KIND_GUIDANCE: &str = "For every memoryItems[].kind, use exactly one English value: \"observation\", \"proposal\", \"decision\", or \"unresolved\". Do not translate these values, combine them, or copy the pipe-separated schema as a value. Use observation for reported facts, proposal for suggestions, decision only for explicitly agreed decisions, and unresolved for open questions or conflicts. Source kinds such as meeting are not memory kinds.";

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Model {
    pub base_url: String,
    pub model: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Models {
    #[serde(skip_deserializing)]
    pub text_revision: String,
    pub embedding: Model,
    pub revision: String,
}
impl Default for Models {
    fn default() -> Self {
        Self {
            text_revision: String::new(),
            embedding: Model {
                base_url: "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
                    .into(),
                model: "qwen3.7-text-embedding".into(),
            },
            revision: String::new(),
        }
    }
}
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Revision {
    pub content_hash: String,
    pub cache_key: String,
    pub id: String,
    pub markdown: String,
    pub citations: Vec<SourceRef>,
    pub fingerprint: String,
    pub created_at: String,
    pub reviewed_at: String,
    pub review: String,
    pub overview: String,
    pub changes: Vec<WikiChange>,
}
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WikiChange {
    pub id: String,
    pub text: String,
    pub created_at: String,
    pub citations: Vec<SourceRef>,
}
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WikiFailure {
    pub message: String,
    pub stage: String,
    pub source_ids: Vec<String>,
    pub occurred_at: String,
}

impl WikiFailure {
    fn new(message: impl Into<String>, stage: &str, source_ids: Vec<String>) -> Self {
        Self { message: message.into(), stage: stage.into(), source_ids, occurred_at: crate::now() }
    }
}
impl From<String> for WikiFailure {
    fn from(message: String) -> Self { Self::new(message, "preparing", Vec::new()) }
}
impl From<&str> for WikiFailure {
    fn from(message: &str) -> Self { Self::from(message.to_owned()) }
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Topic {
    pub id: String,
    pub merged_ids: Vec<String>,
    pub title: String,
    pub purpose: String,
    pub notes: String,
    pub pinned: bool,
    pub excluded: bool,
    pub candidate: Option<Revision>,
    pub published: Option<Revision>,
    pub history: Vec<Revision>,
    pub last_fingerprint: String,
    pub last_attempt_fingerprint: String,
    pub force_refresh: bool,
    pub error: String,
    pub failure: Option<WikiFailure>,
    pub collection: Option<collections::Collection>,
    pub automatic_key: String,
    pub topic_kind: String,
    pub source_ids: Vec<String>,
}
fn wiki_root(app: &AppHandle, session: &Session) -> CommandResult<PathBuf> {
    Ok(roots(app, session)?.1.join("wiki"))
}
fn models_path(app: &AppHandle, session: &Session) -> CommandResult<PathBuf> {
    Ok(super::state_path(app, session)?.with_file_name("wiki-models.json"))
}
fn read_json<T: for<'de> Deserialize<'de> + Default>(path: &Path) -> CommandResult<T> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| "Wiki file is unreadable; original preserved".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(e.to_string()),
    }
}
fn write_json(path: &Path, value: &impl Serialize) -> CommandResult<()> {
    fs::create_dir_all(path.parent().ok_or("Invalid Wiki path")?).map_err(|e| e.to_string())?;
    crate::atomic_write(
        path,
        &serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?,
    )
}
fn read_models(path: &Path) -> CommandResult<Models> {
    let mut config: Models = read_json(path)?;
    // Upgrade an unconfigured legacy value without replacing saved user choices.
    if config.revision.is_empty()
        && config.embedding.base_url.is_empty()
        && config.embedding.model.is_empty()
    {
        config.embedding = Models::default().embedding;
    }
    Ok(config)
}
fn models(app: &AppHandle, session: &Session) -> CommandResult<Models> {
    let mut config = read_models(&models_path(app, session)?)?;
    config.text_revision = store::digest(
        json!([
            "lynclaw-wiki-v2",
            super::markdown::INPUT_VERSION,
            session.agent_url,
            session.model_override
        ])
        .to_string(),
    );
    Ok(config)
}
fn topics(root: &Path) -> CommandResult<Vec<Topic>> {
    let mut result: Vec<Topic> = read_json(&root.join("topics.json"))?;
    for topic in &mut result {
        uuid::Uuid::parse_str(&topic.id)
            .map_err(|_| "Invalid Wiki topic ID; original file was preserved")?;
        for id in &topic.merged_ids {
            uuid::Uuid::parse_str(id)
                .map_err(|_| "Invalid Wiki topic alias; original file was preserved")?;
        }
        // External Markdown edits are authoritative and must never be overwritten by compilation.
        if let Some(page) = &mut topic.published {
            if let Ok(text) = fs::read_to_string(root.join(&topic.id).join("published.md")) {
                page.markdown = text;
            }
        }
        if let Some(page) = &mut topic.candidate {
            if let Ok(text) = fs::read_to_string(root.join(&topic.id).join("candidate.md")) {
                page.markdown = text;
            }
        }
    }
    topic_store::deduplicate(root, &mut result)?;
    Ok(result)
}
fn save_topics(root: &Path, values: &[Topic]) -> CommandResult<()> {
    write_json(&root.join("topics.json"), &values)
}
fn is_session_failure(error: &str) -> bool {
    matches!(error,
        "Lynclaw could not verify this server"
            | "Lynclaw did not confirm this server identity"
            | "Lynclaw returned an invalid server binding"
            | "Lynclaw authentication failed; sign in again"
            | "Lynclaw synthesis failed (HTTP 401)"
            | "Lynclaw synthesis failed (HTTP 403)"
    )
}

fn is_service_failure(error: &str) -> bool {
    is_session_failure(error)
        || error == "Lynclaw synthesis failed (HTTP 422): Unknown synthesis task"
}

pub(super) fn resume_session(app: &AppHandle, session: &Session, manifest: &mut Manifest) -> CommandResult<()> {
    let root = wiki_root(app, session)?;
    if !root.exists() {
        return Ok(());
    }
    resume_session_at(&root, manifest)
}

fn resume_session_at(root: &Path, manifest: &mut Manifest) -> CommandResult<()> {
    let mut recovered = automation::retry_service_failures(root)?;
    let mut values = topics(root)?;
    let mut changed = false;
    for topic in &mut values {
        if !topic.pinned && !topic.excluded && is_service_failure(&topic.error) {
            topic.error.clear();
            topic.last_attempt_fingerprint.clear();
            topic.failure = None;
            if let Some(collection) = &mut topic.collection { for link in &mut collection.links { if is_service_failure(&link.error) {link.error.clear();link.fingerprint.clear();} } }
            changed = true;
        }
    }
    if changed {
        save_topics(root, &values)?;
        recovered = true;
    }
    if recovered || is_service_failure(&manifest.error) {
        manifest.wiki_attempted_fingerprint.clear();
        if is_service_failure(&manifest.error)
            || manifest.error.starts_with("Wiki catalog failed for ")
            || manifest.error.starts_with("Wiki processing failed for ")
        {
            manifest.error.clear();
        }
        manifest.wiki_progress = None;
    }
    Ok(())
}

fn save_page(root: &Path, topic: &Topic, page: &Revision, candidate: bool) -> CommandResult<()> {
    uuid::Uuid::parse_str(&topic.id).map_err(|_| "Invalid Wiki topic ID")?;
    let dir = root.join(&topic.id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = if candidate { "candidate" } else { "published" };
    // Each revision has an immutable snapshot; retries cannot erase manual content or review history.
    let archive = dir.join("revisions").join(format!("{}.json", page.id));
    if !archive.exists() {
        write_json(&archive, page)?;
    }
    let target = dir.join(format!("{name}.md"));
    if let Ok(previous) = fs::read(&target) {
        if previous != page.markdown.as_bytes() {
            let backup = dir
                .join("edits")
                .join(format!("{}.md", store::digest(&previous)));
            fs::create_dir_all(backup.parent().unwrap()).map_err(|e| e.to_string())?;
            if !backup.exists() {
                crate::atomic_write(&backup, &previous)?;
            }
        }
    }
    crate::atomic_write(&target, page.markdown.as_bytes())?;
    write_json(&dir.join(format!("{name}.json")), page)
}

fn is_page_title(title: &str, heading: &str) -> bool {
    let normalize = |text: &str| {
        text.chars()
            .filter(|ch| ch.is_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect::<String>()
    };
    let title = normalize(title);
    let heading = normalize(heading);
    if title.is_empty() {
        return false;
    }
    let Some(mut suffix) = heading.strip_prefix(&title) else {
        return false;
    };
    while !suffix.is_empty() {
        let Some(label) = [
            "项目状态",
            "项目",
            "专题",
            "页面",
            "候选稿",
            "候选",
            "草稿",
            "projectstatus",
            "project",
            "status",
            "wiki",
            "candidate",
            "draft",
            "page",
        ]
        .into_iter()
        .find(|label| suffix.starts_with(label)) else {
            return false;
        };
        suffix = &suffix[label.len()..];
    }
    true
}

fn page_body(title: &str, markdown: &str) -> (String, usize) {
    let mut lines = Vec::new();
    let mut removed = 0;
    let mut fence: Option<(char, usize)> = None;
    for line in markdown.lines() {
        let trimmed = line.trim_start_matches(' ');
        let indented = line.len() - trimmed.len() > 3 || trimmed.starts_with('\t');
        let marker = trimmed.chars().next().filter(|ch| matches!(ch, '`' | '~'));
        if !indented {
            if let Some(marker) = marker {
                let length = trimmed.chars().take_while(|ch| *ch == marker).count();
                if length >= 3 {
                    if let Some((open, count)) = fence {
                        if open == marker && length >= count && trimmed[length..].trim().is_empty()
                        {
                            fence = None;
                        }
                    } else {
                        fence = Some((marker, length));
                    }
                    lines.push(line);
                    continue;
                }
            }
        }
        if fence.is_none() && !indented {
            let level = trimmed.chars().take_while(|ch| *ch == '#').count();
            if (1..=6).contains(&level)
                && trimmed[level..].starts_with(char::is_whitespace)
                && is_page_title(title, trimmed[level..].trim().trim_end_matches('#').trim())
            {
                removed += 1;
                continue;
            }
        }
        lines.push(line);
    }
    (lines.join("\n").trim().to_owned(), removed)
}

fn assemble_page(title: &str, summaries: &[String]) -> String {
    let bodies: Vec<_> = summaries
        .iter()
        .map(|summary| page_body(title, summary).0)
        .filter(|body| !body.is_empty())
        .collect();
    format!("# {}\n\n{}", title.trim(), bodies.join("\n\n---\n\n"))
}

fn repair_page_titles(root: &Path, topics: &mut [Topic]) -> CommandResult<bool> {
    let mut changed = false;
    for topic in topics.iter_mut() {
        for candidate in [false, true] {
            let Some(original) = (if candidate {
                &topic.candidate
            } else {
                &topic.published
            }) else {
                continue;
            };
            // Repair only unchanged generated content; external edits remain authoritative.
            if original.content_hash != store::digest(&original.markdown)
                || page_body(&topic.title, &original.markdown).1 < 2
            {
                continue;
            }
            let mut page = original.clone();
            page.markdown = assemble_page(&topic.title, &[original.markdown.clone()]);
            page.content_hash = store::digest(&page.markdown);
            save_page(root, topic, &page, candidate)?;
            if candidate {
                topic.candidate = Some(page);
            } else {
                topic.published = Some(page);
            }
            changed = true;
        }
    }
    if changed {
        save_topics(root, topics)?;
    }
    Ok(changed)
}

fn db(root: &Path) -> CommandResult<Connection> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let path = root.join("index.sqlite");
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;
    let schema="PRAGMA journal_mode=DELETE;
        CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL, output TEXT, error TEXT, updated_at TEXT);
        CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, revision TEXT NOT NULL, title TEXT, body TEXT);
        CREATE TABLE IF NOT EXISTS vectors (id TEXT PRIMARY KEY, revision TEXT NOT NULL, model_revision TEXT NOT NULL, embedding TEXT NOT NULL);";
    if let Err(error) = conn.execute_batch(schema) {
        if matches!(&error,rusqlite::Error::SqliteFailure(e,_) if matches!(e.code,rusqlite::ErrorCode::DatabaseCorrupt|rusqlite::ErrorCode::NotADatabase))
        {
            drop(conn);
            fs::rename(
                &path,
                root.join(format!("index.corrupt-{}.sqlite", uuid::Uuid::new_v4())),
            )
            .map_err(|e| e.to_string())?;
            return db(root);
        }
        return Err(error.to_string());
    }
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    Ok(conn)
}
pub(super) fn backup_legacy(app: &AppHandle, session: &Session) -> CommandResult<()> {
    let root = wiki_root(app, session)?;
    let legacy = roots(app, session)?.1.join("derived.json");
    let backup = root.join("migration-v1").join("derived.json");
    if legacy.exists() && !backup.exists() {
        fs::create_dir_all(backup.parent().unwrap()).map_err(|e| e.to_string())?;
        crate::atomic_write(&backup, &fs::read(legacy).map_err(|e| e.to_string())?)?;
    }
    Ok(())
}

fn receipt(root: &Path, id: &str) -> CommandResult<Option<Value>> {
    let conn = db(root)?;
    let row: Option<String> = conn
        .query_row(
            "SELECT output FROM jobs WHERE id=? AND state='done'",
            [id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    row.map(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
        .transpose()
}
fn job(
    root: &Path,
    id: &str,
    state: &str,
    output: Option<&Value>,
    error: &str,
) -> CommandResult<()> {
    db(root)?
        .execute(
            "INSERT OR REPLACE INTO jobs VALUES (?1,?2,?3,?4,?5)",
            params![id, state, output.map(Value::to_string), error, crate::now()],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}
pub(super) fn ready(manifest: &Manifest) -> CommandResult<()> {
    if !manifest.enabled
        || !manifest.allow_ai
        || !manifest.initial_complete
        || manifest.sync_round.is_empty()
        || manifest.completed_round != manifest.sync_round
    {
        return Err("Finish syncing available meeting text and allow AI processing first".into());
    }
    Ok(())
}
async fn report_progress(
    app: &AppHandle,
    state: &WorkbenchState,
    session: &Session,
    progress: WikiProgress,
) -> CommandResult<()> {
    let _guard = state.serial.lock().await;
    require_current(state, session)?;
    let mut manifest = load_state(app, session)?;
    ready(&manifest)?;
    manifest.phase = "processing".into();
    manifest.wiki_progress = Some(progress);
    persist(app, session, &manifest)
}
fn fingerprint(topic: &Topic, manifest: &Manifest, config: &Models) -> String {
    let versions: Vec<_> = manifest
        .entries
        .values()
        .map(|e| json!([e.id, e.revision, e.excluded, e.status]))
        .collect();
    store::digest(
        json!([
            topic.title,
            topic.purpose,
            topic.notes,
            config,
            manifest.sync_root,
            versions
        ])
        .to_string(),
    )
}
fn inputs_fingerprint(manifest: &Manifest, config: &Models) -> String {
    let versions: Vec<_> = manifest
        .entries
        .values()
        .map(|entry| json!([entry.id, entry.revision, entry.excluded, entry.status]))
        .collect();
    store::digest(json!([config, manifest.sync_root, versions]).to_string())
}
fn needs_compilation(topic: &Topic, manifest: &Manifest, config: &Models) -> bool {
    if topic.collection.is_some() || topic.pinned || topic.excluded {
        return false;
    }
    let version = fingerprint(topic, manifest, config);
    topic.force_refresh
        || (topic.last_fingerprint != version && topic.last_attempt_fingerprint != version)
}
fn needs_processing(manifest: &mut Manifest, topics: &[Topic], config: &Models) -> bool {
    let pending = topics
        .iter()
        .any(|topic| needs_compilation(topic, manifest, config));
    let inputs = inputs_fingerprint(manifest, config);
    // Adopt the existing completed snapshot without regenerating it after an upgrade.
    if !pending
        && manifest.wiki_attempted_fingerprint.is_empty()
        && manifest
            .wiki_progress
            .as_ref()
            .is_some_and(|progress| progress.stage == "complete" && progress.failed == 0)
    {
        manifest.wiki_attempted_fingerprint = inputs.clone();
    }
    pending || manifest.wiki_attempted_fingerprint != inputs
}
fn retry_failed_work(
    root: &Path,
    topics: &mut [Topic],
    manifest: &mut Manifest,
    id: Option<&str>,
) -> CommandResult<()> {
    if id.is_some_and(|id| !topics.iter().any(|topic| topic_store::matches_id(topic, id))) {
        return Err("Topic not found".into());
    }
    if id.is_none() {
        automation::retry(root)?;
        graph::configure(root, &json!({"action":"tracking_retry"}))?;
    }
    if let Some(id) = id {
        if let Some(topic) = topics.iter_mut().find(|t| topic_store::matches_id(t,id) && t.collection.is_some()) {
            topic.last_attempt_fingerprint.clear();
        }
    }
    let mut retried = 0;
    for topic in topics.iter_mut() {
        if !topic.pinned
            && !topic.excluded
            && (topic.force_refresh || !topic.error.is_empty())
            && id.is_none_or(|id| topic_store::matches_id(topic, id))
        {
            // Retry failed work with its validated receipts and completed revision intact.
            topic.force_refresh = false;
            if let Some(collection) = &mut topic.collection {
                for link in &mut collection.links { if !link.error.is_empty() { link.fingerprint.clear(); link.error.clear(); } }
            }
            topic.last_attempt_fingerprint.clear();
            topic.error.clear();
            topic.failure = None;
            retried += 1;
        }
    }
    save_topics(root, topics)?;
    let failed = topics
        .iter()
        .filter(|topic| !topic.excluded && !topic.error.is_empty())
        .count();
    if id.is_none() || manifest.error.starts_with("Wiki processing failed for ") {
        manifest.error = if failed == 0 {
            String::new()
        } else {
            format!("Wiki processing failed for {failed} topics; open Wiki to review and retry")
        };
    }
    // Embedding-only failures must also re-enter the worker without refreshing completed topics.
    manifest.wiki_attempted_fingerprint.clear();
    if ready(manifest).is_ok() {
        manifest.phase = "processing".into();
        let progress = manifest.wiki_progress.get_or_insert_with(|| WikiProgress {
            stage: "preparing".into(),
            ..Default::default()
        });
        if progress.stage == "complete" {
            progress.stage = "compiling".into();
            progress.current_title.clear();
            progress.topic_title.clear();
        }
        progress.failed = if id.is_none() {
            0
        } else {
            progress.failed.saturating_sub(retried)
        };
    }
    Ok(())
}
fn complete_processing(manifest: &mut Manifest, topics: &[Topic], embedding_failures: usize) {
    let active: Vec<_> = topics.iter().filter(|topic| !topic.excluded).collect();
    let topic_failures = active
        .iter()
        .filter(|topic| !topic.error.is_empty())
        .count();
    manifest.wiki_progress = Some(WikiProgress {
        stage: "complete".into(),
        completed: active.len() - topic_failures,
        total: active.len(),
        failed: topic_failures + embedding_failures,
        ..Default::default()
    });
    manifest.error = if topic_failures > 0 {
        format!("Wiki processing failed for {topic_failures} topics; open Wiki to review and retry")
    } else if embedding_failures > 0 {
        format!(
            "Embedding failed for {embedding_failures} sources; keyword search remains available"
        )
    } else {
        String::new()
    };
    manifest.phase = "ready".into();
}
fn page_fingerprint(
    topic: &Topic,
    manifest: &Manifest,
    config: &Models,
    citations: &[SourceRef],
) -> String {
    let versions: std::collections::BTreeMap<_, _> = citations
        .iter()
        .map(|r| {
            (
                &r.id,
                manifest
                    .entries
                    .get(&r.id)
                    .map(|e| (&e.revision, e.excluded, e.status.as_str())),
            )
        })
        .collect();
    let model_input = if manifest.wiki_automation.is_some() { json!(config.text_revision) } else { json!(config) };
    let mut inputs = json!([topic.title, topic.purpose, topic.notes, model_input, manifest.sync_root, versions]);
    if let Some(policy) = &manifest.wiki_automation {
        let summaries: Vec<_> = citations.iter().map(|reference| json!([reference.id, manifest.artifacts.get(&reference.id).map(|artifact| &artifact["summaries"])] )).collect();
        inputs.as_array_mut().unwrap().push(json!([policy,summaries]));
    }
    store::digest(inputs.to_string())
}

fn validate_model(model: &Model) -> CommandResult<()> {
    if model.base_url.is_empty() && model.model.is_empty() {
        return Ok(());
    }
    if model.base_url.contains(['{', '}']) {
        return Err(
            "Replace {WorkspaceId} with your Alibaba Cloud Model Studio workspace ID".into(),
        );
    }
    super::normalize_url(&model.base_url)?;
    let url = url::Url::parse(&model.base_url).map_err(|_| "Invalid model API URL")?;
    if url.scheme() != "https"
        && !matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
    {
        return Err("Use HTTPS for model APIs, or a localhost endpoint".into());
    }
    if model.model.trim().is_empty() {
        return Err("A model name is required".into());
    }
    Ok(())
}
fn updated_models(current: &Models, mut next: Models) -> CommandResult<Models> {
    next.embedding.base_url = next.embedding.base_url.trim().trim_end_matches('/').into();
    next.embedding.model = next.embedding.model.trim().into();
    validate_model(&next.embedding)?;
    let unchanged = next.embedding.base_url
        == current.embedding.base_url.trim().trim_end_matches('/')
        && next.embedding.model == current.embedding.model.trim();
    // Preserve existing vector identities when saving the same provider and model.
    next.revision = if unchanged {
        current.revision.clone()
    } else {
        uuid::Uuid::new_v4().to_string()
    };
    next.text_revision = current.text_revision.clone();
    Ok(next)
}
fn embedding_configured(model: &Model) -> bool {
    !model.base_url.is_empty() && !model.model.is_empty() && validate_model(model).is_ok()
}
fn embedding_ready(model: &Model, key: Option<&str>) -> bool {
    if !embedding_configured(model) {
        return false;
    }
    let requires_key = url::Url::parse(&model.base_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .is_some_and(|host| {
            host == "dashscope.aliyuncs.com" || host.ends_with(".maas.aliyuncs.com")
        });
    !requires_key || key.is_some_and(|key| !key.trim().is_empty())
}
fn key_name(session: &Session, kind: &str) -> String {
    format!("wiki-{}-{kind}", session.scope)
}
async fn model_key(
    app: &AppHandle,
    session: &Session,
    kind: &str,
) -> CommandResult<Option<String>> {
    let app = app.clone();
    let key = key_name(session, kind);
    crate::run_secret_io(move || crate::secret_get(&app, &key)).await
}
fn synthesis_client(endpoint: &str) -> CommandResult<reqwest::Client> {
    let endpoint = url::Url::parse(endpoint).map_err(|_| "Invalid synthesis service URL")?;
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(100))
        .redirect(reqwest::redirect::Policy::none());
    let loopback = match endpoint.host() {
        Some(url::Host::Domain("localhost")) => true,
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        _ => false,
    };
    if loopback {
        builder = builder.no_proxy();
    }
    builder.build().map_err(|_| "Network client unavailable".into())
}
fn validate_request_sources(local: &Path, manifest: &Manifest, payload: &Value) -> CommandResult<()> {
    let sources = payload["sources"].as_array().ok_or("AI request has no sources")?;
    for source in sources {
        let id = source["id"].as_str().ok_or("AI request has no source identity")?;
        let entry = manifest.entries.get(id).filter(|entry| store::eligible(entry)).ok_or("Source changed or was excluded; AI request cancelled")?;
        let doc = store::read_document(local,entry)?;
        if !doc.ai_context_enabled || !automation::allows(&doc,manifest) || source["revision"] != doc.revision {
            return Err("Source changed or was excluded; AI request cancelled".into());
        }
    }
    Ok(())
}
async fn request_model(
    app: &AppHandle,
    session: &Session,
    task: &str,
    payload: Value,
) -> CommandResult<Value> {
    let state = app.state::<WorkbenchState>();
    {
        let _guard = state.serial.lock().await;
        super::require_beta(&state)?;
        require_current(&state, session)?;
        let manifest = load_state(app,session)?;
        ready(&manifest)?;
        validate_request_sources(&roots(app,session)?.0,&manifest,&payload)?;
    }
    let authority_docs = {
        let manifest=load_state(app,session)?;
        let (root,_)=roots(app,session)?;
        payload["sources"].as_array().ok_or("Model sources unavailable")?.iter().map(|source| {
            let entry=manifest.entries.get(source["id"].as_str().ok_or("Invalid model source")?).ok_or("Model source unavailable")?;
            store::read_document(&root,entry)
        }).collect::<CommandResult<Vec<_>>>()?
    };
    knowledge_cloud::authorize(app,session,&authority_docs,"wiki_compile").await?;
    let client = synthesis_client(&session.agent_url)?;
    if session.agent_url != session.base_url {
        let response = client
            .post(format!("{}/api/session/backend", session.agent_url))
            .header("Authorization", &session.token)
            .json(&json!({"host":session.base_url}))
            .send()
            .await
            .map_err(|_| "Lynclaw could not verify this server")?;
        if !response.status().is_success() {
            if matches!(response.status().as_u16(), 401 | 403) {
                return Err("Lynclaw authentication failed; sign in again".into());
            }
            return Err("Lynclaw could not verify this server".into());
        }
        let binding: Value = response
            .json()
            .await
            .map_err(|_| "Lynclaw returned an invalid server binding")?;
        if binding["host"]
            .as_str()
            .map(|host| host.trim_end_matches('/'))
            != Some(session.base_url.as_str())
            || binding["user_id"].as_str() != Some(session.user_id.as_str())
        {
            return Err("Lynclaw did not confirm this server identity".into());
        }
    }
    require_current(&state, session)?;
    super::require_beta(&state)?;
    let manifest = load_state(app,session)?;
    ready(&manifest)?;
    validate_request_sources(&roots(app,session)?.0,&manifest,&payload)?;
    let body = lynclaw_payload(session, task, payload);
    let path = if session.agent_url == session.base_url {
        "/api/business/ai/desktop/synthesize"
    } else {
        "/api/desktop/synthesize"
    };
    let result = send_synthesis(
        &client,
        &format!("{}{path}", session.agent_url),
        &session.token,
        body,
        || {
            require_current(&state, session)?;
            super::require_beta(&state)?;
            ready(&load_state(app, session)?)
        },
    )
    .await?;
    knowledge_cloud::authorize(app,session,&authority_docs,"wiki_compile").await?;
    Ok(result)
}
async fn send_synthesis(
    client: &reqwest::Client,
    endpoint: &str,
    token: &str,
    mut body: Value,
    check_current: impl Fn() -> CommandResult<()>,
) -> CommandResult<Value> {
    for attempt in 0..2 {
        check_current()?;
        let response = client
            .post(endpoint)
            .header("Authorization", token)
            .json(&body)
            .send()
            .await
            .map_err(|_| "Lynclaw model service is unavailable")?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let detail = response.json::<Value>().await.unwrap_or(Value::Null);
            if attempt == 0 && status == 422 {
                if let Some(corrected) = corrected_synthesis_request(&body, &detail) {
                    body = corrected;
                    continue;
                }
            }
            return Err(synthesis_error(status, &detail));
        }
        let value: Value = response
            .json()
            .await
            .map_err(|_| "Lynclaw returned invalid synthesis JSON")?;
        return if value.get("code").is_some() {
            if value["code"] != 200 {
                return Err("Lynclaw synthesis failed".into());
            }
            Ok(value["data"].clone())
        } else {
            Ok(value)
        };
    }
    Err("Lynclaw synthesis failed".into())
}
fn corrected_synthesis_request(body: &Value, error: &Value) -> Option<Value> {
    let reason = error["detail"].as_str()?;
    if !matches!(
        reason,
        "Model did not return valid structured output"
            | "Invalid synthesis result"
            | "Invalid summary"
            | "Every claim needs source citations"
            | "Invalid citation"
            | "Citation does not match source evidence"
            | "Citation has an unsupported audio position"
            | "Insufficient evidence must not contain factual output"
            | "Too many synthesis items"
            | "Invalid synthesis item"
            | "Invalid memory kind"
            | "Irrelevant Wiki analysis must contain no claims"
            | "Invalid evidence graph output"
    ) {
        return None;
    }
    let correction = if reason == "Citation does not match source evidence" {
        "Copy each citation's id, revision and kind verbatim from the supplied sources. Copy quote as one contiguous exact substring of that source's text, at most 500 characters. Keep its original punctuation, whitespace and wording; do not join separate passages or quote your own summary. Preserve the project, purpose, corrections and supported uncertainty. Every factual item still needs valid citations; do not invent or discard evidence to bypass validation.".into()
    } else if reason == "Invalid evidence graph output" {
        "Return the same graph with the exact schemaVersion 1 shape. Every node and relation keeps 1-4 citations whose quote is a contiguous exact substring of the supplied source text. Each status, modality, predicate and kind must use exactly the allowed enum values. timeText and dueText must either be empty or a contiguous substring of one of that node's citation quotes, copied without any change. Keep all endpoint keys present and confidence between 0 and 1. Do not invent or drop findings to bypass validation.".into()
    } else if reason == "Invalid memory kind" {
        format!("{MEMORY_KIND_GUIDANCE} Return valid JSON only. Preserve the original statements, citations and uncertainty. For topic_compile, consolidate supported statements in summary and keep memoryItems, todoSuggestions and decisions empty.")
    } else {
        "Keep the same project, purpose and notes above. Return valid JSON only. If insufficientEvidence=true, summary must be empty and all claim/citation arrays must be empty. Otherwise the top-level citations array and each factual item's citations array must contain 1 to 40 references, never more than 40. For topic_compile, keep memoryItems, todoSuggestions and decisions empty, and consolidate supported statements in a concise Markdown summary with short exact original-source citations. If the source supports relevant statements, use insufficientEvidence=false and preserve uncertainty. Do not invent or drop evidence to resolve the validation error.".into()
    };
    let query = format!(
        "{}\n\nResponse correction: the previous output failed validation: {reason}. {correction}",
        body["query"].as_str().unwrap_or_default()
    );
    let limit = if matches!(
        body["task"].as_str(),
        Some("source_analysis" | "topic_compile" | "wiki_catalog")
    ) {
        30000
    } else {
        1000
    };
    if query.chars().count() > limit {
        return None;
    }
    let mut corrected = body.clone();
    corrected["query"] = json!(query);
    Some(corrected)
}
fn synthesis_error(status: u16, body: &Value) -> String {
    if matches!(status, 401 | 403) {
        return "Lynclaw authentication failed; sign in again".into();
    }
    // Only forward fixed validation messages, never echoed request inputs or provider errors.
    let detail = body["detail"].as_str().filter(|detail| {
        matches!(
            *detail,
            "Unknown synthesis task"
                | "Invalid evidence graph output"
                | "Unsupported language"
                | "Invalid project query"
                | "Invalid source id"
                | "Invalid source revision"
                | "Invalid source kind"
                | "Invalid source title"
                | "Invalid source text"
                | "Provide 1–20 sources"
                | "Invalid source segments"
                | "Invalid segment"
                | "Invalid segment time"
                | "Invalid segment time range"
                | "Duplicate source ID"
                | "Source text exceeds the request budget"
                | "Source segments exceed the request budget"
                | "Invalid Wiki evidence budget"
                | "Synthesis exceeds the complete request budget"
                | "Model did not return valid structured output"
                | "Invalid synthesis result"
                | "Invalid summary"
                | "Every claim needs source citations"
                | "Invalid citation"
                | "Citation does not match source evidence"
                | "Citation has an unsupported audio position"
                | "Insufficient evidence must not contain factual output"
                | "Too many synthesis items"
                | "Invalid synthesis item"
                | "Invalid memory kind"
                | "Irrelevant Wiki analysis must contain no claims"
        )
    });
    match detail {
        Some(detail) => format!("Lynclaw synthesis failed (HTTP {status}): {detail}"),
        None => format!("Lynclaw synthesis failed (HTTP {status})"),
    }
}
fn lynclaw_payload(session: &Session, task: &str, payload: Value) -> Value {
    let query = if task == "source_analysis" {
        json!(format!(
            "{}\n\n{MEMORY_KIND_GUIDANCE}",
            payload["topic"].as_str().unwrap_or_default()
        ))
    } else {
        payload["topic"].clone()
    };
    json!({"task":task,"language":session.locale,"query":query,"sources":payload["sources"],"evidence":payload["evidence"],"modelOverride":session.model_override})
}
pub(super) async fn synthesize(
    app: &AppHandle,
    session: &Session,
    task: &str,
    documents: &[Document],
    query: Option<&str>,
) -> CommandResult<Value> {
    let mut budget = 60_000;
    let sources:Vec<_>=documents.iter().cloned().filter_map(super::markdown::source).filter_map(|doc|{if budget==0{return None;} let text=doc.text().chars().take(budget.min(12_000)).collect::<String>();budget-=text.chars().count();Some(json!({"id":doc.id,"revision":doc.revision,"kind":doc.kind,"title":doc.title,"text":text,"segments":doc.segments}))}).collect();
    if sources.is_empty() {
        return Err("No Markdown meeting text is available for AI processing".into());
    }
    request_model(app, session, task, json!({"topic":query,"sources":sources})).await
}
fn sources_for(root: &Path, manifest: &Manifest) -> Vec<Document> {
    manifest
        .entries
        .values()
        .filter(|e| store::eligible(e))
        .filter_map(|e| store::read_document(root, e).ok())
        .filter_map(super::markdown::source)
        .filter(|doc| automation::allows(doc, manifest))
        .collect()
}
fn valid_page(root: &Path, manifest: &Manifest, page: &Revision) -> bool {
    PageSources::new(root, manifest).valid_page(page)
}

struct PageSources<'a> {
    root: &'a Path,
    manifest: &'a Manifest,
    documents: std::collections::BTreeMap<(String, String), Option<Document>>,
}

impl<'a> PageSources<'a> {
    fn new(root: &'a Path, manifest: &'a Manifest) -> Self {
        Self { root, manifest, documents: Default::default() }
    }

    fn document(&mut self, reference: &SourceRef) -> Option<&Document> {
        let root = self.root;
        let manifest = self.manifest;
        self.documents.entry((reference.id.clone(), reference.kind.clone()))
            .or_insert_with(|| {
                manifest.entries.get(&reference.id)
                    .and_then(|entry| store::read_document(root, entry).ok())
                    .map(|doc| automation::citation_document(doc, manifest, &reference.kind))
                    .filter(|doc| automation::allows(doc, manifest))
            }).as_ref()
    }

    fn valid_page(&mut self, page: &Revision) -> bool {
        if page.citations.is_empty()
            || (matches!(page.review.as_str(), "approved" | "auto_validated")
                && page.content_hash != store::digest(&page.markdown))
        {
            return false;
        }
        let manifest = self.manifest;
        page.citations.iter().all(|reference| {
            self.document(reference).is_some_and(|doc| {
                sync::validate_result(std::slice::from_ref(doc), manifest, &json!({"citations":[reference]})).is_ok()
            })
        })
    }
}
pub(super) fn context(
    app: &AppHandle,
    session: &Session,
    manifest: &Manifest,
    query: &str,
) -> CommandResult<Vec<Value>> {
    let (root, _) = roots(app, session)?;
    let mut pages = Vec::new();
    for topic in topics(&wiki_root(app, session)?)? {
        if topic.excluded {
            continue;
        }
        if let Some(ref page) = topic.published {
            if citable(&topic, &root, manifest, &models(app, session)?)
                && (query.is_empty()
                    || store::query_terms(query).iter().any(|term| {
                        format!("{} {} {}", topic.title, topic.purpose, page.markdown)
                            .to_lowercase()
                            .contains(term)
                    }))
            {
                // Cite the reviewed page as a page; its reader exposes every underlying meeting citation.
                pages.push(json!({"id":format!("wiki:{}",topic.id),"title":topic.title,"kind":"wiki","excerpt":page.markdown.chars().take(1800).collect::<String>(),"source":{"id":format!("wiki:{}",topic.id),"kind":"wiki","revision":page.content_hash,"quote":store::evidence_excerpt(&page.markdown,query,1800)},"citations":page.citations}));
            }
        }
    }
    pages.truncate(2);
    Ok(pages)
}
fn citable(topic: &Topic, local: &Path, manifest: &Manifest, config: &Models) -> bool {
    !topic.excluded && topic.candidate.is_none() && topic.error.is_empty()
        && topic.published.as_ref().is_some_and(|page| matches!(page.review.as_str(), "approved" | "auto_validated")
            && page.fingerprint == page_fingerprint(topic,manifest,config,&page.citations)
            && valid_page(local,manifest,page))
}
pub(super) fn read_page(app: &AppHandle, session: &Session, id: &str) -> CommandResult<Value> {
    let topic = topics(&wiki_root(app, session)?)?
        .into_iter()
        .find(|t| topic_store::matches_id(t, id.strip_prefix("wiki:").unwrap_or(id)))
        .ok_or("Wiki page not found")?;
    let page = topic
        .published
        .ok_or("This Wiki page has not been published")?;
    let mut document = serde_json::to_value(Document {
        id: id.into(),
        kind: "wiki".into(),
        title: topic.title,
        revision: store::digest(&page.markdown),
        transcript: page.markdown.clone(),
        ..Default::default()
    })
    .map_err(|e| e.to_string())?;
    document["citations"] = json!(page.citations);
    Ok(json!({"document":document,"markdown":page.markdown,"artifacts":Value::Null}))
}

fn analysis_citations(result: &Value) -> impl Iterator<Item = &Value> {
    std::iter::once(result)
        .chain(
            ["memoryItems", "todoSuggestions", "decisions"]
                .into_iter()
                .flat_map(|key| result[key].as_array().into_iter().flatten()),
        )
        .flat_map(|item| item["citations"].as_array().into_iter().flatten())
}

#[derive(Clone, Serialize)]
#[serde(transparent)]
struct CompilationEvidence {
    value: Value,
    #[serde(skip)]
    source: Document,
}

fn compile_sources(evidence: &[CompilationEvidence]) -> CommandResult<Vec<Value>> {
    let mut grouped: std::collections::BTreeMap<String, Vec<String>> =
        std::collections::BTreeMap::new();
    for result in evidence {
        // Auxiliary summaries can quote passages absent from their structured citations.
        // Preserve the complete bounded source that produced each analysis.
        let text = result.source.text();
        let text = text.trim();
        if text.is_empty() {
            return Err("Wiki analysis source is empty".into());
        }
        let values = grouped.entry(result.source.id.clone()).or_default();
        if !values.iter().any(|value| value == text) {
            values.push(text.to_owned());
        }
    }
    if grouped.len() > 20 {
        return Err("Too many sources in one compilation batch".into());
    }
    let mut total = 0;
    grouped.into_iter().map(|(id, parts)| {
        let doc = &evidence.iter().find(|item| item.source.id == id)
            .ok_or("Analysis source no longer exists")?.source;
        if evidence.iter().any(|item| item.source.id == id
            && (item.source.revision != doc.revision || item.source.kind != doc.kind)) {
            return Err("Analysis source changed during compilation".into());
        }
        let text = parts.join("\n\n");
        total += text.chars().count();
        if text.chars().count() > 12000 || total > 60000 {
            return Err("Topic evidence exceeds one compilation batch; shorten this topic or retry".into());
        }
        let segments: Vec<_> = evidence.iter()
            .flat_map(|item| analysis_citations(&item.value))
            .filter(|reference| reference["id"] == doc.id && ["segmentId", "startMs", "endMs"].iter().any(|key| reference.get(*key).is_some_and(|value| !value.is_null())))
            .map(|reference| {
                let mut segment = json!({"id":reference["segmentId"].as_str().unwrap_or_default(),"text":reference["quote"]});
                for key in ["startMs", "endMs"] {
                    if let Some(value) = reference.get(key).filter(|value| !value.is_null()) {
                        segment[key] = value.clone();
                    }
                }
                segment
            }).collect();
        Ok(json!({"id":doc.id,"kind":doc.kind,"revision":doc.revision,"title":doc.title,"text":text,"segments":segments}))
    }).collect()
}

fn compilation_query(query: &str) -> String {
    format!("{query}\n\nWiki page output: Return one compact JSON object with summary, citations and insufficientEvidence. Put the Wiki Markdown in summary, keeping it within 3000 characters. Use short exact original-source quotations in citations. Return empty memoryItems, todoSuggestions and decisions arrays; these intermediate records are already supplied as evidence. Preserve supported uncertainty and conflicts in the Markdown. Do not repeat the supplied analysis or source text as extra JSON fields. Return no code fences or text outside JSON.")
}

async fn cached_compilation(
    root: &Path,
    key: &str,
    serial: &tokio::sync::Mutex<()>,
    validate: impl Fn(&Value) -> CommandResult<()>,
    use_cache: bool,
    generate: impl std::future::Future<Output = CommandResult<Value>>,
) -> CommandResult<Value> {
    if use_cache {
        let _guard = serial.lock().await;
        if let Some(value) = receipt(root, key)? {
            if validate(&value).is_ok() {
                return Ok(value);
            }
        }
    }
    job(root, key, "running", None, "")?;
    let response = generate.await;
    let _guard = serial.lock().await;
    let result = response.and_then(|value| {
        validate(&value)?;
        Ok(value)
    });
    match result {
        Ok(value) => {
            job(root, key, "done", Some(&value), "")?;
            Ok(value)
        }
        Err(error) => {
            job(root, key, "failed", None, &error)?;
            Err(error)
        }
    }
}

async fn compile(
    app: &AppHandle,
    state: &WorkbenchState,
    session: &Session,
    topic: &Topic,
    config: &Models,
    manifest: &Manifest,
    root: &Path,
    local: &Path,
) -> CommandResult<Revision> {
    let docs = sources_for(local, manifest);
    let analysis_total = docs
        .iter()
        .map(|doc| sync::split_text(&doc.text(), 12_000).len())
        .sum();
    let mut analyzed = 0;
    let mut evidence = Vec::new();
    let query = format!(
        "{}\n{}\nUser corrections and notes: {}",
        topic.title, topic.purpose, topic.notes
    );
    for doc in &docs {
        for (index, chunk) in sync::split_text(&doc.text(), 12_000).iter().enumerate() {
            require_current(state, session)?;
            let key = store::digest(
                json!([
                    "source-analysis-v1",
                    topic.title,
                    topic.purpose,
                    topic.notes,
                    config,
                    doc.id,
                    doc.revision,
                    index
                ])
                .to_string(),
            );
            let part = analysis::part(doc, chunk.clone());
            let results = analysis::with_recovery(part.clone(), |part| {
                let key = if part.transcript == *chunk {
                    key.clone()
                } else {
                    store::digest(json!([key, "citation-recovery-v1", part.transcript]).to_string())
                };
                let query = &query;
                async move {
                    cached_compilation(
                        root,
                        &key,
                        &state.serial,
                        |value| {
                            require_current(state, session)?;
                            let latest = load_state(app, session)?;
                            ready(&latest)?;
                            if !store::is_current_document(local, &latest, doc) {
                                return Err("Source changed during analysis".into());
                            }
                            sync::validate_result(std::slice::from_ref(&part), &latest, value)
                        },
                        true,
                        async {
                            report_progress(
                                app,
                                state,
                                session,
                                WikiProgress {
                                    stage: "analyzing".into(),
                                    completed: analyzed,
                                    total: analysis_total,
                                    current_title: doc.title.clone(),
                                    topic_title: topic.title.clone(),
                                    ..Default::default()
                                },
                            )
                            .await?;
                            synthesize(
                                app,
                                session,
                                "source_analysis",
                                std::slice::from_ref(&part),
                                Some(query),
                            )
                            .await
                        },
                    )
                    .await
                }
            })
            .await?;
            for result in results {
                if result["relevant"] != false && result["insufficientEvidence"] != true {
                    evidence.push(CompilationEvidence {
                        value: result,
                        source: part.clone(),
                    });
                }
            }
            analyzed += 1;
        }
    }
    if evidence.is_empty() {
        return Err("No relevant source evidence found for this topic".into());
    }
    let page_query = compilation_query(&query);
    let cache_key =
        store::digest(json!(["topic-compile-v2", page_query, config, evidence]).to_string());
    if let Some(value) = receipt(root, &cache_key)?.filter(|_| !topic.force_refresh) {
        if let Ok(mut page) = serde_json::from_value::<Revision>(value) {
            if uuid::Uuid::parse_str(&page.id).is_ok()
                && valid_page(local, manifest, &page)
                && page.fingerprint == page_fingerprint(topic, manifest, config, &page.citations)
            {
                page.markdown = assemble_page(&topic.title, &[page.markdown]);
                page.content_hash = store::digest(&page.markdown);
                return Ok(page);
            }
        }
    }
    // Partition large evidence sets; each compiler request stays bounded and covers the entire set.
    let mut summaries = Vec::new();
    let mut citations = Vec::new();
    let mut batches = Vec::new();
    let mut current = Vec::new();
    for item in evidence {
        let mut trial = current.clone();
        trial.push(item.clone());
        if !current.is_empty()
            && (serde_json::to_string(&trial)
                .map_err(|e| e.to_string())?
                .len()
                > 50000
                || compile_sources(&trial).is_err()
                || trial.len() > 100)
        {
            batches.push(std::mem::take(&mut current));
        }
        current.push(item);
        compile_sources(&current)?;
    }
    if !current.is_empty() {
        batches.push(current);
    }
    let batch_total = batches.len();
    for (index, batch) in batches.into_iter().enumerate() {
        let sources = compile_sources(&batch)?;
        let key = store::digest(
            json!(["topic-batch-v1", page_query, config, batch, sources]).to_string(),
        );
        let result = cached_compilation(
            root,
            &key,
            &state.serial,
            |value| {
                require_current(state, session)?;
                let latest = load_state(app, session)?;
                ready(&latest)?;
                sync::validate_result(&docs, &latest, value)
            },
            !topic.force_refresh,
            async {
                report_progress(
                    app,
                    state,
                    session,
                    WikiProgress {
                        stage: "compiling".into(),
                        completed: index,
                        total: batch_total,
                        topic_title: topic.title.clone(),
                        ..Default::default()
                    },
                )
                .await?;
                request_model(
                    app,
                    session,
                    "topic_compile",
                    json!({"topic":page_query,"evidence":batch,"sources":sources}),
                )
                .await
            },
        )
        .await?;
        if result["insufficientEvidence"] == true {
            continue;
        }
        summaries.push(
            result["summary"]
                .as_str()
                .ok_or("Wiki page has no Markdown")?
                .to_owned(),
        );
        let refs: Vec<SourceRef> = serde_json::from_value(result["citations"].clone())
            .map_err(|_| "Invalid Wiki citations")?;
        citations.extend(refs);
    }
    if summaries.is_empty() || citations.is_empty() {
        return Err("Wiki page has no supported evidence".into());
    }
    let markdown = assemble_page(&topic.title, &summaries);
    Ok(Revision {
        content_hash: store::digest(&markdown),
        id: uuid::Uuid::new_v4().to_string(),
        markdown,
        fingerprint: page_fingerprint(topic, manifest, config, &citations),
        citations,
        cache_key,
        created_at: crate::now(),
        ..Default::default()
    })
}

pub(super) async fn run(
    app: &AppHandle,
    state: &WorkbenchState,
    session: &Session,
) -> CommandResult<()> {
    if load_state(app, session)?.wiki_automation.is_some() {
        automation::run(app,state,session).await?;
        if publish_memory_events(app,state,session).await.is_err() { log::warn!("[knowledge-memory] candidate dispatch pending; Wiki publication preserved"); }
        return Ok(());
    }
    collections::run(app,state,session).await?;
    let (root, local, config, initial) = {
        let _guard = state.serial.lock().await;
        require_current(state, session)?;
        let mut manifest = load_state(app, session)?;
        if !manifest.enabled || !manifest.allow_ai || !manifest.initial_complete {
            return Ok(());
        }
        backup_legacy(app, session)?;
        let config = models(app, session)?;
        ready(&manifest)?;
        let root = wiki_root(app, session)?;
        let mut initial = topics(&root)?;
        let repaired_titles = repair_page_titles(&root, &mut initial)?;
        let previous_inputs = manifest.wiki_attempted_fingerprint.clone();
        if !needs_processing(&mut manifest, &initial, &config) {
            let restore_progress = manifest.wiki_progress.is_none();
            if restore_progress {
                complete_processing(&mut manifest, &initial, 0);
            }
            if repaired_titles
                || restore_progress
                || manifest.wiki_attempted_fingerprint != previous_inputs
            {
                persist(app, session, &manifest)?;
            }
            return Ok(());
        }
        manifest.phase = "processing".into();
        if manifest.wiki_progress.as_ref().is_none_or(|progress| progress.stage == "complete") {
            manifest.wiki_progress = Some(WikiProgress {
                stage: "preparing".into(),
                ..Default::default()
            });
        }
        persist(app, session, &manifest)?;
        let local = roots(app, session)?.0;
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        // Preserve the old memory exactly once. It remains editable in the existing reader.
        backup_legacy(app, session)?;
        let conn = db(&root)?;
        conn.execute("DELETE FROM sources", [])
            .map_err(|e| e.to_string())?;
        for doc in sources_for(&local, &manifest) {
            conn.execute(
                "INSERT INTO sources VALUES (?1,?2,?3,?4)",
                params![doc.id, doc.revision, doc.title, doc.text()],
            )
            .map_err(|e| e.to_string())?;
        }
        (root, local, config, initial)
    };
    for topic in initial {
        if topic.pinned || topic.excluded {
            continue;
        }
        let manifest = {
            let _guard = state.serial.lock().await;
            require_current(state, session)?;
            let m = load_state(app, session)?;
            ready(&m)?;
            m
        };
        let version = fingerprint(&topic, &manifest, &config);
        if !needs_compilation(&topic, &manifest, &config) {
            continue;
        }
        let task = store::digest(format!("compile:{}:{version}", topic.id));
        job(&root, &task, "running", None, "")?;
        let result = compile(
            app, state, session, &topic, &config, &manifest, &root, &local,
        )
        .await;
        if let Err(error) = &result {
            if is_service_failure(error) {
                return Err(error.clone());
            }
        }
        let _guard = state.serial.lock().await;
        require_current(state, session)?;
        let latest = load_state(app, session)?;
        ready(&latest)?;
        let mut values = topics(&root)?;
        let Some(current) = values.iter_mut().find(|t| t.id == topic.id) else {
            continue;
        };
        if fingerprint(current, &latest, &models(app, session)?) != version
            || current.pinned
            || current.excluded
        {
            continue;
        }
        match result {
            Ok(page) => {
                if !valid_page(&local, &latest, &page) {
                    return Err("Sources changed; candidate discarded".into());
                }
                job(
                    &root,
                    &page.cache_key,
                    "done",
                    Some(&serde_json::to_value(&page).map_err(|e| e.to_string())?),
                    "",
                )?;
                let already_reviewed = !current.force_refresh
                    && (current
                        .published
                        .as_ref()
                        .is_some_and(|p| p.cache_key == page.cache_key)
                        || current
                            .history
                            .iter()
                            .any(|p| p.cache_key == page.cache_key && p.review == "rejected"));
                if !already_reviewed
                    && current
                        .candidate
                        .as_ref()
                        .is_none_or(|p| p.cache_key != page.cache_key)
                {
                    if let Some(old) = current.candidate.take() {
                        current.history.push(old);
                    }
                    save_page(&root, current, &page, true)?;
                    current.candidate = Some(page);
                }
                current.force_refresh = false;
                current.last_fingerprint = version;
                current.last_attempt_fingerprint = current.last_fingerprint.clone();
                current.error.clear();
                current.failure = None;
                job(&root, &task, "done", None, "")?;
            }
            Err(error) => {
                current.force_refresh = false;
                current.last_attempt_fingerprint = version;
                current.error = error.clone();
                current.failure = Some(WikiFailure::new(
                    &error,
                    latest.wiki_progress.as_ref().map(|progress| progress.stage.as_str()).unwrap_or("preparing"),
                    current.source_ids.clone(),
                ));
                job(&root, &task, "failed", None, &error)?;
            }
        }
        save_topics(&root, &values)?;
        persist(app, session, &latest)?;
    }
    let embedding_failures = embed_sources(app, state, session, &config, &root, &local).await?;
    let _guard = state.serial.lock().await;
    require_current(state, session)?;
    let mut manifest = load_state(app, session)?;
    manifest.wiki_attempted_fingerprint = inputs_fingerprint(&manifest, &config);
    complete_processing(&mut manifest, &topics(&root)?, embedding_failures);
    persist(app, session, &manifest)
}

pub(super) async fn discover(
    app: &AppHandle,
    state: &WorkbenchState,
    session: &Session,
) -> CommandResult<bool> {
    graph::run(app, state, session).await
}

async fn embedding(
    app: &AppHandle,
    state: &WorkbenchState,
    session: &Session,
    config: &Models,
    text: &str,
    api_key: Option<&str>,
) -> CommandResult<Vec<f64>> {
    require_current(state, session)?;
    ready(&load_state(app, session)?)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let mut request = client.post(format!(
        "{}/embeddings",
        config.embedding.base_url.trim_end_matches('/')
    ));
    if let Some(key) = api_key {
        request = request.bearer_auth(key);
    }
    require_current(state, session)?;
    ready(&load_state(app, session)?)?;
    let response=request.json(&json!({"model":config.embedding.model,"input":text.chars().take(8000).collect::<String>()})).send().await.map_err(|_|"Embedding API is unavailable")?;
    if !response.status().is_success() {
        return Err(format!(
            "Embedding request failed (HTTP {})",
            response.status().as_u16()
        ));
    }
    let value: Value = response
        .json()
        .await
        .map_err(|_| "Invalid embedding response")?;
    let vector: Vec<f64> = serde_json::from_value(value["data"][0]["embedding"].clone())
        .map_err(|_| "Invalid embedding vector")?;
    if vector.is_empty() || vector.len() > 65536 || vector.iter().any(|n| !n.is_finite()) {
        return Err("Invalid embedding dimensions".into());
    }
    Ok(vector)
}
fn cosine(left: &[f64], right: &[f64]) -> Option<f64> {
    if left.is_empty() || left.len() != right.len() {
        return None;
    }
    let dot: f64 = left.iter().zip(right).map(|(a, b)| a * b).sum();
    let norm = left.iter().map(|a| a * a).sum::<f64>().sqrt()
        * right.iter().map(|a| a * a).sum::<f64>().sqrt();
    if norm <= 0.0 {
        return None;
    }
    Some(dot / norm)
}
fn embedding_revision(config: &Models) -> String {
    store::digest(json!([super::markdown::INPUT_VERSION, config.revision]).to_string())
}
fn embedding_cached(root: &Path, doc: &Document, config: &Models) -> CommandResult<bool> {
    db(root)?
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM vectors WHERE id=?1 AND revision=?2 AND model_revision=?3)",
            params![doc.id, doc.revision, embedding_revision(config)],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
}
pub(super) async fn semantic_search(
    app: &AppHandle,
    state: &WorkbenchState,
    session: &Session,
    query: &str,
) -> CommandResult<Vec<Value>> {
    let config = models(app, session)?;
    if !embedding_configured(&config.embedding) || query.trim().is_empty() {
        return Ok(vec![]);
    }
    let key = model_key(app, session, "embedding").await?;
    if !embedding_ready(&config.embedding, key.as_deref()) {
        return Ok(vec![]);
    }
    let vector = embedding(app, state, session, &config, query, key.as_deref()).await?;
    let _guard = state.serial.lock().await;
    require_current(state, session)?;
    let manifest = load_state(app, session)?;
    ready(&manifest)?;
    let root = wiki_root(app, session)?;
    let local = roots(app, session)?.0;
    let conn = db(&root)?;
    let mut stmt = conn
        .prepare("SELECT id,revision,embedding FROM vectors WHERE model_revision=?")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([embedding_revision(&config)], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut ranked = Vec::new();
    for row in rows {
        let (id, revision, raw) = row.map_err(|e| e.to_string())?;
        let Some(entry) = manifest
            .entries
            .get(&id)
            .filter(|e| store::eligible(e) && e.revision == revision)
        else {
            continue;
        };
        let Some(doc) = store::read_document(&local, entry)
            .ok()
            .and_then(super::markdown::source)
            .filter(|doc| automation::allows(doc, &manifest))
        else {
            continue;
        };
        let other: Vec<f64> = serde_json::from_str(&raw).unwrap_or_default();
        if let Some(score) = cosine(&vector, &other).filter(|s| s.is_finite() && *s > 0.25) {
            ranked.push((score, doc));
        }
    }
    ranked.sort_by(|a, b| b.0.total_cmp(&a.0));
    Ok(ranked.into_iter().take(10).map(|(_,doc)|json!({"id":doc.id,"title":doc.title,"kind":doc.kind,"excerpt":store::evidence_excerpt(&doc.text(),query,1800),"source":doc.reference()})).collect())
}
async fn embed_sources(
    app: &AppHandle,
    state: &WorkbenchState,
    session: &Session,
    config: &Models,
    root: &Path,
    local: &Path,
) -> CommandResult<usize> {
    if !embedding_configured(&config.embedding) {
        return Ok(0);
    }
    let key = model_key(app, session, "embedding").await?;
    if !embedding_ready(&config.embedding, key.as_deref()) {
        return Ok(0);
    }
    let manifest = load_state(app, session)?;
    ready(&manifest)?;
    let mut failures = 0;
    let docs = sources_for(local, &manifest);
    let total = docs.len();
    for (index, doc) in docs.into_iter().enumerate() {
        if embedding_cached(root, &doc, config)? {
            continue;
        }
        report_progress(
            app,
            state,
            session,
            WikiProgress {
                stage: "embedding".into(),
                completed: index,
                total,
                current_title: doc.title.clone(),
                failed: failures,
                ..Default::default()
            },
        )
        .await?;
        let latest = load_state(app,session)?;
        if validate_request_sources(local,&latest,&json!({"sources":[{"id":doc.id,"revision":doc.revision}]})).is_err() { continue; }
        let vector = match embedding(app, state, session, config, &doc.text(), key.as_deref()).await
        {
            Ok(vector) => vector,
            Err(_) => {
                require_current(state, session)?;
                failures += 1;
                continue;
            }
        };
        let _guard = state.serial.lock().await;
        require_current(state, session)?;
        let latest = load_state(app, session)?;
        ready(&latest)?;
        if store::is_current_document(local, &latest, &doc) {
            db(root)?
                .execute(
                    "INSERT OR REPLACE INTO vectors VALUES (?1,?2,?3,?4)",
                    params![
                        doc.id,
                        doc.revision,
                        embedding_revision(config),
                        json!(vector).to_string()
                    ],
                )
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(failures)
}

#[tauri::command]
pub async fn workbench_wiki(
    app: AppHandle,
    state: State<'_, WorkbenchState>,
    request: Value,
) -> CommandResult<Value> {
    super::require_beta(&state)?;
    let action = request["action"].as_str().unwrap_or("state");
    // Topic edits are checked by compilation fingerprints; repeated creation cannot cancel work.
    let incremental_action = matches!(
        action,
        "topic" | "topic_link" | "correction" | "tracking" | "tracking_retry" | "tracking_dismiss" | "tracking_restore" | "tracking_sources" | "tracking_review" | "tracking_reset" | "tracking_merge" | "tracking_unmerge" | "tracking_todo"
    );
    let session = if action == "state" || incremental_action {
        current(&state)?
    } else {
        invalidate_runtime(&state)?
    };
    let _guard = state.serial.lock().await;
    require_current(&state, &session)?;
    let root = wiki_root(&app, &session)?;
    let mut values = topics(&root)?;
    let mut config = models(&app, &session)?;
    let mut created_topic_id: Option<String> = None;
    match action {
        "state" => {}
        "source_folders" => {
            let ids: Vec<String> = serde_json::from_value(request["ids"].clone()).map_err(|_| "Invalid moved meetings")?;
            let folder = request["folderId"].as_str().filter(|id| id.len() <= 250).ok_or("Invalid destination folder")?;
            if ids.len() > 1000 { return Err("Too many moved meetings".into()); }
            let local = roots(&app,&session)?.0;
            let mut manifest = load_state(&app,&session)?;
            automation::move_sources(&local,&mut manifest,&ids,folder)?;
            persist(&app,&session,&manifest)?;
        }
        "tracking" | "tracking_retry" | "tracking_dismiss" | "tracking_restore" | "tracking_sources" | "tracking_review" | "tracking_reset" | "tracking_merge" | "tracking_unmerge" => {
            graph::configure(&root, &request)?;
            state.discovery_requested.notify_one();
        }
        "tracking_todo" => {
            let manifest = load_state(&app, &session)?;
            graph::confirm_todo(&app, &session, &root, &roots(&app, &session)?.0, &manifest, request["id"].as_str().ok_or("Invalid graph task")?)?;
        }
        "sources" => {
            super::sources::configure(&app, &session, &request["sources"])?;
        }
        "models" => {
            let next: Models = serde_json::from_value(request["models"].clone())
                .map_err(|_| "Invalid Wiki model configuration")?;
            let next = updated_models(&config, next)?;
            for kind in ["embedding"] {
                if let Some(value) = request.get(format!("{kind}Key")) {
                    let app = app.clone();
                    let name = key_name(&session, kind);
                    let value = value.as_str().unwrap_or_default().trim().to_owned();
                    crate::run_secret_io(move || {
                        if value.is_empty() {
                            crate::secret_delete(&app, &name)
                        } else {
                            crate::secret_set(&app, &name, &value)
                        }
                    })
                    .await?;
                }
            }
            require_current(&state, &session)?;
            write_json(&models_path(&app, &session)?, &next)?;
            config = next;
        }
        "topic" => {
            topic_store::upsert(&root, &mut values, &request)?;
            created_topic_id = values.iter().find(|topic| {
                request["id"].as_str().is_some_and(|id| topic_store::matches_id(topic,id))
                    || (request["id"].is_null() && topic.title == request["title"].as_str().unwrap_or_default().trim()
                        && topic.collection.is_some() == (request["mode"] == "collection"))
            }).map(|topic| topic.id.clone());
        }
        "topic_link" => { collections::edit_link(&mut values, &request)?; save_topics(&root, &values)?; }
        "correction" => {
            let notes = request["notes"].as_str().filter(|notes| notes.chars().count() <= 20000).ok_or("Correction is too long")?;
            let topic = values.iter_mut().find(|topic| request["id"].as_str().is_some_and(|id| topic_store::matches_id(topic, id))).ok_or("Topic not found")?;
            topic.notes = notes.to_owned();
            topic.force_refresh = true;
            topic.last_attempt_fingerprint.clear();
            topic.error.clear();
            save_topics(&root, &values)?;
        }
        "topic_delete" => {
            topic_store::delete(&root, &mut values, &request)?;
        }
        "review" => {
            let topic = values
                .iter_mut()
                .find(|t| {
                    request["id"]
                        .as_str()
                        .is_some_and(|id| topic_store::matches_id(t, id))
                })
                .ok_or("Topic not found")?;
            let mut page = topic.candidate.clone().ok_or("No candidate to review")?;
            if Some(page.id.as_str()) != request["candidateId"].as_str() {
                return Err("Candidate changed; reload before review".into());
            }
            if request["approve"] == true {
                let manifest = load_state(&app, &session)?;
                ready(&manifest)?;
                if page.fingerprint != page_fingerprint(topic, &manifest, &config, &page.citations)
                    || !valid_page(&roots(&app, &session)?.0, &manifest, &page)
                {
                    return Err(
                        "Sources changed; regenerate this candidate before publishing".into(),
                    );
                }
                if let Some(markdown) = request["markdown"].as_str() {
                    if markdown.trim().is_empty() || markdown.chars().count() > 200000 {
                        return Err("Invalid page content".into());
                    }
                    page.markdown = markdown.into();
                }
                page.content_hash = store::digest(&page.markdown);
                page.reviewed_at = crate::now();
                page.review = "approved".into();
                if let Some(old) = topic.published.take() {
                    topic.history.push(old);
                }
                save_page(&root, topic, &page, false)?;
                topic.published = Some(page.clone());
            } else {
                page.reviewed_at = crate::now();
                page.review = "rejected".into();
            }
            write_json(
                &root
                    .join(&topic.id)
                    .join("reviews")
                    .join(format!("{}.json", page.id)),
                &page,
            )?;
            topic.history.push(page);
            topic.candidate = None;
            save_topics(&root, &values)?;
        }
        "retry" => {}
        _ => return Err("Unknown Wiki operation".into()),
    }
    let mut manifest = load_state(&app, &session)?;
    let reconciled = if action == "retry" {
        retry_failed_work(&root, &mut values, &mut manifest, request["id"].as_str())?;
        if request["id"].is_null() {
            state.discovery_requested.notify_one();
        }
        false
    } else {
        topic_store::reconcile_progress(&mut manifest, &values)
    };
    let local = roots(&app, &session)?.0;
    if action != "state" || reconciled {
        persist(&app, &session, &manifest)?;
        if action != "state" && crate::vault::load_vault_config(&app)?.enabled {
            if matches!(action, "retry" | "topic" | "topic_link" | "correction") && ready(&manifest).is_ok() {
                state.wiki_requested.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            start_worker(&app, &state);
            if matches!(action, "retry" | "topic" | "topic_link" | "correction") {
                state.sync_requested.notify_one();
            }
        }
    }
    // Rendering a snapshot must not hold the worker's mutation lock while reading sources.
    drop(_guard);
    let mut page_sources = PageSources::new(&local, &manifest);
    let items: Vec<_> = values
        .iter()
        .map(|topic| {
            let mut value = serde_json::to_value(topic).unwrap_or_default();
            collections::filter_view(&mut value, &values, &mut page_sources, &manifest);
            value["inScope"] = json!(topic.collection.is_some() || manifest.wiki_automation.is_none() || topic.published.as_ref().is_some_and(|page| !page.citations.is_empty() && page.citations.iter().all(|reference| page_sources.document(reference).is_some())));
            value["stale"] = json!(topic.published.as_ref().is_some_and(|p| topic
                .candidate
                .is_some()
                || !topic.error.is_empty()
                || p.fingerprint != page_fingerprint(topic, &manifest, &config, &p.citations)
                || !page_sources.valid_page(p)));
            value
        })
        .collect();
    let mut graph = graph::view(&root, &local, &manifest, &values, &config)?;
    graph::attach_todos(&app, &session, &root, &mut graph)?;
    let topic_graph = automation::topic_graph(&values, &items);
    require_current(&state, &session)?;
    Ok(json!({"topics":items,"models":config,"sources":super::sources::config(&app,&session)?,"graph":graph,"topicGraph":topic_graph,"automation":manifest.wiki_automation,"createdTopicId":created_topic_id}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn page_batches_share_one_title_without_changing_facts_or_code_blocks() {
        let summaries = vec![
            "# 灵光记 项目 Wiki 候选\n\n## 决策\nFriday remains a proposal.\n\n```markdown\n# 灵光记 项目状态（Wiki 候选）\n```".into(),
            "# 灵光记 · 项目状态（Wiki 候选）\n\n## 未决问题\nFriday was rejected in another meeting.".into(),
            "## 灵光记项目状态（Wiki 候选稿）\n\n## 与灵光记归属未确认\nThe relationship remains unknown.".into(),
        ];
        let markdown = assemble_page("灵光记", &summaries);
        assert!(markdown.starts_with("# 灵光记\n\n## 决策"));
        assert_eq!(page_body("灵光记", &markdown).1, 1);
        for text in [
            "Friday remains a proposal.",
            "Friday was rejected in another meeting.",
            "## 与灵光记归属未确认\nThe relationship remains unknown.",
            "```markdown\n# 灵光记 项目状态（Wiki 候选）\n```",
        ] {
            assert!(markdown.contains(text));
        }
        assert_eq!(assemble_page("灵光记", &[markdown.clone()]), markdown);
        assert!(!is_page_title("灵光记", "灵光记的发布日期仍未确认"));
        assert!(!is_page_title("Alpha", "Alphabet project status"));
    }
    #[test]
    fn legacy_page_title_repair_preserves_review_citations_backups_and_manual_edits() {
        for candidate in [false, true] {
            let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
            let mut topic = Topic {
                id: uuid::Uuid::new_v4().to_string(),
                title: "灵光记".into(),
                last_fingerprint: "unchanged-inputs".into(),
                ..Default::default()
            };
            let page = Revision {
                id: uuid::Uuid::new_v4().to_string(),
                markdown: "# 灵光记 项目 Wiki 候选\n\nFriday is tentative.\n\n---\n\n## 灵光记项目状态（Wiki 候选稿）\n\nNo date was approved.".into(),
                citations: vec![SourceRef {
                    id: "meeting".into(),
                    kind: "meeting".into(),
                    revision: "r1".into(),
                    quote: "Friday is tentative.".into(),
                    ..Default::default()
                }],
                review: if candidate { "" } else { "approved" }.into(),
                reviewed_at: if candidate { "" } else { "review-time" }.into(),
                cache_key: "existing-cache".into(),
                ..Default::default()
            };
            let page = Revision {
                content_hash: store::digest(&page.markdown),
                ..page
            };
            if candidate {
                topic.candidate = Some(page.clone());
            } else {
                topic.published = Some(page.clone());
            }
            save_page(&root, &topic, &page, candidate).unwrap();
            save_topics(&root, &[topic.clone()]).unwrap();
            let mut values = topics(&root).unwrap();
            assert!(repair_page_titles(&root, &mut values).unwrap());
            let repaired = if candidate {
                values[0].candidate.as_ref().unwrap()
            } else {
                values[0].published.as_ref().unwrap()
            };
            assert_eq!(page_body(&topic.title, &repaired.markdown).1, 1);
            assert_eq!(repaired.content_hash, store::digest(&repaired.markdown));
            assert_eq!(values[0].last_fingerprint, topic.last_fingerprint);
            let mut before = serde_json::to_value(&page).unwrap();
            let mut after = serde_json::to_value(repaired).unwrap();
            for value in [&mut before, &mut after] {
                value.as_object_mut().unwrap().remove("markdown");
                value.as_object_mut().unwrap().remove("contentHash");
            }
            assert_eq!(before, after);
            let directory = root.join(&topic.id);
            assert_eq!(
                fs::read_to_string(
                    directory
                        .join("edits")
                        .join(format!("{}.md", page.content_hash))
                )
                .unwrap(),
                page.markdown
            );
            let archived: Revision = read_json(
                &directory
                    .join("revisions")
                    .join(format!("{}.json", page.id)),
            )
            .unwrap();
            assert_eq!(archived.markdown, page.markdown);
            assert!(!repair_page_titles(&root, &mut topics(&root).unwrap()).unwrap());
            let target = directory.join(if candidate {
                "candidate.md"
            } else {
                "published.md"
            });
            let edited = format!("{}\n\nManual correction: retain this text.", page.markdown);
            fs::write(&target, &edited).unwrap();
            assert!(!repair_page_titles(&root, &mut topics(&root).unwrap()).unwrap());
            assert_eq!(fs::read_to_string(target).unwrap(), edited);
            fs::remove_dir_all(root).unwrap();
        }
    }
    #[test]
    fn markdown_sources_keep_original_citations_without_sending_rendered_pages() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let mut document = Document {
            id: "meeting".into(),
            kind: "meeting".into(),
            transcript: "Friday remains a proposal.".into(),
            conclusions: vec![
                json!({"conclusionText":"## Notes\nNo date was confirmed."}),
                json!({"conclusionText":format!("<html><style>body {{ color: red; }}</style><img src=\"data:image/png;base64,{}\"></html>", "a".repeat(60000))}),
            ],
            ai_context_enabled: true,
            ..Default::default()
        };
        document.refresh_revision();
        let entry = store::write_document(&root, &document, None).unwrap();
        let mut manifest = Manifest::default();
        manifest.entries.insert(document.id.clone(), entry.clone());
        let sources = sources_for(&root, &manifest);
        assert_eq!(sources.len(), 1);
        assert!(store::is_current_document(&root, &manifest, &sources[0]));
        assert_eq!(sync::split_text(&sources[0].text(), 12000).len(), 1);
        assert!(sync::split_text(&document.text(), 12000).len() > 5);
        let reference = json!({"id":document.id,"kind":"meeting","revision":document.revision,"quote":"No date was confirmed."});
        sync::validate_result(&sources, &manifest, &json!({"citations":[reference]})).unwrap();
        assert_eq!(
            store::read_document(&root, &entry)
                .unwrap()
                .conclusions
                .len(),
            2
        );
        assert!(store::read_document(&root, &entry)
            .unwrap()
            .text()
            .contains("base64"));
        std::fs::remove_dir_all(root).unwrap();
    }
    fn synthesis_server(
        responses: Vec<(u16, Value)>,
    ) -> (String, std::thread::JoinHandle<Vec<Value>>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/synthesize", listener.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for (status, response) in responses {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0; 4096];
                let body = loop {
                    let n = socket.read(&mut buffer).unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&buffer[..n]);
                    if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                        let length: usize = headers
                            .lines()
                            .find_map(|line| line.strip_prefix("content-length:"))
                            .unwrap()
                            .trim()
                            .parse()
                            .unwrap();
                        if bytes.len() >= end + 4 + length {
                            break bytes[end + 4..end + 4 + length].to_vec();
                        }
                    }
                };
                requests.push(serde_json::from_slice(&body).unwrap());
                let data = response.to_string();
                write!(socket, "HTTP/1.1 {status} Response\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{data}", data.len()).unwrap();
            }
            requests
        });
        (endpoint, worker)
    }
    #[tokio::test]
    async fn invalid_model_output_is_corrected_once_without_changing_sources() {
        let failure = json!({"detail":"Insufficient evidence must not contain factual output"});
        let result = json!({"summary":"","insufficientEvidence":true,"citations":[]});
        let (endpoint, server) = synthesis_server(vec![(422, failure), (200, result.clone())]);
        let body = json!({"task":"source_analysis","query":"Project Alpha","language":"zh-Hans","sources":[{"id":"one","text":"Original evidence"}],"modelOverride":{"preset":"chosen","model":"selected"}});
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        assert_eq!(
            send_synthesis(&client, &endpoint, "synthetic-token", body.clone(), || Ok(
                ()
            ))
            .await
            .unwrap(),
            result
        );
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0], body);
        assert_eq!(requests[1]["sources"], body["sources"]);
        assert_eq!(requests[1]["modelOverride"], body["modelOverride"]);
        assert!(requests[1]["query"]
            .as_str()
            .unwrap()
            .starts_with("Project Alpha\n\nResponse correction:"));
        assert!(requests[1]["query"]
            .as_str()
            .unwrap()
            .contains("summary must be empty"));
    }
    #[tokio::test]
    async fn citation_correction_preserves_original_sources_and_compilation_evidence() {
        let reference = json!({"id":"one","revision":"r1","kind":"meeting","quote":"Friday is a proposal."});
        let output = json!({"summary":"Friday remains tentative.","citations":[reference],"insufficientEvidence":false});
        let body = json!({"task":"topic_compile","query":"Keep dates tentative","sources":[{"id":"one","revision":"r1","kind":"meeting","text":"Friday is a proposal."}],"evidence":[output.clone()]});
        let (endpoint, server) = synthesis_server(vec![
            (422, json!({"detail":"Citation does not match source evidence"})),
            (200, output.clone()),
        ]);
        let client = synthesis_client(&endpoint).unwrap();
        assert_eq!(send_synthesis(&client, &endpoint, "synthetic-token", body.clone(), || Ok(())).await.unwrap(), output);
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[1]["sources"], body["sources"]);
        assert_eq!(requests[1]["evidence"], body["evidence"]);
        let correction = requests[1]["query"].as_str().unwrap();
        assert!(correction.starts_with("Keep dates tentative\n\nResponse correction:"));
        assert!(correction.contains("id, revision and kind verbatim"));
        assert!(correction.contains("one contiguous exact substring"));
    }
    #[tokio::test]
    async fn invalid_memory_kind_is_corrected_with_explicit_types_and_original_evidence() {
        let reference =
            json!({"id":"one","revision":"r1","kind":"meeting","quote":"Friday is a proposal."});
        let result = json!({"summary":"Friday remains a proposal.","citations":[reference.clone()],"memoryItems":[{"text":"Friday remains a proposal.","kind":"proposal","citations":[reference]}],"todoSuggestions":[],"decisions":[],"insufficientEvidence":false});
        let (endpoint, server) = synthesis_server(vec![
            (422, json!({"detail":"Invalid memory kind"})),
            (200, result.clone()),
        ]);
        let body = json!({"task":"source_analysis","query":"Project Alpha\nKeep Friday tentative.","language":"zh-Hans","sources":[{"id":"one","revision":"r1","kind":"meeting","text":"Friday is a proposal."}],"modelOverride":{"preset":"chosen","model":"selected"}});
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        assert_eq!(
            send_synthesis(&client, &endpoint, "synthetic-token", body.clone(), || Ok(
                ()
            ))
            .await
            .unwrap(),
            result
        );
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0], body);
        let correction = requests[1]["query"].as_str().unwrap();
        assert!(correction.starts_with(body["query"].as_str().unwrap()));
        assert!(correction.contains("memoryItems[].kind"));
        for kind in ["observation", "proposal", "decision", "unresolved"] {
            assert!(correction.contains(&format!("\"{kind}\"")));
        }
        assert!(correction.contains("Do not translate"));
        assert_eq!(requests[1]["sources"], body["sources"]);
        assert_eq!(requests[1]["modelOverride"], body["modelOverride"]);
    }

    #[tokio::test]
    async fn corrections_are_bounded_and_do_not_retry_invalid_inputs() {
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let failure = json!({"detail":"Model did not return valid structured output"});
        let (endpoint, server) = synthesis_server(vec![(422, failure.clone()), (422, failure)]);
        let error = send_synthesis(
            &client,
            &endpoint,
            "synthetic-token",
            json!({"task":"source_analysis","query":"Alpha"}),
            || Ok(()),
        )
        .await
        .unwrap_err();
        assert!(error.contains("Model did not return valid structured output"));
        assert_eq!(server.join().unwrap().len(), 2);
        let (endpoint, server) =
            synthesis_server(vec![(422, json!({"detail":"Invalid source text"}))]);
        assert!(
            send_synthesis(&client, &endpoint, "synthetic-token", json!({}), || Ok(()))
                .await
                .unwrap_err()
                .contains("Invalid source text")
        );
        assert_eq!(server.join().unwrap().len(), 1);
        assert!(
            !synthesis_error(422, &json!({"detail":"PRIVATE_INPUT synthetic-secret"}))
                .contains("PRIVATE_INPUT")
        );
    }
    #[tokio::test]
    async fn revoked_scope_prevents_a_correction_request() {
        let (endpoint, server) = synthesis_server(vec![(422, json!({"detail":"Invalid summary"}))]);
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let checks = std::sync::atomic::AtomicUsize::new(0);
        let result = send_synthesis(
            &client,
            &endpoint,
            "synthetic-token",
            json!({"task":"source_analysis","query":"Alpha"}),
            || {
                if checks.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                    Ok(())
                } else {
                    Err("Account or consent changed".into())
                }
            },
        )
        .await;
        assert!(result.unwrap_err().contains("Account or consent changed"));
        assert_eq!(server.join().unwrap().len(), 1);
    }
    #[test]
    fn unchanged_model_settings_preserve_vector_and_wiki_revisions() {
        let current = Models {
            embedding: Model {
                base_url: "http://localhost:11434/v1".into(),
                model: "local-embedding".into(),
            },
            revision: "existing-vector-version".into(),
            text_revision: "existing-text-version".into(),
        };
        let request = json!({
            "embedding":{"baseUrl":" http://localhost:11434/v1/ ","model":" local-embedding "},
            "revision":"client-revision-must-not-replace-the-cache-identity"
        });
        let saved = updated_models(&current, serde_json::from_value(request).unwrap()).unwrap();
        assert_eq!(embedding_revision(&saved), embedding_revision(&current));
        let topic = Topic::default();
        let manifest = Manifest::default();
        assert_eq!(
            fingerprint(&topic, &manifest, &saved),
            fingerprint(&topic, &manifest, &current)
        );
        for (base_url, model) in [
            ("http://localhost:11434/v1", "different-embedding"),
            ("http://localhost:1234/v1", "local-embedding"),
        ] {
            let mut changed = saved.clone();
            changed.embedding.base_url = base_url.into();
            changed.embedding.model = model.into();
            let changed = updated_models(&saved, changed).unwrap();
            assert_ne!(embedding_revision(&changed), embedding_revision(&saved));
            assert_eq!(changed.text_revision, current.text_revision);
        }
    }
    #[test]
    fn vectors_survive_reopen_and_invalidate_only_for_changed_inputs() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let path = root.join("wiki-models.json");
        let config = Models {
            embedding: Model {
                base_url: "http://localhost:11434/v1".into(),
                model: "local-embedding".into(),
            },
            revision: "already-built".into(),
            ..Default::default()
        };
        let mut first = Document {
            id: "first-meeting".into(),
            transcript: "Original meeting text".into(),
            ..Default::default()
        };
        first.refresh_revision();
        let mut second = first.clone();
        second.id = "second-meeting".into();
        second.refresh_revision();
        let conn = db(&root).unwrap();
        for doc in [&first, &second] {
            conn.execute(
                "INSERT INTO vectors VALUES (?1,?2,?3,?4)",
                params![
                    doc.id,
                    doc.revision,
                    embedding_revision(&config),
                    "[1.0,0.0]"
                ],
            )
            .unwrap();
        }
        drop(conn);
        write_json(&path, &config).unwrap();
        let loaded = read_models(&path).unwrap();
        let saved = updated_models(&loaded, loaded.clone()).unwrap();
        write_json(&path, &saved).unwrap();
        let reopened = read_models(&path).unwrap();
        assert!(embedding_cached(&root, &first, &reopened).unwrap());
        assert!(embedding_cached(&root, &second, &reopened).unwrap());
        first.transcript = "Updated meeting text".into();
        first.refresh_revision();
        assert!(!embedding_cached(&root, &first, &reopened).unwrap());
        assert!(embedding_cached(&root, &second, &reopened).unwrap());
        let new_doc = Document {
            id: "new-meeting".into(),
            ..second.clone()
        };
        assert!(!embedding_cached(&root, &new_doc, &reopened).unwrap());
        let mut changed = reopened.clone();
        changed.embedding.model = "different-embedding".into();
        let changed = updated_models(&reopened, changed).unwrap();
        assert!(!embedding_cached(&root, &second, &changed).unwrap());
        assert_eq!(
            db(&root)
                .unwrap()
                .query_row("SELECT COUNT(*) FROM vectors", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            2
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn embedding_defaults_upgrade_unconfigured_files_and_preserve_user_choices() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let path = root.join("wiki-models.json");
        let initial = read_models(&path).unwrap();
        assert_eq!(initial.embedding.model, "qwen3.7-text-embedding");
        assert_eq!(
            initial.embedding.base_url,
            "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
        );
        assert!(!embedding_configured(&initial.embedding));
        write_json(
            &path,
            &json!({"embedding":{"baseUrl":"","model":""},"revision":""}),
        )
        .unwrap();
        assert_eq!(
            read_models(&path).unwrap().embedding.model,
            initial.embedding.model
        );
        let custom = Models {
            embedding: Model {
                base_url: "http://localhost:11434/v1".into(),
                model: "local-embedding".into(),
            },
            revision: "user-saved".into(),
            ..Default::default()
        };
        write_json(&path, &custom).unwrap();
        let loaded = read_models(&path).unwrap();
        assert_eq!(loaded.embedding.base_url, custom.embedding.base_url);
        assert_eq!(loaded.embedding.model, custom.embedding.model);
        assert!(embedding_configured(&loaded.embedding));
        assert!(embedding_ready(&loaded.embedding, None));
        write_json(
            &path,
            &Models {
                embedding: Model::default(),
                ..custom
            },
        )
        .unwrap();
        let disabled = read_models(&path).unwrap();
        assert!(disabled.embedding.base_url.is_empty());
        assert!(disabled.embedding.model.is_empty());
        assert!(!embedding_configured(&disabled.embedding));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn embedding_validation_requires_a_real_endpoint_and_supports_other_providers() {
        let mut model = Models::default().embedding;
        assert!(validate_model(&model).unwrap_err().contains("WorkspaceId"));
        model.base_url =
            "https://workspace-123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1".into();
        assert!(embedding_configured(&model));
        assert!(!embedding_ready(&model, None));
        assert!(!embedding_ready(&model, Some("  ")));
        assert!(embedding_ready(&model, Some("synthetic-key")));
        model.base_url = "https://embeddings.example.com/v1".into();
        model.model = "other-provider-model".into();
        assert!(embedding_configured(&model));
        for url in [
            "http://remote.example.com/v1",
            "https://user:secret@example.com/v1",
            "https://example.com/v1?key=value",
        ] {
            model.base_url = url.into();
            assert!(validate_model(&model).is_err());
            assert!(!embedding_configured(&model));
        }
    }
    #[test]
    fn lynclaw_requests_reuse_the_selected_model_without_identity_in_the_body() {
        let session = Session {
            scope: "account".into(),
            user_id: "verified".into(),
            base_url: "https://business.test".into(),
            agent_url: "https://lynclaw.test".into(),
            token: "synthetic-token".into(),
            locale: "en".into(),
            generation: 1,
            model_override: Some(json!({"preset":"existing","model":"configured"})),
        };
        let payload = lynclaw_payload(
            &session,
            "source_analysis",
            json!({"topic":"Launch","sources":[]}),
        );
        assert_eq!(payload["modelOverride"]["model"], "configured");
        assert!(payload.get("token").is_none());
        assert!(payload.get("userId").is_none());
        assert!(payload.get("apiKey").is_none());
        let query = payload["query"].as_str().unwrap();
        assert!(query.starts_with("Launch\n\n"));
        assert!(query.contains("memoryItems[].kind"));
        assert!(query.contains("Do not translate"));
    }
    #[test]
    fn compiler_carries_original_quotes_and_segment_identity_within_server_limits() {
        let source = Document {
            id: "a".into(),
            revision: "r1".into(),
            transcript: "Original quote\n\nTimed quote".into(),
            ..Default::default()
        };
        let evidence = vec![CompilationEvidence {
            source: source.clone(),
            value: json!({"citations":[{"id":"a","quote":"Original quote","segmentId":"s1"},{"id":"a","quote":"Timed quote","startMs":1000,"endMs":2000}]}),
        }];
        let sources = compile_sources(&evidence).unwrap();
        assert_eq!(sources[0]["text"], "Original quote\n\nTimed quote");
        assert_eq!(sources[0]["segments"][0]["id"], "s1");
        assert!(sources[0]["segments"][0].get("startMs").is_none());
        assert_eq!(sources[0]["segments"][1]["startMs"], 1000);
        let excessive = vec![CompilationEvidence {
            source: Document { transcript: "x".repeat(12001), ..source },
            value: json!({"citations":[{"id":"a","quote":"x"}]}),
        }];
        assert!(compile_sources(&excessive).is_err());
    }
    #[test]
    fn compiler_includes_original_quotes_for_every_nested_claim() {
        let docs = vec![
            Document {
                id: "a".into(),
                kind: "meeting".into(),
                revision: "r1".into(),
                transcript: "Friday is a proposal.\n\nThe budget is unapproved.\n\nThe owner remains undecided.".into(),
                ..Default::default()
            },
            Document {
                id: "b".into(),
                kind: "meeting".into(),
                revision: "r2".into(),
                transcript: "Confirm the launch date.".into(),
                ..Default::default()
            },
        ];
        let reference = |id: &str, revision: &str, quote: &str| json!({"id":id,"kind":"meeting","revision":revision,"quote":quote});
        let summary = reference("a", "r1", "Friday is a proposal.");
        let memory = reference("a", "r1", "The budget is unapproved.");
        let decision = reference("a", "r1", "The owner remains undecided.");
        let mut todo = reference("b", "r2", "Confirm the launch date.");
        todo["segmentId"] = json!("s2");
        todo["startMs"] = json!(1000);
        todo["endMs"] = json!(2000);
        let evidence = vec![
            CompilationEvidence {
                source: docs[0].clone(),
                value: json!({
                    "citations":[summary],
                    "memoryItems":[{"text":"Budget unapproved","kind":"unresolved","citations":[memory]}],
                    "decisions":[{"text":"Owner undecided","citations":[decision,summary]}]
                }),
            },
            CompilationEvidence {
                source: docs[1].clone(),
                value: json!({"citations":[reference("b", "r2", "Confirm the launch date.")],"todoSuggestions":[{"title":"Confirm launch date","citations":[todo]}]}),
            },
        ];
        let sources = compile_sources(&evidence).unwrap();
        assert_eq!(sources.len(), 2);
        assert_eq!(
            sources[0]["text"],
            "Friday is a proposal.\n\nThe budget is unapproved.\n\nThe owner remains undecided."
        );
        assert_eq!(sources[1]["id"], "b");
        assert_eq!(sources[1]["revision"], "r2");
        assert_eq!(sources[1]["text"], "Confirm the launch date.");
        assert_eq!(
            sources[1]["segments"],
            json!([{"id":"s2","text":"Confirm the launch date.","startMs":1000,"endMs":2000}])
        );
    }
    #[test]
    fn compiler_keeps_complete_analyzed_parts_bounded_and_deduplicated() {
        let source = Document {
            id: "a".into(),
            kind: "meeting".into(),
            revision: "r1".into(),
            transcript: format!("{}{}", "甲".repeat(12000), "乙".repeat(1000)),
            ..Default::default()
        };
        let parts = sync::split_text(source.text().trim(), 12000);
        let evidence: Vec<_> = parts.into_iter().map(|text| CompilationEvidence {
            value: json!({"summary":"An analysis","citations":[{"id":"a","quote":text.chars().take(2).collect::<String>()}]}),
            source: analysis::part(&source, text),
        }).collect();
        for item in &evidence {
            let sources = compile_sources(std::slice::from_ref(item)).unwrap();
            assert!(sources[0]["text"].as_str().unwrap().chars().count() <= 12000);
        }
        assert!(compile_sources(&evidence).is_err());
        let repeated = vec![evidence[0].clone(), evidence[0].clone()];
        assert_eq!(compile_sources(&repeated).unwrap()[0]["text"], "甲".repeat(12000));
        assert_eq!(serde_json::to_value(&evidence[0]).unwrap(), evidence[0].value);
        let mut changed = evidence[0].clone();
        changed.source.revision = "r2".into();
        assert!(compile_sources(&[evidence[0].clone(), changed]).is_err());
        let many: Vec<_> = (0..6).map(|index| {
            let mut item = evidence[0].clone();
            item.source.id = index.to_string();
            item
        }).collect();
        assert!(compile_sources(&many).is_err());
    }
    #[tokio::test]
    async fn compilation_batches_resume_without_reusing_failures_or_invalid_evidence() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let mut doc = Document {
            id: "meeting".into(),
            kind: "meeting".into(),
            transcript: "Friday remains a proposal.".into(),
            ai_context_enabled: true,
            ..Default::default()
        };
        doc.refresh_revision();
        let mut manifest = Manifest::default();
        manifest.entries.insert(
            doc.id.clone(),
            store::write_document(&root, &doc, None).unwrap(),
        );
        let result = json!({"summary":"Friday is unconfirmed.","citations":[{
            "id":doc.id,"kind":doc.kind,"revision":doc.revision,"quote":doc.transcript
        }]});
        let docs = [doc];
        let serial = tokio::sync::Mutex::new(());
        let validate = |value: &Value| sync::validate_result(&docs, &manifest, value);
        let calls = std::cell::Cell::new(0);
        let generate = || async {
            calls.set(calls.get() + 1);
            Ok(result.clone())
        };
        cached_compilation(&root, "first", &serial, &validate, true, generate())
            .await
            .unwrap();
        let failure = cached_compilation(&root, "second", &serial, &validate, true, async {
            Err("Model did not return valid structured output".into())
        })
        .await;
        assert!(failure.is_err());
        assert!(receipt(&root, "second").unwrap().is_none());
        let mut topics = vec![Topic {
            id: uuid::Uuid::new_v4().to_string(),
            title: "Interrupted compilation".into(),
            error: failure.unwrap_err(),
            last_attempt_fingerprint: "attempted".into(),
            ..Default::default()
        }];
        let id = topics[0].id.clone();
        let mut retry_manifest = manifest.clone();
        retry_failed_work(&root, &mut topics, &mut retry_manifest, Some(&id)).unwrap();
        assert_eq!(
            cached_compilation(&root, "first", &serial, &validate, !topics[0].force_refresh, generate())
                .await
                .unwrap(),
            result
        );
        assert_eq!(calls.get(), 1);
        cached_compilation(&root, "second", &serial, &validate, !topics[0].force_refresh, generate())
            .await
            .unwrap();
        assert_eq!(calls.get(), 2);
        cached_compilation(&root, "first", &serial, &validate, false, generate())
            .await
            .unwrap();
        assert_eq!(calls.get(), 3);
        let mut invented = result.clone();
        invented["citations"][0]["quote"] = json!("An unsupported claim");
        assert!(
            cached_compilation(&root, "invalid", &serial, &validate, true, async {
                Ok(invented)
            })
            .await
            .is_err()
        );
        assert!(receipt(&root, "invalid").unwrap().is_none());
        let allowed = std::cell::Cell::new(true);
        assert!(cached_compilation(
            &root,
            "revoked",
            &serial,
            |value| {
                if !allowed.get() {
                    return Err("Account or consent changed".into());
                }
                validate(value)
            },
            true,
            async {
                allowed.set(false);
                Ok(result.clone())
            }
        )
        .await
        .is_err());
        assert!(receipt(&root, "revoked").unwrap().is_none());
        manifest.entries.get_mut("meeting").unwrap().excluded = true;
        let validate = |value: &Value| sync::validate_result(&docs, &manifest, value);
        assert!(
            cached_compilation(&root, "first", &serial, &validate, true, generate())
                .await
                .is_err()
        );
        assert_eq!(calls.get(), 4);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn unrelated_sources_do_not_invalidate_published_evidence() {
        let topic = Topic::default();
        let mut manifest = Manifest::default();
        let config = Models::default();
        manifest.entries.insert(
            "related".into(),
            store::Entry {
                id: "related".into(),
                revision: "r1".into(),
                status: "synced".into(),
                ..Default::default()
            },
        );
        let references = vec![SourceRef {
            id: "related".into(),
            kind: "meeting".into(),
            revision: "r1".into(),
            quote: "evidence".into(),
            segment_id: None,
            start_ms: None,
            end_ms: None,
        }];
        let original = page_fingerprint(&topic, &manifest, &config, &references);
        manifest.entries.insert(
            "unrelated".into(),
            store::Entry {
                id: "unrelated".into(),
                revision: "other".into(),
                ..Default::default()
            },
        );
        assert_eq!(
            page_fingerprint(&topic, &manifest, &config, &references),
            original
        );
        manifest.entries.get_mut("related").unwrap().revision = "r2".into();
        assert_ne!(
            page_fingerprint(&topic, &manifest, &config, &references),
            original
        );
    }
    #[test]
    fn published_pages_require_current_evidence_and_approved_content_hash() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let mut document = Document {
            id: "meeting".into(),
            kind: "meeting".into(),
            transcript: "Friday remains a proposal".into(),
            ai_context_enabled: true,
            ..Default::default()
        };
        document.refresh_revision();
        let entry = store::write_document(&root, &document, None).unwrap();
        let mut manifest = Manifest::default();
        manifest.entries.insert(document.id.clone(), entry);
        let mut reference = document.reference();
        reference.quote = "Friday remains a proposal".into();
        let mut page = Revision {
            id: "page-v1".into(),
            markdown: "Reviewed proposal".into(),
            content_hash: store::digest("Reviewed proposal"),
            review: "approved".into(),
            citations: vec![reference],
            ..Default::default()
        };
        assert!(valid_page(&root, &manifest, &page));
        page.markdown = "External edit awaiting review".into();
        assert!(!valid_page(&root, &manifest, &page));
        page.markdown = "Reviewed proposal".into();
        manifest.entries.get_mut("meeting").unwrap().excluded = true;
        assert!(!valid_page(&root, &manifest, &page));
        manifest.entries.get_mut("meeting").unwrap().excluded = false;
        manifest.entries.get_mut("meeting").unwrap().revision = "changed".into();
        assert!(!valid_page(&root, &manifest, &page));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn corrupt_index_rebuild_preserves_pages_and_original_database() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("index.sqlite"), "broken SQLite").unwrap();
        fs::write(root.join("topics.json"), "[]").unwrap();
        drop(db(&root).unwrap());
        assert_eq!(fs::read_to_string(root.join("topics.json")).unwrap(), "[]");
        assert!(fs::read_dir(&root).unwrap().flatten().any(|e| e
            .file_name()
            .to_string_lossy()
            .starts_with("index.corrupt-")));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn topic_delete_removes_pages_and_merge_aliases() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("topics.json"), "[]").unwrap();
        let mut values: Vec<Topic> = Vec::new();
        topic_store::upsert(&root, &mut values, &json!({"title": "出海营销", "purpose": "p"}))
            .unwrap();
        let id = values[0].id.clone();
        values[0].merged_ids.push("legacy".into());
        let mut other = Topic {
            title: "Other".into(),
            ..Default::default()
        };
        other.merged_ids.push(id.clone());
        values.push(other);
        let dir = root.join(&id);
        fs::create_dir_all(&dir).unwrap();
        topic_store::delete(&root, &mut values, &json!({"id": id})).unwrap();
        assert_eq!(values.len(), 1);
        assert!(values[0].merged_ids.is_empty());
        assert!(!dir.exists());
        assert!(topic_store::delete(&root, &mut values, &json!({"id": id})).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn semantic_scores_require_matching_dimensions_and_nonzero_norms() {
        assert_eq!(cosine(&[1., 0.], &[1., 0.]), Some(1.));
        assert_eq!(cosine(&[1.], &[1., 0.]), None);
        assert_eq!(cosine(&[0., 0.], &[1., 0.]), None);
    }
    #[test]
    fn source_and_model_changes_invalidate_compilation_but_a_new_round_alone_does_not() {
        let t = Topic {
            title: "Launch".into(),
            ..Default::default()
        };
        let mut m = Manifest::default();
        let mut c = Models::default();
        let first = fingerprint(&t, &m, &c);
        m.sync_round = "next".into();
        assert_eq!(fingerprint(&t, &m, &c), first);
        c.text_revision = "other-model".into();
        assert_ne!(fingerprint(&t, &m, &c), first);
        c = Models::default();
        m.entries.insert(
            "a".into(),
            store::Entry {
                id: "a".into(),
                revision: "r1".into(),
                ..Default::default()
            },
        );
        assert_ne!(fingerprint(&t, &m, &c), first);
    }
    #[test]
    fn completed_wiki_only_resumes_when_inputs_change_or_retry_is_requested() {
        let config = Models::default();
        let mut manifest = Manifest::default();
        manifest.entries.insert(
            "existing".into(),
            store::Entry {
                id: "existing".into(),
                revision: "r1".into(),
                status: "synced".into(),
                ..Default::default()
            },
        );
        let mut topic = Topic {
            title: "Launch".into(),
            ..Default::default()
        };
        topic.last_fingerprint = fingerprint(&topic, &manifest, &config);
        complete_processing(&mut manifest, &[topic.clone()], 0);
        assert!(!needs_processing(&mut manifest, &[topic.clone()], &config));
        assert!(!manifest.wiki_attempted_fingerprint.is_empty());
        let serialized = serde_json::to_value(&manifest).unwrap();
        let mut restored: Manifest = serde_json::from_value(serialized).unwrap();
        for round in ["poll-1", "foreground", "online"] {
            restored.sync_round = round.into();
            restored.completed_round = round.into();
            assert!(!needs_processing(&mut restored, &[topic.clone()], &config));
            assert_eq!(restored.phase, "ready");
            assert_eq!(restored.wiki_progress.as_ref().unwrap().stage, "complete");
        }
        topic.force_refresh = true;
        assert!(needs_processing(&mut restored, &[topic.clone()], &config));
        topic.force_refresh = false;
        restored.entries.insert(
            "new".into(),
            store::Entry {
                id: "new".into(),
                revision: "r1".into(),
                status: "synced".into(),
                ..Default::default()
            },
        );
        assert!(needs_processing(&mut restored, &[topic.clone()], &config));
        topic.last_fingerprint = fingerprint(&topic, &restored, &config);
        restored.wiki_attempted_fingerprint = inputs_fingerprint(&restored, &config);
        assert!(!needs_processing(&mut restored, &[topic.clone()], &config));
        restored.entries.get_mut("existing").unwrap().revision = "updated".into();
        assert!(needs_processing(&mut restored, &[topic], &config));
    }
    #[test]
    fn failed_wiki_waits_for_new_inputs_or_manual_retry() {
        let config = Models::default();
        let mut manifest = Manifest::default();
        let mut topic = Topic {
            title: "Launch".into(),
            error: "Model unavailable".into(),
            ..Default::default()
        };
        topic.last_attempt_fingerprint = fingerprint(&topic, &manifest, &config);
        manifest.wiki_attempted_fingerprint = inputs_fingerprint(&manifest, &config);
        complete_processing(&mut manifest, &[topic.clone()], 0);
        assert!(!needs_processing(&mut manifest, &[topic.clone()], &config));
        assert_eq!(manifest.wiki_progress.as_ref().unwrap().failed, 1);
        topic.force_refresh = true;
        assert!(needs_processing(&mut manifest, &[topic.clone()], &config));
        topic.force_refresh = false;
        topic.notes = "A new correction".into();
        assert!(needs_processing(&mut manifest, &[topic], &config));
    }
    #[test]
    fn gate_requires_round_and_consent() {
        let mut m = Manifest::default();
        m.enabled = true;
        m.allow_ai = true;
        m.initial_complete = true;
        assert!(ready(&m).is_err());
        m.sync_round = "round".into();
        m.completed_round = "old".into();
        assert!(ready(&m).is_err());
        m.completed_round = "round".into();
        assert!(ready(&m).is_ok());
        m.allow_ai = false;
        assert!(ready(&m).is_err());
    }
    #[test]
    fn receipts_survive_reopen_and_failures_are_not_cache_hits() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        job(&root, "a", "running", None, "").unwrap();
        assert!(receipt(&root, "a").unwrap().is_none());
        job(&root, "a", "failed", None, "offline").unwrap();
        assert!(receipt(&root, "a").unwrap().is_none());
        job(&root, "a", "done", Some(&json!({"ok":true})), "").unwrap();
        assert_eq!(receipt(&root, "a").unwrap().unwrap()["ok"], true);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn external_markdown_and_manual_fields_survive_reload() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let topic = Topic {
            id: uuid::Uuid::new_v4().to_string(),
            notes: "correction".into(),
            pinned: true,
            published: Some(Revision {
                id: "r1".into(),
                markdown: "original".into(),
                ..Default::default()
            }),
            ..Default::default()
        };
        save_page(&root, &topic, topic.published.as_ref().unwrap(), false).unwrap();
        save_topics(&root, &[topic.clone()]).unwrap();
        fs::write(root.join(&topic.id).join("published.md"), "manual edit").unwrap();
        let loaded = topics(&root).unwrap();
        assert_eq!(
            loaded[0].published.as_ref().unwrap().markdown,
            "manual edit"
        );
        assert!(loaded[0].pinned);
        assert_eq!(loaded[0].notes, "correction");
        fs::remove_dir_all(root).unwrap();
    }
}

pub(super) fn memory_source(doc: Document,manifest: &Manifest) -> Document {
    automation::citation_document(doc,manifest,"meeting_summary")
}
pub(super) fn mask_memory_text(text: &str) -> String { graph::mask(text) }
pub(super) async fn publish_memory_events(app: &AppHandle,state: &WorkbenchState,session: &Session) -> CommandResult<()> {
    let pages = {
        let _guard=state.serial.lock().await;
        require_current(state,session)?;
        let manifest=load_state(app,session)?;
        let (local,_)=roots(app,session)?;
        topics(&wiki_root(app,session)?)?.into_iter().filter(|topic| topic.collection.is_none()).filter(|topic|citable(topic,&local,&manifest,&models(app,session).unwrap_or_default()))
            .filter_map(|topic|topic.published.map(|page|json!({"topic_id":topic.id,"topic_title":topic.title,"fingerprint":page.fingerprint,"citations":page.citations}))).collect()
    };
    knowledge_cloud::publish_events(app,session,pages).await
}
