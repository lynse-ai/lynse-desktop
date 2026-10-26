//! Evidence graph extraction and projection. Old discovery caches are intentionally not read.
use super::*;
use std::collections::{BTreeMap, BTreeSet};
#[path = "wiki_graph_schema.rs"]
mod schema;
#[path = "wiki_graph_cache.rs"]
mod cache;
#[path = "wiki_graph_reuse.rs"]
mod reuse;
#[path = "wiki_graph_identity.rs"]
mod identity;
pub(super) use reuse::read as reusable_analysis;
use futures_util::{stream, StreamExt};
use schema::{ExtractNode, Extraction};
pub(super) use schema::mask;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
struct Chunk {
    source_id: String,
    content_revision: String,
    extracted_at: String,
    extraction: Extraction,
    error: String,
    identity: String,
    profile: String,
    in_flight: bool,
    relation_ids: Vec<String>,
}
type Usage = SynthesisUsage;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
struct RunReport {
    input_key: String,
    kind: String,
    started_at: String,
    finished_at: Option<String>,
    elapsed_ms: u64,
    cache_hits: usize,
    misses: usize,
    failed: usize,
    accounting: Accounting,
}

fn update_elapsed(run: &mut RunReport) {
    if let Ok(start) = chrono::DateTime::parse_from_rfc3339(&run.started_at) {
        run.elapsed_ms = (chrono::Utc::now().timestamp_millis() - start.timestamp_millis()).max(0) as u64;
    }
}
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
struct Tracking {
    enabled: bool,
    processing: bool,
    paused: bool,
    selected_sources: BTreeSet<String>,
    chunks: BTreeMap<String, Chunk>,
    dismissed: BTreeSet<String>,
    reviews: BTreeMap<String, Value>,
    merges: BTreeMap<String, String>,
    todo_links: BTreeMap<String, String>,
    usage: Usage,
    metrics: accounting::ModelMetrics,
    layouts: BTreeMap<String, Vec<cache::Segment>>,
    scope: String,
    language: String,
    refresh_legacy: bool,
    report_requested: bool,
    runs: Vec<RunReport>,
}
fn path(root: &Path) -> PathBuf {
    root.join("evidence-graph.json")
}
fn node_id(key: &str, node: &ExtractNode) -> String {
    format!(
        "entity:{}",
        store::digest(json!([key, node.key, node.kind]).to_string())
    )
}
fn summary_sources(local: &Path, manifest: &Manifest) -> Vec<Document> {
    sources_for(local, manifest).iter()
        .filter_map(|doc| schema::summary_source(doc, manifest))
        .collect()
}
fn effective_tracking(tracking: &Tracking, manifest: &Manifest, docs: &[Document]) -> Tracking {
    let mut result = tracking.clone();
    if manifest.wiki_automation.is_some() {
        result.enabled = true;
        result.paused = false;
        result.selected_sources = docs.iter().map(|doc| doc.id.clone()).collect();
    }
    result
}
fn pending_chunks(docs: &[Document], tracking: &Tracking) -> Vec<(String, Document)> {
    cache::pending(docs, tracking).into_iter().map(|work| (work.key, work.part)).collect()
}
pub(super) fn compact_output() -> bool {
    std::env::var("LYNSE_GRAPH_COMPACT_OUTPUT").as_deref() != Ok("0")
}
fn concurrency() -> usize {
    std::env::var("LYNSE_GRAPH_CONCURRENCY").ok().and_then(|v| v.parse::<usize>().ok()).unwrap_or(3).clamp(1, 3)
}
fn recover_interrupted(tracking: &mut Tracking) -> u64 {
    let interrupted = tracking.chunks.values_mut().filter(|chunk| chunk.in_flight).map(|chunk| {
        chunk.in_flight = false;
        chunk.error = "Graph request interrupted; retry explicitly".into();
        1_u64
    }).sum::<u64>();
    tracking.metrics.unknown_calls += interrupted;
    if let Some(run) = tracking.runs.last_mut() { run.accounting.metrics.unknown_calls += interrupted; }
    interrupted
}
fn valid_node_id(id: &str) -> bool {
    (id.starts_with("entity:") || id.starts_with("relation:")) && id.len() <= 100
}
pub(super) fn configure(root: &Path, request: &Value) -> CommandResult<()> {
    let mut tracking: Tracking = read_json(&path(root))?;
    match request["action"].as_str() {
        Some("tracking_merge") => {
            let id = request["id"].as_str().ok_or("Invalid graph merge")?;
            let target = request["target"].as_str().ok_or("Invalid graph merge")?;
            let kinds: BTreeMap<_, _> = tracking
                .chunks
                .iter()
                .flat_map(|(key, chunk)| {
                    chunk
                        .extraction
                        .nodes
                        .iter()
                        .map(move |node| (node_id(cache::identity(key, chunk), node), node.kind.as_str()))
                })
                .collect();
            let kind = kinds
                .get(id)
                .filter(|kind| schema::ENTITIES.contains(kind))
                .ok_or("Only matching entity types can be merged")?;
            if id == target || kinds.get(target) != Some(kind) {
                return Err("Only matching entity types can be merged".into());
            }
            let mut cursor = target;
            let mut visited = BTreeSet::new();
            while let Some(next) = tracking.merges.get(cursor) {
                if next == id || !visited.insert(cursor) {
                    return Err("Invalid graph merge cycle".into());
                }
                cursor = next;
            }
            tracking.merges.insert(id.into(), target.into());
        }
        Some("tracking_unmerge") => {
            let id = request["id"].as_str().ok_or("Invalid graph merge")?;
            let mut members = BTreeSet::from([id.to_owned()]);
            loop {
                let previous = members.len();
                for (source, target) in &tracking.merges {
                    if members.contains(target) {
                        members.insert(source.clone());
                    }
                }
                if members.len() == previous {
                    break;
                }
            }
            tracking
                .merges
                .retain(|source, target| !members.contains(source) && !members.contains(target));
        }
        Some("tracking") => {
            tracking.enabled = request["enabled"]
                .as_bool()
                .ok_or("Invalid tracking setting")?;
            tracking.paused = false;
            tracking.processing = false;
            tracking.report_requested = tracking.enabled;
            if tracking.enabled && tracking.selected_sources.is_empty() {
                return Err("Select graph sources before extraction".into());
            }
        }
        Some("tracking_sources") => {
            let ids: Vec<String> = serde_json::from_value(request["ids"].clone())
                .map_err(|_| "Invalid graph source selection")?;
            if ids.len() > 10000 || ids.iter().any(|id| id.is_empty() || id.len() > 250) {
                return Err("Invalid graph source selection".into());
            }
            tracking.selected_sources = ids.into_iter().collect();
            tracking.enabled = false;
            tracking.processing = false;
            tracking.paused = false;
        }
        Some("tracking_refresh") => {
            tracking.refresh_legacy = true;
            tracking.report_requested = true;
            tracking.paused = false;
            tracking.enabled |= !tracking.selected_sources.is_empty();
            tracking.chunks.retain(|_, chunk| chunk.error.is_empty() || chunk.in_flight);
        }
        Some("tracking_retry") => {
            tracking.chunks.retain(|_, chunk| chunk.error.is_empty() || chunk.in_flight);
            tracking.report_requested = true;
            tracking.processing = tracking.chunks.values().any(|chunk| chunk.in_flight);
            tracking.paused = false;
        }
        Some(
            action @ ("tracking_dismiss" | "tracking_restore" | "tracking_review"
            | "tracking_reset"),
        ) => {
            let id = request["id"]
                .as_str()
                .filter(|id| valid_node_id(id))
                .ok_or("Invalid graph node")?;
            match action {
                "tracking_restore" => {
                    tracking.dismissed.remove(id);
                }
                "tracking_dismiss" => {
                    tracking.dismissed.insert(id.into());
                }
                "tracking_reset" => {
                    tracking.reviews.remove(id);
                }
                _ => {
                    let review = request["review"]
                        .as_str()
                        .filter(|review| ["candidate", "confirmed"].contains(review))
                        .ok_or("Invalid graph review")?;
                    let mut correction = json!({"review":review,"reviewedAt":crate::now()});
                    for key in ["description", "status", "modality"] {
                        if let Some(value) = request.get(key) {
                            let text = value
                                .as_str()
                                .filter(|text| {
                                    !text.trim().is_empty() && text.chars().count() <= 1000
                                })
                                .ok_or("Invalid graph correction")?;
                            if key == "status"
                                && ![
                                    "unknown",
                                    "proposed",
                                    "active",
                                    "blocked",
                                    "completed",
                                    "cancelled",
                                    "unresolved",
                                ]
                                .contains(&text)
                            {
                                return Err("Invalid graph correction".into());
                            }
                            if key == "modality"
                                && !["asserted", "planned", "proposed", "negated", "uncertain"]
                                    .contains(&text)
                            {
                                return Err("Invalid graph correction".into());
                            }
                            correction[key] = json!(text);
                        }
                    }
                    tracking.reviews.insert(id.into(), correction);
                }
            }
        }
        _ => return Err("Unknown tracking operation".into()),
    }
    write_json(&path(root), &tracking)
}

