//! Evidence graph extraction and projection. Old discovery caches are intentionally not read.
use super::*;
use std::collections::{BTreeMap, BTreeSet};
#[path = "wiki_graph_schema.rs"]
mod schema;
use schema::{ExtractNode, Extraction};

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
struct Chunk {
    source_id: String,
    content_revision: String,
    extracted_at: String,
    extraction: Extraction,
    error: String,
}
#[derive(Default, Deserialize, Serialize)]
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
fn pending_chunks(docs: &[Document], tracking: &Tracking) -> Vec<(String, Document)> {
    let mut pending = Vec::new();
    for doc in docs
        .iter()
        .filter(|doc| doc.kind == schema::SUMMARY_KIND && tracking.selected_sources.contains(&doc.id))
    {
        let content_revision = schema::content_revision(doc);
        for (index, text) in sync::split_text(&schema::evidence_text(doc), 12_000)
            .into_iter()
            .enumerate()
        {
            if text.trim().is_empty() {
                continue;
            }
            let key = store::digest(
                json!([
                    schema::VERSION,
                    doc.id,
                    content_revision,
                    index,
                    store::digest(&text)
                ])
                .to_string(),
            );
            if tracking.chunks.contains_key(&key) {
                continue;
            }
            let mut part = doc.clone();
            part.transcript = text;
            part.outline.clear();
            part.conclusions.clear();
            part.todos.clear();
            pending.push((key, part));
        }
    }
    pending
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
                        .map(move |node| (node_id(key, node), node.kind.as_str()))
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
        Some("tracking_retry") => {
            tracking.chunks.retain(|_, chunk| chunk.error.is_empty());
            tracking.processing = false;
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

pub(super) async fn run(
    app: &AppHandle,
    state: &WorkbenchState,
    session: &Session,
) -> CommandResult<bool> {
    let (root, key, part, source_content) = {
        let _guard = state.serial.lock().await;
        require_current(state, session)?;
        let manifest = load_state(app, session)?;
        if ready(&manifest).is_err() {
            return Ok(false);
        }
        let root = wiki_root(app, session)?;
        let mut tracking: Tracking = read_json(&path(&root))?;
        if !tracking.enabled || tracking.paused {
            return Ok(false);
        }
        let docs = summary_sources(&roots(app, session)?.0, &manifest);
        let Some((key, part)) = pending_chunks(&docs, &tracking).into_iter().next() else {
            if tracking.processing {
                tracking.processing = false;
                write_json(&path(&root), &tracking)?;
            }
            return Ok(false);
        };
        let source_content = docs
            .iter()
            .find(|doc| doc.id == part.id)
            .map(schema::content_revision)
            .unwrap_or_default();
        tracking.processing = true;
        write_json(&path(&root), &tracking)?;
        persist(app, session, &manifest)?;
        (root, key, part, source_content)
    };
    let copy = schema::transport(&part)?;
    let result = synthesize(app, session, "graph_extract", &[copy], None)
        .await
        .and_then(|value| schema::validate(value, &part));
    let _guard = state.serial.lock().await;
    require_current(state, session)?;
    let latest = load_state(app, session)?;
    ready(&latest)?;
    let local = roots(app, session)?.0;
    let mut tracking: Tracking = read_json(&path(&root))?;
    tracking.processing = false;
    let current = summary_sources(&local, &latest)
        .into_iter()
        .find(|doc| doc.id == part.id);
    if !tracking.enabled
        || !tracking.selected_sources.contains(&part.id)
        || current
            .as_ref()
            .is_none_or(|doc| schema::content_revision(doc) != source_content)
    {
        write_json(&path(&root), &tracking)?;
        persist(app, session, &latest)?;
        return Ok(tracking.enabled && !tracking.paused);
    }
    let (extraction, error) = match result {
        Ok(extraction) => (extraction, String::new()),
        Err(error) => (Extraction::default(), error),
    };
    tracking.paused = !error.is_empty();
    tracking.chunks.insert(
        key,
        Chunk {
            source_id: part.id,
            content_revision: source_content,
            extracted_at: crate::now(),
            extraction,
            error,
        },
    );
    write_json(&path(&root), &tracking)?;
    persist(app, session, &latest)?;
    Ok(!tracking.paused && !pending_chunks(&summary_sources(&local, &latest), &tracking).is_empty())
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
    let summaries = summary_sources(local, manifest);
    let summary_docs: BTreeMap<_, _> = summaries.iter().map(|doc| (doc.id.as_str(), doc)).collect();
    let mut nodes = BTreeMap::<String, Value>::new();
    let mut edges = BTreeMap::new();
    let active: Vec<_> = tracking
        .chunks
        .iter()
        .filter(|(_, chunk)| {
            manifest.enabled
                && manifest.allow_ai
                && tracking.selected_sources.contains(&chunk.source_id)
                && summary_docs
                    .get(chunk.source_id.as_str())
                    .is_some_and(|doc| schema::content_revision(doc) == chunk.content_revision)
        })
        .collect();
    for (key, chunk) in &active {
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
            let id = format!(
                "relation:{}",
                store::digest(
                    json!([
                        key,
                        index,
                        relation.subject,
                        relation.target,
                        relation.predicate
                    ])
                    .to_string()
                )
            );
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
    for topic in topics
        .iter()
        .filter(|topic| manifest.enabled && manifest.allow_ai && !topic.excluded)
    {
        let Some(page) = topic
            .candidate
            .as_ref()
            .filter(|page| valid_page(local, manifest, page))
            .or_else(|| {
                topic
                    .published
                    .as_ref()
                    .filter(|page| valid_page(local, manifest, page))
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
    let total: usize = summaries
        .iter()
        .filter(|doc| tracking.selected_sources.contains(&doc.id))
        .map(|doc| {
            sync::split_text(&schema::evidence_text(doc), 12_000)
                .into_iter()
                .filter(|text| !text.trim().is_empty())
                .count()
        })
        .sum();
    let failed = active
        .iter()
        .filter(|(_, chunk)| !chunk.error.is_empty())
        .count();
    let pending = pending_chunks(&summaries, &tracking).len();
    Ok(
        json!({"schemaVersion":schema::VERSION,"nodes":nodes.into_values().collect::<Vec<_>>(),"edges":edges.into_values().collect::<Vec<_>>(),"availableSources":available,"automaticTracking":tracking.enabled,"tracking":{"processing":tracking.processing,"paused":tracking.paused,"completed":total.saturating_sub(pending+failed),"total":total,"failed":failed,"error":active.iter().find(|(_,chunk)| !chunk.error.is_empty()).map(|(_,chunk)| chunk.error.as_str()).unwrap_or("")}}),
    )
}

#[cfg(test)]
#[path = "wiki_graph_tests.rs"]
mod tests;