async fn extract(app: &AppHandle, session: &Session, work: &cache::Work) -> (CommandResult<Extraction>, Accounting) {
    let mut accounting = Accounting::default();
    let copy = match schema::transport(&work.part) {
        Ok(copy) => copy,
        Err(error) => return (Err(error), accounting),
    };
    let payload = json!({"sources":[{"id":copy.id,"kind":copy.kind,"revision":copy.revision,
        "title":copy.title,"text":copy.transcript,"segments":[]}]});
    for attempt in 0..2 {
        let mut report = Accounting::default();
        let result = request_model_report(app, session, "graph_extract", payload.clone(), &mut report).await;
        let limited = report.metrics.retry_after.is_some();
        let verified = report.metrics.model.as_deref() == Some("deepseek-flash")
            && report.metrics.profile.as_deref() == Some(cache::PROFILE);
        accounting.add(&report);
        if limited && attempt == 0 { continue; }
        if result.is_ok() && !verified {
            return (Err("Graph service version does not confirm deepseek-flash; update Lynclaw".into()), accounting);
        }
        return (result.and_then(|value| schema::validate(value, &work.part)), accounting);
    }
    unreachable!("bounded extraction attempts")
}

pub(super) async fn run(app: &AppHandle, state: &WorkbenchState, session: &Session) -> CommandResult<bool> {
    let started_at = crate::now();
    // A second runner joins the same persisted results after the first batch commits.
    let _flight = state.graph_run.lock().await;
    let (root, work) = {
        let _guard = state.serial.lock().await;
        require_current(state, session)?;
        let manifest = load_state(app, session)?;
        if ready(&manifest).is_err() { return Ok(false); }
        let root = wiki_root(app, session)?;
        let saved: Tracking = read_json(&path(&root))?;
        let docs = summary_sources(&roots(app, session)?.0, &manifest);
        let mut tracking = effective_tracking(&saved, &manifest, &docs);
        // Durable claims prevent a restart from silently repeating an unknown remote outcome.
        let interrupted = recover_interrupted(&mut tracking);
        if !tracking.enabled || tracking.paused {
            if interrupted > 0 {
                tracking.processing = false;
                write_json(&path(&root), &tracking)?;
            }
            return Ok(false);
        }
        tracking.scope = session.scope.clone();
        tracking.language = session.locale.clone();
        let planned = cache::plan(&docs, &mut tracking);
        let pending: Vec<_> = planned.iter().filter(|work| !tracking.chunks.contains_key(&work.key)).cloned().collect();
        let input_key = store::digest(json!([session.scope, session.locale, planned.iter().map(|w| &w.key).collect::<Vec<_>>()]).to_string());
        let start_report = tracking.report_requested || tracking.runs.last().is_none_or(|run| run.input_key != input_key);
        if start_report {
            if let Some(previous) = tracking.runs.last_mut() {
                if previous.finished_at.is_none() { update_elapsed(previous); previous.finished_at = Some(crate::now()); }
            }
            let had_results = tracking.chunks.values().any(|chunk| chunk.profile == cache::PROFILE);
            tracking.runs.push(RunReport {
                input_key, kind: if pending.is_empty() { "repeat" } else if had_results { "incremental" } else { "initial" }.into(),
                started_at,
                cache_hits: planned.iter().filter(|w| tracking.chunks.get(&w.key).is_some_and(|c| c.error.is_empty())).count(),
                misses: pending.len(), ..Default::default()
            });
            if tracking.runs.len() > 20 { tracking.runs.remove(0); }
        }
        tracking.report_requested = false;
        tracking.processing = !pending.is_empty();
        let work = pending.into_iter().take(concurrency()).collect::<Vec<_>>();
        for item in &work {
            tracking.chunks.insert(item.key.clone(), Chunk {
                source_id: item.part.id.clone(), content_revision: item.content_revision.clone(),
                identity: item.identity.clone(), profile: cache::PROFILE.into(), in_flight: true,
                error: "Graph request interrupted; retry explicitly".into(), ..Default::default()
            });
        }
        if work.is_empty() {
            if let Some(run) = tracking.runs.last_mut() {
                if run.finished_at.is_none() { update_elapsed(run); run.finished_at = Some(crate::now()); }
            }
        }
        write_json(&path(&root), &tracking)?;
        persist(app, session, &manifest)?;
        (root, work)
    };
    let mut results = stream::iter(work.into_iter().map(|work| async move {
        let (result, report) = extract(app, session, &work).await;
        (work, result, report)
    })).buffer_unordered(concurrency());
    while let Some((work, result, report)) = results.next().await {
        let _guard = state.serial.lock().await;
        require_current(state, session)?;
        let manifest = load_state(app, session)?;
        let mut tracking: Tracking = read_json(&path(&root))?;
        tracking.usage.add(report.usage);
        let mut totals = Accounting { usage: Usage::default(), metrics: tracking.metrics.clone() };
        totals.add(&report);
        tracking.metrics = totals.metrics;
        let failed = result.is_err();
        if let Some(run) = tracking.runs.last_mut() {
            run.accounting.add(&report);
            run.failed += usize::from(failed);
            update_elapsed(run);
        }
        let current = summary_sources(&roots(app, session)?.0, &manifest).into_iter().find(|doc| doc.id == work.part.id);
        if let Some(chunk) = tracking.chunks.get_mut(&work.key) {
            chunk.in_flight = false;
            chunk.error = "Source changed during graph extraction".into();
        }
        if ready(&manifest).is_ok() && current.as_ref().is_some_and(|doc| schema::content_revision(doc) == work.content_revision) {
            let (mut extraction, error) = match result {
                Ok(extraction) => (extraction, String::new()),
                Err(error) => (Extraction::default(), error),
            };
            let previous = tracking.chunks.iter().filter(|(key, chunk)| chunk.error.is_empty()
                && cache::identity(key, chunk) == work.identity).max_by_key(|(_, chunk)| &chunk.extracted_at).map(|(_, chunk)| chunk);
            let relation_ids = if error.is_empty() { identity::stabilize(&mut extraction, previous, &work.identity) } else { Vec::new() };
            tracking.paused |= manifest.wiki_automation.is_none() && !error.is_empty();
            tracking.chunks.insert(work.key, Chunk { source_id: work.part.id, content_revision: work.content_revision,
                extracted_at: crate::now(), extraction, error, identity: work.identity, profile: cache::PROFILE.into(), in_flight: false, relation_ids });
        }
        write_json(&path(&root), &tracking)?;
        persist(app, session, &manifest)?;
    }
    let _guard = state.serial.lock().await;
    require_current(state, session)?;
    let manifest = load_state(app, session)?;
    let mut tracking: Tracking = read_json(&path(&root))?;
    tracking.processing = false;
    let docs = summary_sources(&roots(app, session)?.0, &manifest);
    let effective = effective_tracking(&tracking, &manifest, &docs);
    let more = ready(&manifest).is_ok() && !effective.paused && !cache::pending(&docs, &effective).is_empty();
    if let Some(run) = tracking.runs.last_mut() {
        update_elapsed(run);
        if !more { run.finished_at = Some(crate::now()); }
    }
    write_json(&path(&root), &tracking)?;
    persist(app, session, &manifest)?;
    Ok(more)
}
pub(super) fn confirm_todo(
    app: &AppHandle,
    session: &Session,
    root: &Path,
    local: &Path,
    manifest: &Manifest,
    id: &str,
) -> CommandResult<()> {
    ready(manifest)?;
    let projected = view(root, local, manifest, &[], &Models::default())?;
    let node = projected["nodes"]
        .as_array()
        .and_then(|nodes| {
            nodes.iter().find(|node| {
                node["id"] == id
                    && node["kind"] == "event"
                    && matches!(node["subtype"].as_str(), Some("task" | "commitment"))
                    && node["modality"] != "negated"
                    && !matches!(node["status"].as_str(), Some("completed" | "cancelled"))
            })
        })
        .ok_or("Task evidence is no longer available")?;
    let source_id = node["sourceId"]
        .as_str()
        .ok_or("Task source is unavailable")?;
    let entry = manifest
        .entries
        .get(source_id)
        .ok_or("Task source is unavailable")?;
    let document = store::read_document(local, entry)?;
    let reference: SourceRef = serde_json::from_value(node["citations"][0].clone())
        .map_err(|_| "Invalid task evidence")?;
    let todo = super::super::save_confirmed_todo(
        app,
        session,
        &document,
        &format!("graph:{id}"),
        node["title"].as_str().ok_or("Todo title is required")?,
        Value::Null,
        json!(reference),
    )?;
    let mut tracking: Tracking = read_json(&path(root))?;
    tracking.todo_links.insert(
        id.into(),
        todo["id"].as_str().ok_or("Invalid saved task")?.into(),
    );
    write_json(&path(root), &tracking)
}
pub(super) fn attach_todos(
    app: &AppHandle,
    session: &Session,
    root: &Path,
    graph: &mut Value,
) -> CommandResult<()> {
    let tracking: Tracking = read_json(&path(root))?;
    if tracking.todo_links.is_empty() {
        return Ok(());
    }
    let todos: BTreeMap<_, _> = crate::list_store(app, "local-todos")?
        .into_iter()
        .filter(|todo| todo["workbenchScope"] == session.scope)
        .filter_map(|todo| Some((todo["id"].as_str()?.to_owned(), todo)))
        .collect();
    for node in graph["nodes"].as_array_mut().into_iter().flatten() {
        let Some(todo_id) = node["id"]
            .as_str()
            .and_then(|id| tracking.todo_links.get(id))
        else {
            continue;
        };
        let Some(todo) = todos.get(todo_id) else {
            continue;
        };
        if todo["workbenchScope"] == session.scope && todo["sourceFileId"] == node["sourceId"] {
            node["linkedTodo"] = json!({"id":todo["id"],"title":todo["title"],"completed":todo["completed"],"dueDate":todo["dueDate"],"updatedAt":todo["updatedAt"]});
        }
    }
    Ok(())
}

fn apply_review(value: &mut Value, tracking: &Tracking, id: &str) {
    value["review"] = json!("candidate");
    if let Some(review) = tracking.reviews.get(id) {
        for key in ["review", "reviewedAt", "description", "status", "modality"] {
            if let Some(field) = review.get(key) {
                value[key] = field.clone();
            }
        }
        value["userEdited"] = json!(
            review.get("description").is_some()
                || review.get("status").is_some()
                || review.get("modality").is_some()
        );
    }
}
fn citations(refs: &[SourceRef], doc: &Document) -> Value {
    json!(refs
        .iter()
        .map(|reference| schema::locate(reference, doc))
        .collect::<Vec<_>>())
}
fn merge_entities(
    nodes: &mut BTreeMap<String, Value>,
    edges: &mut BTreeMap<String, Value>,
    tracking: &Tracking,
) {
    if tracking.merges.is_empty() {
        return;
    }
    let mut mapping = BTreeMap::new();
    for (id, node) in nodes.iter().filter(|(_, node)| node["kind"] == "entity") {
        let mut cursor = id;
        let mut visited = BTreeSet::new();
        while let Some(next) = tracking.merges.get(cursor) {
            if !visited.insert(cursor)
                || !nodes.get(next).is_some_and(|target| {
                    target["kind"] == "entity" && target["subtype"] == node["subtype"]
                })
            {
                break;
            }
            cursor = next;
        }
        mapping.insert(id.clone(), cursor.clone());
    }
    let original = nodes.clone();
    for (id, target) in &mapping {
        if id == target {
            continue;
        }
        let member = &original[id];
        let root = nodes.get_mut(target).expect("merge target is live");
        if root.get("members").is_none() {
            root["members"] = json!([original[target]]);
        }
        root["members"].as_array_mut().unwrap().push(member.clone());
        for reference in member["citations"].as_array().into_iter().flatten() {
            let refs = root["citations"].as_array_mut().unwrap();
            if !refs.contains(reference) {
                refs.push(reference.clone());
            }
        }
    }
    nodes.retain(|id, _| mapping.get(id).is_none_or(|target| target == id));
    for edge in edges.values_mut() {
        for field in ["source", "target"] {
            if let Some(target) = edge[field].as_str().and_then(|id| mapping.get(id)) {
                edge[field] = json!(target);
            }
        }
    }
    edges.retain(|_, edge| edge["source"] != edge["target"]);
}
fn add_edge(edges: &mut BTreeMap<String, Value>, source: &str, target: &str, kind: &str) {
    let id = store::digest(json!([source, target, kind]).to_string());
    edges.insert(
        id.clone(),
        json!({"id":id,"source":source,"target":target,"kind":kind}),
    );
}
fn canonical(text: &str) -> String {
    text.chars()
        .filter(|ch| ch.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}
fn wiki_targets(markdown: &str) -> Vec<String> {
    let mut targets = Vec::new();
    let mut fenced = false;
    for line in markdown.lines() {
        if line.trim_start().starts_with("```") || line.trim_start().starts_with("~~~") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            continue;
        }
        for part in line.split("[[").skip(1) {
            if let Some((target, _)) = part.split_once("]]") {
                targets.push(canonical(
                    target
                        .split(['|', '#'])
                        .next()
                        .unwrap_or_default()
                        .rsplit('/')
                        .next()
                        .unwrap_or_default()
                        .trim_end_matches(".md"),
                ));
            }
        }
    }
    targets
}
pub(super) fn view(
    root: &Path,
    local: &Path,
    manifest: &Manifest,
    topics: &[Topic],
    config: &Models,
) -> CommandResult<Value> {
    let tracking: Tracking = read_json(&path(root))?;
    let docs = sources_for(local, manifest);
    let current: BTreeMap<_, _> = docs.iter().map(|doc| (doc.id.as_str(), doc)).collect();
    let summaries: Vec<_> = docs.iter().filter_map(|doc| schema::summary_source(doc, manifest)).collect();
    let mut tracking = effective_tracking(&tracking, manifest, &summaries);
    let planned = cache::plan(&summaries, &mut tracking);
    let mut desired: BTreeSet<_> = planned.iter().map(|work| work.key.clone()).collect();
    // Keep a legacy graph readable while its explicitly requested replacement is pending or failed.
    if tracking.refresh_legacy {
        for work in &planned {
            if tracking.chunks.get(&work.key).is_none_or(|chunk| !chunk.error.is_empty()) {
                desired.extend(tracking.chunks.iter().filter(|(_, chunk)| chunk.profile.is_empty()
                    && chunk.error.is_empty() && chunk.source_id == work.part.id
                    && chunk.content_revision == work.content_revision).map(|(key, _)| key.clone()));
            }
        }
    }
    let summary_docs: BTreeMap<_, _> = summaries.iter().map(|doc| (doc.id.as_str(), doc)).collect();
    let mut nodes = BTreeMap::<String, Value>::new();
    let mut edges = BTreeMap::new();
    let active: Vec<_> = tracking
        .chunks
        .iter()
        .filter(|(key, chunk)| {
            desired.contains(key.as_str()) && manifest.enabled
                && manifest.allow_ai
                && tracking.selected_sources.contains(&chunk.source_id)
                && summary_docs
                    .get(chunk.source_id.as_str())
                    .is_some_and(|doc| schema::content_revision(doc) == chunk.content_revision)
        })
        .collect();
    for (key, chunk) in &active {
        let key = cache::identity(key, chunk);
        let doc = summary_docs[chunk.source_id.as_str()];
        let mut ids = BTreeMap::new();
        for node in &chunk.extraction.nodes {
            let id = node_id(key, node);
            if tracking.dismissed.contains(&id)
                || node.citations.is_empty()
                || !node
                    .citations
                    .iter()
                    .all(|reference| schema::evidence_text(doc).contains(&reference.quote))
            {
                continue;
            }
            let group = if schema::ENTITIES.contains(&node.kind.as_str()) {
                "entity"
            } else if node.kind == "topic" {
                "topic"
            } else {
                "event"
            };
            let mut value = json!({"id":id,"kind":group,"subtype":node.kind,"title":node.title,"description":node.description,"status":node.status,"modality":node.modality,"confidence":node.confidence,"timeText":node.time_text,"dueText":node.due_text,"extractedAt":chunk.extracted_at,"sourceId":doc.id,"citations":citations(&node.citations,doc),"updates":[]});
            apply_review(&mut value, &tracking, &id);
            ids.insert(node.key.as_str(), id.clone());
            nodes.insert(id, value);
        }
        for (index, relation) in chunk.extraction.relations.iter().enumerate() {
            let (Some(source), Some(target)) = (
                ids.get(relation.subject.as_str()),
                ids.get(relation.target.as_str()),
            ) else {
                continue;
            };
            let id = chunk.relation_ids.get(index).cloned()
                .unwrap_or_else(|| identity::old_relation_id(key, index, relation));
            if tracking.dismissed.contains(&id) {
                continue;
            }
            let mut value = json!({"id":id,"source":source,"target":target,"kind":relation.predicate,"modality":relation.modality,"confidence":relation.confidence,"citations":citations(&relation.citations,doc)});
            apply_review(&mut value, &tracking, &id);
            edges.insert(id, value);
        }
    }
    merge_entities(&mut nodes, &mut edges, &tracking);
    let mut pages = Vec::new();
    let mut page_sources = PageSources::new(local, manifest);
    for topic in topics
        .iter()
        .filter(|topic| manifest.enabled && manifest.allow_ai && !topic.excluded)
    {
        let Some(page) = topic
            .candidate
            .as_ref()
            .filter(|page| page_sources.valid_page(page))
            .or_else(|| {
                topic
                    .published
                    .as_ref()
                    .filter(|page| page_sources.valid_page(page))
            })
        else {
            continue;
        };
        let id = format!("wiki:{}", topic.id);
        let status =
            if page.fingerprint != page_fingerprint(topic, manifest, config, &page.citations) {
                "stale"
            } else if topic
                .candidate
                .as_ref()
                .is_some_and(|candidate| candidate.id == page.id)
            {
                "candidate"
            } else {
                "published"
            };
        nodes.insert(id.clone(),json!({"id":id,"kind":"wiki","title":topic.title,"description":topic.purpose,"status":status,"wikiId":topic.id,"citations":page.citations,"updates":[]}));
        pages.push((id, canonical(&topic.title), &page.markdown));
    }
    for (id, _, markdown) in &pages {
        for target in wiki_targets(markdown) {
            let matches: Vec<_> = pages
                .iter()
                .filter(|(_, name, _)| *name == target)
                .collect();
            if matches.len() == 1 && matches[0].0 != *id {
                add_edge(&mut edges, id, &matches[0].0, "wiki_link");
            }
        }
    }
    let mut sources = Vec::new();
    for node in nodes.values() {
        for reference in node["citations"].as_array().into_iter().flatten() {
            let Some(doc) = reference["id"].as_str().and_then(|id| current.get(id)) else {
                continue;
            };
            let id = format!("source:{}", doc.id);
            add_edge(
                &mut edges,
                node["id"].as_str().unwrap_or_default(),
                &id,
                "evidence",
            );
            sources.push((id.clone(),json!({"id":id,"kind":"source","title":doc.title,"description":"","status":"source","source":reference,"citations":[],"updates":[]})));
        }
    }
    for (id, node) in sources {
        nodes.entry(id).or_insert(node);
    }
    let available: Vec<_> = summaries.iter().map(|doc| json!({"id":doc.id,"title":doc.title,"selected":tracking.selected_sources.contains(&doc.id)})).collect();
    let total = planned.len();
    let failed = active
        .iter()
        .filter(|(_, chunk)| !chunk.error.is_empty() && !chunk.in_flight)
        .count();
    let pending = planned.iter().filter(|work| !tracking.chunks.contains_key(&work.key)).count();
    Ok(
        json!({"schemaVersion":schema::VERSION,"nodes":nodes.into_values().collect::<Vec<_>>(),"edges":edges.into_values().collect::<Vec<_>>(),"availableSources":available,"automaticTracking":tracking.enabled,"tracking":{"processing":tracking.processing,"paused":tracking.paused,"completed":total.saturating_sub(pending+failed+active.iter().filter(|(_, chunk)| chunk.in_flight).count()),"total":total,"failed":failed,"error":active.iter().find(|(_,chunk)| !chunk.error.is_empty() && !chunk.in_flight).map(|(_,chunk)| chunk.error.as_str()).unwrap_or(""),"usage":tracking.usage,"metrics":tracking.metrics,"runs":tracking.runs,"legacyChunks":active.iter().filter(|(_,chunk)| chunk.profile.is_empty()).count(),"model":"deepseek-flash","showUsage":std::env::var("LYNSE_GRAPH_SHOW_USAGE").as_deref()!=Ok("0")}}),
    )
}

#[cfg(test)]
#[path = "wiki_graph_tests.rs"]
mod tests;
#[cfg(test)]
#[path = "wiki_graph_cache_tests.rs"]
mod cache_tests;
