//! Automatic, folder-scoped Wiki cataloguing and validated publication.
use super::*;
use futures_util::future;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
#[path = "wiki_batch_layout.rs"]
mod batch_layout;
#[path = "wiki_cache_upgrade.rs"]
mod cache_upgrade;
#[path = "wiki_catalog_retrieval.rs"]
mod retrieval;
#[path = "wiki_scope_cache.rs"]
mod scope_cache;
#[path = "wiki_source_layout.rs"]
mod source_layout;
pub(super) use scope_cache::migrate as migrate_scope_cache;

pub(in crate::workbench) fn validate_automation(
    config: &store::WikiAutomation,
) -> CommandResult<()> {
    if (!config.include_unfiled && config.folder_ids.is_empty())
        || config.folder_ids.len() > 1000
        || config
            .folder_ids
            .iter()
            .any(|id| id.trim().is_empty() || id.len() > 250)
    {
        return Err("Choose at least one meeting folder or unfiled meetings".into());
    }
    Ok(())
}

pub(super) fn allows(doc: &Document, manifest: &Manifest) -> bool {
    if !knowledge_cloud::local_allows(doc, manifest) {
        return false;
    }
    manifest.wiki_automation.as_ref().is_none_or(|config| {
        if doc.kind == "gmail" {
            return true;
        }
        (doc.kind == "meeting" || doc.kind == "meeting_summary")
            && if doc.folder_id.is_empty() {
                config.include_unfiled
            } else {
                config.folder_ids.contains(&doc.folder_id)
            }
    })
}

pub(in crate::workbench) fn ai_manifest(local: &Path, manifest: &Manifest) -> Manifest {
    let mut result = manifest.clone();
    if manifest.wiki_automation.is_some() {
        for entry in result.entries.values_mut() {
            if !store::read_document(local, entry).is_ok_and(|doc| allows(&doc, manifest)) {
                entry.excluded = true;
            }
        }
    }
    result
}
pub(super) fn move_sources(
    local: &Path,
    manifest: &mut Manifest,
    ids: &[String],
    folder: &str,
) -> CommandResult<()> {
    for id in ids {
        let Some(entry) = manifest.entries.get(id).cloned() else {
            continue;
        };
        let Ok(mut doc) = store::read_document(local, &entry) else {
            if let Some(entry) = manifest.entries.get_mut(id) {
                entry.status = "conflict".into();
            }
            continue;
        };
        if doc.kind != "meeting" || doc.folder_id == folder {
            continue;
        }
        let previous = doc.clone();
        doc.folder_id = folder.into();
        doc.refresh_revision();
        let next = store::write_document(local, &doc, Some(&entry))?;
        if next.status != "conflict" {
            store::preserve_summary_revision(manifest, &previous, &doc);
        }
        manifest.entries.insert(id.clone(), next);
        if !allows(&doc, manifest) {
            sync::forget_source(manifest, id);
        }
    }
    Ok(())
}

fn preferred(mut doc: Document, manifest: &Manifest) -> Document {
    let mut summaries: Vec<String> = doc
        .conclusions
        .iter()
        .filter_map(|row| row["conclusionText"].as_str())
        .filter_map(|text| {
            super::super::markdown::source(Document {
                transcript: text.into(),
                ai_context_enabled: true,
                ..Default::default()
            })
            .map(|summary| summary.transcript)
        })
        .collect();
    if let Some(rows) = manifest
        .artifacts
        .get(&doc.id)
        .and_then(|a| a["summaries"].as_array())
    {
        for row in rows {
            if row["sourceRevision"] == doc.revision {
                if let Some(text) = row["markdown"]
                    .as_str()
                    .filter(|text| !text.trim().is_empty())
                {
                    if let Some(summary) = super::super::markdown::source(Document {
                        transcript: text.into(),
                        ai_context_enabled: true,
                        ..Default::default()
                    }) {
                        if !summaries.contains(&summary.transcript) {
                            summaries.push(summary.transcript);
                        }
                    }
                }
            }
        }
    }
    if doc.kind == "meeting" && !summaries.is_empty() {
        doc.kind = "meeting_summary".into();
        doc.transcript = summaries.join("\n\n");
        doc.segments.clear();
        doc.outline.clear();
        doc.conclusions.clear();
        doc.todos.clear();
    }
    doc
}

pub(super) fn documents(local: &Path, manifest: &Manifest) -> Vec<Document> {
    manifest
        .entries
        .values()
        .filter(|entry| store::eligible(entry))
        .filter_map(|entry| store::read_document(local, entry).ok())
        .filter(|doc| allows(doc, manifest))
        .map(|doc| preferred(doc, manifest))
        .filter_map(super::super::markdown::source)
        .filter(|doc| !doc.text().trim().is_empty())
        .collect()
}

pub(super) fn citation_document(doc: Document, manifest: &Manifest, kind: &str) -> Document {
    if kind == "meeting_summary" {
        preferred(doc, manifest)
    } else {
        doc
    }
}

fn mask(text: &str) -> String {
    graph::mask(text)
}

fn restore_refs(value: &mut Value, docs: &[Document]) -> CommandResult<()> {
    match value {
        Value::Object(fields) => {
            if fields.contains_key("quote") {
                let doc = docs
                    .iter()
                    .find(|doc| {
                        fields.get("id").and_then(Value::as_str) == Some(&doc.id)
                            && fields.get("revision").and_then(Value::as_str) == Some(&doc.revision)
                    })
                    .ok_or("AI cited a source outside this request")?;
                let quote = fields
                    .get("quote")
                    .and_then(Value::as_str)
                    .ok_or("Invalid citation")?;
                let original = doc.text();
                let copy = mask(&original);
                if quote.trim().is_empty() || quote.chars().count() > 500 {
                    return Err("Invalid citation".into());
                }
                let locations: Vec<_> = copy
                    .match_indices(quote)
                    .map(|(offset, _)| {
                        original
                            .chars()
                            .skip(copy[..offset].chars().count())
                            .take(quote.chars().count())
                            .collect::<String>()
                    })
                    .collect();
                if locations.iter().collect::<BTreeSet<_>>().len() != 1 {
                    return Err("Citation has no unambiguous source evidence".into());
                }
                let offset = copy
                    .find(quote)
                    .ok_or("Citation does not match source evidence")?;
                let start = copy[..offset].chars().count();
                let text: String = original
                    .chars()
                    .skip(start)
                    .take(quote.chars().count())
                    .collect();
                fields.insert("quote".into(), json!(text));
                fields.insert("kind".into(), json!(doc.kind));
                if doc.kind == "meeting_summary" {
                    for key in ["segmentId", "startMs", "endMs"] {
                        fields.remove(key);
                    }
                }
            } else {
                for child in fields.values_mut() {
                    restore_refs(child, docs)?;
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                restore_refs(item, docs)?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub(super) async fn request(
    app: &AppHandle,
    session: &Session,
    task: &str,
    docs: &[Document],
    query: &str,
    evidence: Value,
) -> CommandResult<Value> {
    let payload = transport_payload(task, docs, query, evidence)?;
    // Spent tokens are surfaced on the evidence graph only for now.
    let mut value = request_model(app, session, task, payload).await?;
    restore_refs(&mut value, docs)?;
    Ok(value)
}

pub(super) fn transport_payload(
    task: &str,
    docs: &[Document],
    query: &str,
    evidence: Value,
) -> CommandResult<Value> {
    let sources: Vec<_> = docs
        .iter()
        .map(|doc| {
            json!({"id":doc.id,"revision":doc.revision,"kind":doc.kind,
        "title":mask(&doc.title),"text":mask(doc.text().trim()),"segments":[]})
        })
        .collect();
    let mut evidence = evidence;
    fn mask_value(value: &mut Value) {
        match value {
            Value::String(text) => *text = mask(text),
            Value::Array(rows) => {
                for row in rows {
                    mask_value(row);
                }
            }
            Value::Object(fields) => {
                for (key, child) in fields {
                    if !matches!(
                        key.as_str(),
                        "id" | "revision" | "kind" | "sourceIds" | "newSourceId" | "existingId"
                    ) {
                        mask_value(child);
                    }
                }
            }
            _ => {}
        }
    }
    mask_value(&mut evidence);
    let query = if matches!(
        task,
        "wiki_catalog" | "wiki_topic_match" | "wiki_topic_group"
    ) {
        let mut data: Value =
            serde_json::from_str(query).map_err(|_| "Invalid Wiki catalog context")?;
        mask_value(&mut data);
        data.to_string()
    } else {
        mask(query)
    };
    Ok(json!({"topic":query,"sources":sources,"evidence":evidence}))
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogTopic {
    key: String,
    #[serde(default)]
    existing_id: Option<String>,
    title: String,
    kind: String,
    overview: String,
    citations: Vec<SourceRef>,
}
#[derive(Default, Deserialize, Serialize)]
#[serde(default)]
struct Catalog {
    chunks: BTreeMap<String, Vec<CatalogTopic>>,
    failed: BTreeMap<String, String>,
    identities: BTreeMap<String, String>,
    details: BTreeMap<String, CatalogFailure>,
    run_failure: Option<CatalogFailure>,
    deleted: BTreeSet<String>,
    #[serde(skip)]
    layouts: BTreeMap<String, Vec<String>>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogFailure {
    id: String,
    source_id: String,
    title: String,
    stage: String,
    message: String,
    occurred_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    validation: Option<ValidationDetails>,
}

// Model-output rejections are nondeterministic (validation, malformed JSON),
// unlike session or transport failures; they deserve a fresh attempt per run
// instead of latching until a manual retry.
fn is_model_output_failure(error: &str) -> bool {
    super::is_model_output_failure(error)
        || error.contains("[lynse-validation]")
        || error.contains("invalid synthesis JSON")
        || error.contains("Invalid Wiki catalog output")
}

fn record_failure(catalog: &mut Catalog, key: &str, doc: &Document, error: &str) {
    catalog.failed.insert(key.into(), error.into());
    let (message, validation) = validation_failure::split(error.into());
    catalog.details.insert(
        key.into(),
        CatalogFailure {
            id: key.into(),
            source_id: doc.id.clone(),
            title: doc.title.clone(),
            stage: "analyzing".into(),
            message,
            validation,
            occurred_at: crate::now(),
        },
    );
}

pub(super) fn source_failures(root: &Path) -> CommandResult<Value> {
    let catalog: Catalog = read_json(&catalog_path(root))?;
    let mut failures: Vec<Value> = catalog
        .run_failure
        .iter()
        .map(|failure| json!(failure))
        .collect();
    failures.extend(catalog.details.values().map(|failure| {
        let mut value = json!(failure);
        value["retrying"] = json!(!catalog.failed.contains_key(&failure.id));
        value
    }));
    Ok(json!(failures))
}

// Only adopt receipts whose complete old input identity and current citations match.
fn migrate_catalog_revision(
    root: &Path,
    local: &Path,
    catalog: &mut Catalog,
    docs: &[Document],
    manifest: &Manifest,
    config: &Models,
    previous: &str,
) -> CommandResult<()> {
    if previous.is_empty() || previous == config.text_revision {
        return Ok(());
    }
    let mut old = config.clone();
    old.text_revision = previous.into();
    migrate_scope_cache(root, local, docs, manifest, &old)?;
    let mut values = topics(root)?;
    let mut page_sources = PageSources::new(local, manifest);
    let mut catalog_changed = false;
    let mut topics_changed = false;
    for doc in docs {
        for text in source_chunks(doc, catalog) {
            let key = catalog_chunk_key(doc, &text, config);
            let old_key = catalog_chunk_key(doc, &text, &old);
            if catalog.chunks.contains_key(&key) {
                continue;
            }
            let Some(rows) = catalog.chunks.get(&old_key).cloned() else {
                continue;
            };
            if rows.iter().all(|row| {
                row.citations.iter().any(|r| r.id == doc.id)
                    && sync::validate_result(docs, manifest, &json!({"citations":row.citations}))
                        .is_ok()
            }) {
                catalog.chunks.insert(key.clone(), rows);
                catalog.failed.remove(&key);
                catalog.details.remove(&key);
                catalog.failed.remove(&old_key);
                catalog.details.remove(&old_key);
                catalog_changed = true;
            }
        }
    }
    // Recover associations from validated receipts, including state damaged by older retries.
    let mut links: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for doc in docs {
        for text in source_chunks(doc, catalog) {
            if let Some(rows) = catalog.chunks.get(&catalog_chunk_key(doc, &text, config)) {
                for row in rows {
                    let identity = format!("{}:{}:{}", row.kind, doc.id, normalize(&row.key));
                    if let Some(id) = row
                        .existing_id
                        .as_ref()
                        .or_else(|| catalog.identities.get(&identity))
                    {
                        links.entry(id.clone()).or_default().insert(doc.id.clone());
                        links
                            .entry(id.clone())
                            .or_default()
                            .extend(row.citations.iter().map(|r| r.id.clone()));
                    }
                }
            }
        }
    }
    for topic in &mut values {
        if topic.collection.is_some() {
            continue;
        }
        if topic.source_ids.is_empty() {
            if let Some(ids) = links.get(&topic.id).filter(|ids| !ids.is_empty()) {
                topic.source_ids = ids.iter().cloned().collect();
                topics_changed = true;
            }
        }
        let selected: Vec<_> = docs
            .iter()
            .filter(|doc| topic.source_ids.contains(&doc.id))
            .cloned()
            .collect();
        if selected.is_empty() || topic.force_refresh || !topic.error.is_empty() {
            continue;
        }
        let current_version = page_version(topic, &selected, manifest, config);
        if topic.last_fingerprint == current_version {
            continue;
        }
        if (topic.last_fingerprint == page_version(topic, &selected, manifest, &old)
            || manifest.wiki_automation.as_ref().is_some_and(|scope| {
                topic.last_fingerprint == scope_cache::legacy_version(topic, &selected, scope, &old)
            }))
            && topic.published.as_ref().is_some_and(|page| {
                page_sources.valid_page(page) && page.content_hash == store::digest(&page.markdown)
            })
        {
            let expected = page_fingerprint(
                topic,
                manifest,
                &old,
                &topic.published.as_ref().unwrap().citations,
            );
            let legacy_expected = manifest.wiki_automation.as_ref().map(|scope| {
                page_fingerprint_with_legacy_scope(
                    topic,
                    manifest,
                    &old,
                    &topic.published.as_ref().unwrap().citations,
                    Some(scope),
                )
            });
            let replacement = page_fingerprint(
                topic,
                manifest,
                config,
                &topic.published.as_ref().unwrap().citations,
            );
            if !topic.published.as_ref().is_some_and(|page| {
                page.fingerprint == expected || legacy_expected.as_ref() == Some(&page.fingerprint)
            }) {
                continue;
            }
            topic.last_fingerprint = current_version;
            topic.last_attempt_fingerprint = topic.last_fingerprint.clone();
            if let Some(page) = topic.published.as_mut() {
                page.fingerprint = replacement;
                page.cache_key = topic.last_fingerprint.clone();
                write_json(&root.join(&topic.id).join("published.json"), page)?;
            }
            topics_changed = true;
        }
    }
    if topics_changed {
        save_topics(root, &values)?;
    }
    if catalog_changed {
        write_json(&catalog_path(root), catalog)?;
    }
    Ok(())
}

fn reconcile_sources(
    values: &mut [Topic],
    active: &BTreeMap<String, BTreeSet<String>>,
    failed: &BTreeSet<String>,
    docs: &[Document],
) -> bool {
    let available: BTreeSet<_> = docs.iter().map(|doc| &doc.id).collect();
    let mut changed = false;
    for topic in values {
        if topic.collection.is_some()
            || (topic.automatic_key.is_empty() && !active.contains_key(&topic.id))
        {
            continue;
        }
        let previous = topic.source_ids.clone();
        let mut ids = active.get(&topic.id).cloned().unwrap_or_default();
        ids.extend(
            topic
                .source_ids
                .iter()
                .filter(|id| failed.contains(*id) && available.contains(id))
                .cloned(),
        );
        if let Some(page) = &topic.published {
            ids.extend(
                page.citations
                    .iter()
                    .filter(|r| failed.contains(&r.id) && available.contains(&r.id))
                    .map(|r| r.id.clone()),
            );
        }
        topic.source_ids = ids.into_iter().collect();
        changed |= topic.source_ids != previous;
    }
    changed
}
fn catalog_path(root: &Path) -> PathBuf {
    root.join("automatic-catalog.json")
}

fn validate_catalog(
    value: &Value,
    docs: &[Document],
    manifest: &Manifest,
    existing: &[CatalogExisting],
) -> CommandResult<Vec<CatalogTopic>> {
    if value
        .as_object()
        .is_none_or(|fields| fields.len() != 1 || !fields.contains_key("topics"))
    {
        return Err("Invalid Wiki catalog output".into());
    }
    let rows: Vec<CatalogTopic> = serde_json::from_value(value["topics"].clone())
        .map_err(|_| "Invalid Wiki catalog output")?;
    if rows.len() > 40 {
        return Err("Invalid Wiki catalog output".into());
    }
    let mut keys = BTreeSet::new();
    for row in &rows {
        if normalize(&row.key).is_empty()
            || row.key.chars().count() > 200
            || row.title.trim().is_empty()
            || row.title.chars().count() > 200
            || row.overview.chars().count() > 500
            || !matches!(row.kind.as_str(), "project" | "topic")
            || row.citations.is_empty()
            || row.citations.len() > 40
            || !keys.insert(normalize(&row.key))
        {
            return Err("Invalid Wiki catalog output".into());
        }
        sync::validate_result(docs, manifest, &json!({"citations":row.citations}))?;
        if !row
            .citations
            .iter()
            .any(|reference| docs.first().is_some_and(|doc| doc.id == reference.id))
        {
            return Err("Wiki catalog omitted the new source".into());
        }
        if let Some(id) = &row.existing_id {
            let old = existing
                .iter()
                .find(|topic| topic.id == *id)
                .ok_or("Unknown Wiki catalog topic")?;
            if old.manual {
                return Err("Catalog cannot change a manual topic definition".into());
            }
            if !old.topic_kind.is_empty() && old.topic_kind != row.kind {
                return Err("Wiki catalog changed topic identity".into());
            }
            // Cross-meeting identity requires evidence from an existing anchor as well as the new source.
            if !row
                .citations
                .iter()
                .any(|reference| old.source_ids.contains(&reference.id))
            {
                return Err("Wiki catalog identity has no existing source evidence".into());
            }
        }
    }
    Ok(rows)
}

/// Keep only identity facts needed to validate a catalog response. Full Topic
/// values contain page bodies and must not be held across a model request;
/// a wave of these oversized futures can exhaust the async worker stack.
#[derive(Clone)]
struct CatalogExisting {
    id: String,
    topic_kind: String,
    manual: bool,
    source_ids: Vec<String>,
}

impl From<&Topic> for CatalogExisting {
    fn from(topic: &Topic) -> Self {
        Self {
            id: topic.id.clone(),
            topic_kind: topic.topic_kind.clone(),
            manual: topic.collection.is_some(),
            source_ids: topic.source_ids.clone(),
        }
    }
}

fn existing_catalog(values: &[Topic]) -> Vec<CatalogExisting> {
    values.iter().map(Into::into).collect()
}

fn normalize(text: &str) -> String {
    text.chars()
        .filter(|ch| ch.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}
fn apply_catalog(
    topics: &mut Vec<Topic>,
    catalog: &mut Catalog,
    source: &str,
    rows: &[CatalogTopic],
) -> Vec<String> {
    let mut ids = Vec::new();
    for row in rows {
        let key = format!("{}:{}:{}", row.kind, source, normalize(&row.key));
        let id = row
            .existing_id
            .clone()
            .or_else(|| catalog.identities.get(&key).cloned())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        catalog.identities.insert(key.clone(), id.clone());
        if catalog.deleted.contains(&id) {
            ids.push(String::new());
            continue;
        }
        if let Some(topic) = topics.iter_mut().find(|topic| topic.id == id) {
            if topic.excluded {
                ids.push(String::new());
                continue;
            }
        } else {
            topics.push(Topic {
                id: id.clone(),
                title: row.title.clone(),
                purpose: row.overview.clone(),
                topic_kind: row.kind.clone(),
                automatic_key: key.clone(),
                ..Default::default()
            });
        }
        if let Some(topic) = topics.iter_mut().find(|topic| topic.id == id) {
            if topic.automatic_key.is_empty() {
                topic.automatic_key = key.clone();
            }
            if topic.topic_kind.is_empty() {
                topic.topic_kind = row.kind.clone();
            }
            for reference in &row.citations {
                if !topic.source_ids.contains(&reference.id) {
                    topic.source_ids.push(reference.id.clone());
                }
            }
        }
        ids.push(id);
    }
    ids
}

fn apply_catalog_sources(
    topics: &mut Vec<Topic>,
    catalog: &mut Catalog,
    source: &str,
    rows: &[CatalogTopic],
    docs: &[Document],
    active: &mut BTreeMap<String, BTreeSet<String>>,
) {
    let ids = apply_catalog(topics, catalog, source, rows);
    for (id, row) in ids.iter().zip(rows) {
        if id.is_empty() {
            continue;
        }
        let sources = active.entry(id.clone()).or_default();
        sources.extend(
            row.citations
                .iter()
                .filter(|reference| docs.iter().any(|doc| doc.id == reference.id))
                .map(|reference| reference.id.clone()),
        );
        sources.insert(source.to_owned());
    }
}

struct CatalogJob<'a> {
    doc: &'a Document,
    key: String,
    text: String,
}

struct CatalogPlan<'a> {
    jobs: Vec<CatalogJob<'a>>,
    active: BTreeMap<String, BTreeSet<String>>,
    failed_sources: BTreeSet<String>,
    applied: usize,
    failures: usize,
}

fn prepare_catalog<'a>(
    topics: &mut Vec<Topic>,
    catalog: &mut Catalog,
    docs: &'a [Document],
    config: &Models,
) -> CatalogPlan<'a> {
    let mut plan = CatalogPlan {
        jobs: Vec::new(),
        active: BTreeMap::new(),
        failed_sources: BTreeSet::new(),
        applied: 0,
        failures: 0,
    };
    for doc in docs {
        for text in source_chunks(doc, catalog) {
            let key = catalog_chunk_key(doc, &text, config);
            if let Some(error) = catalog.failed.get(&key).cloned() {
                plan.applied += 1;
                plan.failures += 1;
                plan.failed_sources.insert(doc.id.clone());
                if !catalog.details.contains_key(&key) {
                    record_failure(catalog, &key, doc, &error);
                }
            } else if let Some(rows) = catalog.chunks.get(&key).cloned() {
                apply_catalog_sources(topics, catalog, &doc.id, &rows, docs, &mut plan.active);
                plan.applied += 1;
            } else {
                plan.jobs.push(CatalogJob { doc, key, text });
            }
        }
    }
    plan
}

fn adopt_legacy_sources(topics: &mut [Topic]) -> bool {
    let mut changed = false;
    for topic in topics {
        if topic.source_ids.is_empty() && topic.automatic_key.is_empty() {
            if let Some(page) = topic
                .published
                .as_ref()
                .filter(|page| matches!(page.review.as_str(), "approved" | "auto_validated"))
            {
                topic.source_ids = page
                    .citations
                    .iter()
                    .map(|reference| reference.id.clone())
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect();
                changed |= !topic.source_ids.is_empty();
            }
        }
    }
    changed
}

fn citations_key(value: &Value) -> Vec<Value> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .map(|reference| json!([reference["id"], reference["kind"], reference["quote"]]))
        .collect()
}

fn source_content_key(id: &str, kind: &str, title: &str, text: &str, config: &Models) -> String {
    store::digest(
        json!([
            "wiki-auto-source-v3",
            id,
            kind,
            title,
            text.trim(),
            config.text_revision
        ])
        .to_string(),
    )
}

pub(super) fn input_key(doc: &Document, config: &Models) -> String {
    source_content_key(&doc.id, &doc.kind, &doc.title, &doc.text(), config)
}

fn source_chunks(doc: &Document, catalog: &Catalog) -> Vec<String> {
    catalog
        .layouts
        .get(&doc.id)
        .cloned()
        .unwrap_or_else(|| sync::split_text(doc.text().trim(), 12000))
}

fn catalog_chunk_key(doc: &Document, text: &str, config: &Models) -> String {
    format!(
        "{}:0",
        source_content_key(&doc.id, &doc.kind, &doc.title, text, config)
    )
}

fn legacy_input_key(doc: &Document, config: &Models) -> String {
    store::digest(
        json!([
            "wiki-auto-source-v2",
            doc.id,
            doc.revision,
            doc.kind,
            doc.text(),
            config.text_revision
        ])
        .to_string(),
    )
}

fn page_version(topic: &Topic, docs: &[Document], _manifest: &Manifest, config: &Models) -> String {
    // Authorization selects docs before this point; unrelated range settings are not model inputs.
    let sources: Vec<_> = docs.iter().map(|doc| input_key(doc, config)).collect();
    page_version_keys(topic, sources, &config.text_revision)
}

fn page_version_keys(topic: &Topic, mut sources: Vec<String>, text_revision: &str) -> String {
    sources.sort();
    store::digest(
        json!([
            "wiki-auto-page-v3",
            topic.id,
            topic.title,
            topic.purpose,
            topic.notes,
            sources,
            text_revision
        ])
        .to_string(),
    )
}

fn legacy_page_version(topic: &Topic, docs: &[Document], config: &Models) -> String {
    let sources: Vec<_> = docs
        .iter()
        .map(|doc| legacy_input_key(doc, config))
        .collect();
    legacy_page_version_keys(topic, sources, &config.text_revision)
}

fn legacy_page_version_keys(
    topic: &Topic,
    mut sources: Vec<String>,
    text_revision: &str,
) -> String {
    sources.sort();
    store::digest(
        json!([
            "wiki-auto-page-v2",
            topic.id,
            topic.title,
            topic.purpose,
            topic.notes,
            sources,
            text_revision
        ])
        .to_string(),
    )
}

fn source_evidence_key(doc: &Document, config: &Models) -> String {
    store::digest(json!(["wiki-source-evidence-v1", input_key(doc, config)]).to_string())
}

fn batch_compilation_key(topic: &Topic, config: &Models, batch: &[CompilationEvidence]) -> String {
    store::digest(
        json!([
            "wiki-auto-compile-v2",
            topic.id,
            topic.title,
            topic.purpose,
            topic.notes,
            config.text_revision,
            batch
                .iter()
                .map(|item| json!([
                    input_key(&item.source, config),
                    content_cache::canonical(&item.value)
                ]))
                .collect::<Vec<_>>()
        ])
        .to_string(),
    )
}

fn processing_inputs(docs: &[Document], topics: &[Topic], config: &Models) -> String {
    let mut sources: Vec<_> = docs.iter().map(|doc| input_key(doc, config)).collect();
    sources.sort();
    // Collection edits must still wake aggregation when every source is cached.
    let collections: BTreeMap<_, _> = topics
        .iter()
        .filter_map(|topic| {
            let collection = topic
                .collection
                .as_ref()
                .filter(|collection| !collection.hierarchy)?;
            Some((
                &topic.id,
                json!([
                    topic.title,
                    topic.purpose,
                    topic.notes,
                    topic.pinned,
                    topic.excluded,
                    collection
                        .links
                        .iter()
                        .filter(|link| link.manual)
                        .map(|link| (&link.target_id, &link.state))
                        .collect::<BTreeMap<_, _>>()
                ]),
            ))
        })
        .collect();
    let members: BTreeMap<_, _> = if collections.is_empty() {
        BTreeMap::new()
    } else {
        topics
            .iter()
            .filter(|topic| topic.collection.is_none())
            .map(|topic| {
                (
                    &topic.id,
                    json!([topic.title, topic.excluded, topic.published]),
                )
            })
            .collect()
    };
    store::digest(json!(["wiki-auto-run-v1", sources, config, collections, members]).to_string())
}

fn pending_compilation(
    topic: &Topic,
    docs: &[Document],
    manifest: &Manifest,
    config: &Models,
    failed_sources: &BTreeSet<String>,
    source_keys: Option<&BTreeMap<String, String>>,
) -> Option<(Vec<Document>, String)> {
    if topic.collection.is_some()
        || topic.excluded
        || topic.pinned
        || topic.source_ids.is_empty()
        || topic
            .source_ids
            .iter()
            .any(|id| failed_sources.contains(id))
        || topic
            .published
            .as_ref()
            .is_some_and(|page| page.content_hash != store::digest(&page.markdown))
    {
        return None;
    }
    let selected: Vec<_> = docs
        .iter()
        .filter(|doc| topic.source_ids.contains(&doc.id))
        .cloned()
        .collect();
    let version = match source_keys {
        Some(keys) => {
            let selected_keys: Vec<_> = topic
                .source_ids
                .iter()
                .filter_map(|id| keys.get(id).cloned())
                .collect();
            page_version_keys(topic, selected_keys, &config.text_revision)
        }
        None => page_version(topic, &selected, manifest, config),
    };
    if topic
        .partial_compilation
        .as_ref()
        .is_some_and(|partial| partial.version == version && !partial.auto_retry_used)
    {
        return Some((selected, version));
    }
    // Older layouts rejected an entire topic when one oversized item arrived.
    // The repaired splitter can recover those topics without changing source
    // identity, so give this specific persisted failure one bounded retry.
    let legacy_batch_failure = topic.error
        == "Topic evidence exceeds one compilation batch; shorten this topic or retry"
        && topic.last_attempt_fingerprint == version;
    (topic.force_refresh
        || legacy_batch_failure
        || (topic.last_fingerprint != version && topic.last_attempt_fingerprint != version))
        .then_some((selected, version))
}

fn needs_automatic_processing(
    manifest: &Manifest,
    topics: &[Topic],
    docs: &[Document],
    config: &Models,
    catalog: &Catalog,
) -> bool {
    if manifest.wiki_attempted_fingerprint != processing_inputs(docs, topics, config) {
        return true;
    }
    let mut failed_sources = BTreeSet::new();
    for doc in docs {
        for text in source_chunks(doc, catalog) {
            let key = catalog_chunk_key(doc, &text, config);
            if catalog.failed.contains_key(&key) {
                failed_sources.insert(doc.id.clone());
            } else if !catalog.chunks.contains_key(&key) {
                return true;
            }
        }
    }
    topics.iter().any(|topic| {
        pending_compilation(topic, docs, manifest, config, &failed_sources, None).is_some()
    })
}

fn finish_idle_grouping(
    manifest: &mut Manifest,
    topics: &[Topic],
    catalog_failures: usize,
) -> bool {
    let Some(progress) = manifest
        .wiki_progress
        .as_ref()
        .filter(|progress| progress.stage == "grouping")
    else {
        return false;
    };
    let active: Vec<_> = topics
        .iter()
        .filter(|topic| {
            !topic.excluded && (topic.automatic_key.is_empty() || !topic.source_ids.is_empty())
        })
        .collect();
    let topic_failures = active
        .iter()
        .filter(|topic| !topic.error.is_empty())
        .count();
    manifest.wiki_progress = Some(WikiProgress {
        stage: "complete".into(),
        completed: active.len() - topic_failures,
        total: active.len(),
        failed: progress.failed.max(topic_failures + catalog_failures),
        ..Default::default()
    });
    // Grouping shares the progress slot but must not erase earlier processing errors.
    manifest.phase = "ready".into();
    true
}

fn compilation_key(version: &str, batch: &[CompilationEvidence]) -> String {
    store::digest(json!(["wiki-auto-compile-v1", version, batch]).to_string())
}

fn compilation_parts(evidence: &[CompilationEvidence]) -> CommandResult<Vec<Document>> {
    compile_sources(evidence)?
        .into_iter()
        .map(|value| {
            let source = &evidence
                .iter()
                .find(|item| value["id"] == item.source.id)
                .ok_or("Invalid Wiki compilation source")?
                .source;
            let text = value["text"]
                .as_str()
                .ok_or("Invalid Wiki compilation text")?;
            Ok(analysis::part(source, text.into()))
        })
        .collect()
}

pub(super) async fn compile_automatic(
    app: &AppHandle,
    state: &WorkbenchState,
    session: &Session,
    topic: &Topic,
    docs: &[Document],
    manifest: &Manifest,
    root: &Path,
    version: &str,
) -> Result<Revision, WikiFailure> {
    let config = models(app, session)?;
    tasks::profile_scope(
        config.server_profile.clone(),
        compile_automatic_profile(
            app, state, session, topic, docs, manifest, root, version, &config,
        ),
    )
    .await
}

async fn compile_automatic_profile(
    app: &AppHandle,
    state: &WorkbenchState,
    session: &Session,
    topic: &Topic,
    docs: &[Document],
    manifest: &Manifest,
    root: &Path,
    version: &str,
    config: &Models,
) -> Result<Revision, WikiFailure> {
    let query = format!("{}\n{}\nUser corrections (user-provided context, not verified meeting evidence): {}\nWrite Current situation, Important changes and Open questions in the requested language. Preserve source uncertainty. Do not treat unsupported user notes as meeting facts.",topic.title,topic.purpose,topic.notes);
    let mut evidence = Vec::new();
    let mut analysis_failures = Vec::new();
    for doc in docs {
        let chunks = {
            let _guard = state.serial.lock().await;
            require_current(state, session)?;
            source_layout::prepare(root, doc)?
        };
        for text in chunks {
            let part = analysis::part(doc, text);
            let key = source_evidence_key(&part, &config);
            let value = if let Some(value) =
                graph::reusable_analysis(root, session, &part, manifest)
            {
                value
            } else {
                match cached_compilation_prepared(
                root,
                &key,
                &state.serial,
                |value| {
                    require_current(state, session)?;
                    let value = content_cache::rebind(value, std::slice::from_ref(&part), manifest)?;
                    sync::validate_result(std::slice::from_ref(&part), manifest, &value)?;
                    Ok(value)
                },
                true,
                request(
                    app,
                    session,
                    "source_analysis",
                    std::slice::from_ref(&part),
                    "Extract the complete supported meeting evidence, independent of any one project or topic. Preserve substantive decisions, proposals, changes, commitments, conflicts and unresolved questions across all subjects, with exact original-source citations and their uncertainty. Do not invent missing owners, dates or conclusions. This shared evidence will be filtered for each topic later; retain relevant facts from every subject. The complete bounded original text remains available to the final compiler.",
                    Value::Null,
                ),
                )
                .await
                {
                    Ok(value) => value,
                    Err(error) if tolerate_compilation_failure(&error) => {
                        analysis_failures.push(key);
                        json!({"summary":"","citations":[],"insufficientEvidence":true})
                    }
                    Err(error) => {
                        return Err(WikiFailure::new(error, "analyzing", vec![doc.id.clone()]))
                    }
                }
            };
            // Shared extraction is auxiliary, never a topical relevance gate.
            // The final compiler must still see every authorized original chunk,
            // including one for which the extractor found no structured claims.
            evidence.push(CompilationEvidence {
                value,
                source: part,
            });
        }
    }
    if evidence.is_empty() {
        let failures = analysis_failures.len();
        return Err(WikiFailure::new(
            format!("No relevant source evidence found for this topic; {failures} chunks failed analysis"),
            "analyzing",
            Vec::new(),
        ));
    }
    let batches = batch_layout::plan(root, topic, evidence, &config)?;
    let mut bodies = Vec::new();
    let mut refs = Vec::new();
    let mut changes = Vec::new();
    let mut overview = String::new();
    let mut batch_failures = Vec::new();
    for batch in batches {
        let parts = compilation_parts(&batch)?;
        let key = batch_compilation_key(topic, &config, &batch);
        let value = cached_compilation_prepared(
            root,
            &key,
            &state.serial,
            |value| {
                require_current(state, session)?;
                let value = content_cache::rebind(value, &parts, manifest)?;
                sync::validate_result(&parts, manifest, &value)?;
                Ok(value)
            },
            !topic.force_refresh,
            request(
                app,
                session,
                "topic_compile",
                &parts,
                &compilation_query(&query),
                json!(batch),
            ),
        )
        .await;
        let batch_key = key.clone();
        let value = match value {
            Ok(value) => value,
            Err(error) if tolerate_compilation_failure(&error) => {
                batch_failures.push(batch_key);
                continue;
            }
            Err(error) => {
                return Err(WikiFailure::new(
                    error,
                    "compiling",
                    parts.iter().map(|part| part.id.clone()).collect(),
                ))
            }
        };
        if value["insufficientEvidence"] == true {
            continue;
        }
        bodies.push(
            value["summary"]
                .as_str()
                .ok_or("Wiki page has no Markdown")?
                .to_owned(),
        );
        let citations: Vec<SourceRef> = serde_json::from_value(value["citations"].clone())
            .map_err(|_| "Invalid Wiki citations")?;
        if overview.is_empty() {
            overview = value["overview"].as_str().unwrap_or_default().to_owned();
        }
        if let Some(rows) = value["changes"].as_array() {
            for row in rows {
                sync::validate_result(&parts, manifest, &json!({"citations":row["citations"]}))?;
                let text = row["text"]
                    .as_str()
                    .filter(|text| !text.trim().is_empty() && text.chars().count() <= 500)
                    .ok_or("Invalid Wiki change")?;
                let citations = serde_json::from_value(row["citations"].clone())
                    .map_err(|_| "Invalid Wiki change")?;
                changes.push(WikiChange {
                    id: store::digest(
                        json!([topic.id, text, citations_key(&row["citations"])]).to_string(),
                    ),
                    text: text.into(),
                    created_at: crate::now(),
                    citations,
                });
            }
        }
        refs.extend(citations);
    }
    if bodies.is_empty() || refs.is_empty() {
        let failures = analysis_failures.len() + batch_failures.len();
        return Err(WikiFailure::new(
            format!("Wiki page has no supported evidence; {failures} units failed"),
            "compiling",
            Vec::new(),
        ));
    }
    let markdown = assemble_page(&topic.title, &bodies);
    if overview.is_empty() {
        overview = topic.purpose.clone();
    }
    Ok(Revision {
        id: uuid::Uuid::new_v4().to_string(),
        content_hash: store::digest(&markdown),
        markdown,
        citations: refs,
        fingerprint: page_fingerprint(topic, manifest, &models(app, session)?, &[]),
        cache_key: version.into(),
        created_at: crate::now(),
        review: "auto_validated".into(),
        overview,
        changes,
        partial: !analysis_failures.is_empty() || !batch_failures.is_empty(),
        partial_failure_keys: [analysis_failures, batch_failures].concat(),
        ..Default::default()
    })
}

pub(super) fn publish_automatic(
    root: &Path,
    current: &mut Topic,
    mut page: Revision,
    version: &str,
) -> CommandResult<()> {
    let same = current
        .published
        .as_ref()
        .is_some_and(|old| old.markdown == page.markdown);
    if let Some(draft) = current.candidate.take() {
        current.history.push(draft);
    }
    if same {
        if let Some(old) = &mut current.published {
            old.fingerprint = page.fingerprint.clone();
            old.cache_key = version.into();
            old.citations = page.citations.clone();
            if old.overview.is_empty() {
                old.overview = page.overview.clone();
            }
            for change in &mut old.changes {
                for reference in &mut change.citations {
                    if let Some(next) = page
                        .changes
                        .iter()
                        .flat_map(|change| &change.citations)
                        .chain(&page.citations)
                        .find(|next| next.id == reference.id && next.quote == reference.quote)
                    {
                        *reference = next.clone();
                    }
                }
            }
        }
        if let Some(old) = current.published.clone() {
            save_page(root, current, &old, false)?;
        }
    } else {
        let old_changes: BTreeSet<_> = current
            .history
            .iter()
            .flat_map(|old| old.changes.iter().map(|change| change.id.clone()))
            .chain(
                current
                    .published
                    .iter()
                    .flat_map(|old| old.changes.iter().map(|change| change.id.clone())),
            )
            .collect();
        page.changes
            .retain(|change| !old_changes.contains(&change.id));
        if let Some(old) = current.published.take() {
            current.history.push(old);
        }
        save_page(root, current, &page, false)?;
        current.published = Some(page);
    }
    Ok(())
}

pub(super) fn retry(root: &Path) -> CommandResult<()> {
    let mut catalog: Catalog = read_json(&catalog_path(root))?;
    catalog.failed.clear();
    catalog.run_failure = None;
    write_json(&catalog_path(root), &catalog)
}

pub(super) fn retry_service_failures(root: &Path) -> CommandResult<bool> {
    let path = catalog_path(root);
    if !path.exists() {
        return Ok(false);
    }
    let mut catalog: Catalog = read_json(&path)?;
    let previous = catalog.failed.len();
    let run_recovered = catalog
        .run_failure
        .as_ref()
        .is_some_and(|failure| is_service_failure(&failure.message));
    if run_recovered {
        catalog.run_failure = None;
    }
    // Model-output rejections are nondeterministic: give them one fresh
    // attempt per session (bind), not per heartbeat, so a deterministic
    // validation failure cannot burn model calls every two minutes.
    catalog
        .failed
        .retain(|_, error| !is_service_failure(error) && !is_model_output_failure(error));
    let changed = run_recovered || previous != catalog.failed.len();
    if changed {
        write_json(&path, &catalog)?;
    }
    Ok(changed)
}

async fn checked_preflight(
    root: &Path,
    catalog: &mut Catalog,
    verify: impl std::future::Future<Output = CommandResult<()>>,
) -> CommandResult<()> {
    if let Some(failure) = &catalog.run_failure {
        if failure.stage != "preparing"
            || !super::super::knowledge_transport::transient(&failure.message)
        {
            return Err(failure.message.clone());
        }
    }
    if let Err(error) = verify.await {
        catalog.run_failure = Some(CatalogFailure {
            id: "organization".into(),
            source_id: String::new(),
            title: String::new(),
            stage: "preparing".into(),
            message: error.clone(),
            occurred_at: crate::now(),
            validation: None,
        });
        write_json(&catalog_path(root), catalog)?;
        return Err(error);
    }
    // Only a successful authorization check releases a transient connection latch.
    catalog.run_failure = None;
    catalog
        .failed
        .retain(|_, error| !super::super::knowledge_transport::transient(error));
    write_json(&catalog_path(root), catalog)
}

pub(super) async fn run(
    app: &AppHandle,
    state: &WorkbenchState,
    session: &Session,
) -> CommandResult<()> {
    let (root, local, config, mut manifest, docs) = {
        let _guard = state.serial.lock().await;
        require_current(state, session)?;
        let manifest = load_state(app, session)?;
        if ready(&manifest).is_err() {
            return Ok(());
        }
        let (local, _) = roots(app, session)?;
        let docs = documents(&local, &manifest);
        (
            wiki_root(app, session)?,
            local,
            models(app, session)?,
            manifest,
            docs,
        )
    };
    let mut catalog: Catalog = read_json(&catalog_path(&root))?;
    catalog.deleted.extend(topic_store::deleted(&root)?);
    tasks::recover_abandoned(&root)?;
    if tasks::release_due(&root)? {
        let _guard = state.serial.lock().await;
        require_current(state, session)?;
        let mut values = topics(&root)?;
        for topic in &mut values {
            if tasks::Outcome::classify(&topic.error) == tasks::Outcome::Retryable {
                topic.error.clear();
                topic.failure = None;
                topic.last_attempt_fingerprint.clear();
            }
        }
        save_topics(&root, &values)?;
        catalog
            .failed
            .retain(|_, error| tasks::Outcome::classify(error) != tasks::Outcome::Retryable);
        write_json(&catalog_path(&root), &catalog)?;
        manifest = load_state(app, session)?;
        manifest.wiki_attempted_fingerprint.clear();
        persist(app, session, &manifest)?;
    }
    if let Some(failure) = &catalog.run_failure {
        if failure.stage != "preparing"
            || !super::super::knowledge_transport::transient(&failure.message)
        {
            return Err(failure.message.clone());
        }
    }
    {
        let _guard = state.serial.lock().await;
        require_current(state, session)?;
        for doc in &docs {
            catalog
                .layouts
                .insert(doc.id.clone(), source_layout::prepare(&root, doc)?);
        }
        for previous in compatible_legacy_models(session, &config) {
            migrate_catalog_revision(
                &root,
                &local,
                &mut catalog,
                &docs,
                &manifest,
                &config,
                &previous.text_revision,
            )?;
        }
        migrate_scope_cache(&root, &local, &docs, &manifest, &config)?;
        cache_upgrade::refresh(
            &root,
            &mut catalog,
            &docs,
            &manifest,
            &config,
            &compatible_legacy_models(session, &config),
        )?;
    }
    // An idle vault must not sweep the whole catalog on every worker wakeup:
    // the heartbeat re-enters this run every two minutes, and the sweep alone
    // (one topics() parse per chunk) keeps the UI in "organizing" for minutes
    // with zero model work to show for it.
    let initial_topics = {
        let _guard = state.serial.lock().await;
        require_current(state, session)?;
        topics(&root)?
    };
    if !needs_automatic_processing(&manifest, &initial_topics, &docs, &config, &catalog) {
        let _guard = state.serial.lock().await;
        require_current(state, session)?;
        let mut latest = load_state(app, session)?;
        let catalog_failures = docs
            .iter()
            .map(|doc| {
                source_chunks(doc, &catalog)
                    .iter()
                    .filter(|text| {
                        catalog
                            .failed
                            .contains_key(&catalog_chunk_key(doc, text, &config))
                    })
                    .count()
            })
            .sum();
        if finish_idle_grouping(&mut latest, &initial_topics, catalog_failures) {
            persist(app, session, &latest)?;
        }
        return Ok(());
    }
    // Save the inputs actually attempted, so a change during this pass remains pending.
    let attempted_inputs = processing_inputs(&docs, &initial_topics, &config);
    // Topic failures from earlier passes stay visible in progress reports
    // instead of being silently reset to zero by the next stage update.
    let carried_failures = manifest
        .wiki_progress
        .as_ref()
        .map(|progress| progress.failed)
        .unwrap_or(0);
    let current_keys: BTreeSet<_> = docs
        .iter()
        .flat_map(|doc| {
            source_chunks(doc, &catalog)
                .into_iter()
                .map(|text| catalog_chunk_key(doc, &text, &config))
                .collect::<Vec<_>>()
        })
        .collect();
    if let Some(error) = catalog.failed.iter().find_map(|(key, error)| {
        (current_keys.contains(key)
            && is_service_failure(error)
            && !super::super::knowledge_transport::transient(error))
        .then_some(error)
    }) {
        return Err(error.clone());
    }
    // Refresh this server's policy before using persisted settings from an earlier route.
    let preflight = checked_preflight(&root, &mut catalog, async {
        let capabilities =
            knowledge_cloud::request(app, session, "/capabilities", None, None).await?;
        if capabilities["available"] != true {
            return Err("Cloud knowledge capability unavailable or authorization rejected".into());
        }
        let policy = capabilities
            .get("policy")
            .ok_or("Cloud source eligibility unavailable")?;
        if policy["enrolled"] != true {
            return Err("Cloud knowledge organization is not enabled on this server".into());
        }
        // A changed range requires review instead of silently dropping saved source links.
        if docs.iter().any(|doc| {
            !knowledge_cloud::local_allows(
                doc,
                &Manifest {
                    knowledge_policy: Some(policy.clone()),
                    knowledge_pending: None,
                    ..manifest.clone()
                },
            )
        }) {
            return Err(
                "Cloud knowledge selected folders changed; review the organization range".into(),
            );
        }
        Ok::<(), String>(())
    })
    .await;
    if let Err(error) = preflight {
        let _guard = state.serial.lock().await;
        require_current(state, session)?;
        let mut latest = load_state(app, session)?;
        latest.wiki_progress = Some(WikiProgress {
            stage: "preparing".into(),
            ..Default::default()
        });
        persist(app, session, &latest)?;
        return Err(error);
    }
    let CatalogPlan {
        jobs,
        mut active,
        mut failed_sources,
        mut applied,
        failures: mut catalog_failures,
    } = {
        let _guard = state.serial.lock().await;
        require_current(state, session)?;
        backup_legacy(app, session)?;
        let mut values = topics(&root)?;
        adopt_legacy_sources(&mut values);
        // Restore cached identities and source links in one pass without
        // re-entering the model queue or reporting analysis for cached text.
        let plan = prepare_catalog(&mut values, &mut catalog, &docs, &config);
        save_topics(&root, &values)?;
        write_json(&catalog_path(&root), &catalog)?;
        plan
    };
    let catalog_total = applied + jobs.len();
    // Catalog requests are fanned out in waves sized to the shared model
    // queue; each wave's results then apply serially so topic identity,
    // progress and persisted state keep their original single-stream order.
    let wave_size = state.synthesis_queue.capacity().max(1);
    let shared_manifest = Arc::new(manifest.clone());
    let shared_docs = Arc::new(docs.clone());
    for wave in jobs.chunks(wave_size) {
        report_progress(
            app,
            state,
            session,
            WikiProgress {
                stage: "analyzing".into(),
                completed: applied,
                total: catalog_total,
                failed: carried_failures + catalog_failures,
                current_title: wave
                    .first()
                    .map(|job| job.doc.title.clone())
                    .unwrap_or_default(),
                ..Default::default()
            },
        )
        .await?;
        let results: Vec<CommandResult<Vec<CatalogTopic>>> = future::join_all(wave.iter().map(|job| {
            let root = root.clone();
            let docs = Arc::clone(&shared_docs);
            let manifest = Arc::clone(&shared_manifest);
            let server_profile = config.server_profile.clone();
            Box::pin(async move {
            let mut parts = vec![analysis::part(job.doc, job.text.clone())];
            let mut anchors = Vec::new();
            let existing = {
                let _guard=state.serial.lock().await;
                require_current(state,session)?;
                topics(&root)?
            };
            for topic in retrieval::candidates(&existing, job.doc, 12) {
                let Some(anchor) = docs
                    .iter()
                    .find(|source| topic.source_ids.contains(&source.id))
                else {
                    continue;
                };
                if !parts.iter().any(|part| part.id == anchor.id) {
                    if parts.len() >= 4 {
                        continue;
                    }
                    parts.push(analysis::part(
                        anchor,
                        sync::split_text(anchor.text().trim(), 12000)
                            .into_iter()
                            .next()
                            .unwrap_or_default(),
                    ));
                }
                let source_ids: Vec<_> = parts
                    .iter()
                    .filter(|part| topic.source_ids.contains(&part.id))
                    .map(|part| &part.id)
                    .collect();
                anchors.push(json!({"id":topic.id,"title":topic.title,"kind":topic.topic_kind,"excluded":topic.excluded,"sourceIds":source_ids}));
            }
            let existing = existing_catalog(&existing);
            let query = json!({"existingTopics":anchors,"newSourceId":job.doc.id}).to_string();
            let value = cached_compilation_prepared(&root, &format!("catalog-{}", job.key), &state.serial,
                |value| {
                    let value = content_cache::rebind(value, &parts, &manifest)?;
                    validate_catalog(&value, &parts, &manifest, &existing)?;
                    Ok(value)
                }, true, tasks::profile_scope(server_profile.clone(),request(app, session, "wiki_catalog", &parts, &query, Value::Null))).await?;
            validate_catalog(&value, &parts, &manifest, &existing)
            })
        }))
        .await;
        let mut wave_error = None;
        for (job, result) in wave.iter().zip(results) {
            applied += 1;
            let _guard = state.serial.lock().await;
            require_current(state, session)?;
            match result {
                Ok(rows) => {
                    catalog.chunks.insert(job.key.clone(), rows.clone());
                    catalog.failed.remove(&job.key);
                    catalog.details.remove(&job.key);
                    let mut existing = topics(&root)?;
                    apply_catalog_sources(
                        &mut existing,
                        &mut catalog,
                        &job.doc.id,
                        &rows,
                        &docs,
                        &mut active,
                    );
                    save_topics(&root, &existing)?;
                    write_json(&catalog_path(&root), &catalog)?;
                }
                // Service failures apply to the whole run, never to an individual source.
                Err(error) if is_service_failure(&error) => {
                    catalog.details.remove(&job.key);
                    record_failure(&mut catalog, &job.key, job.doc, &error);
                    write_json(&catalog_path(&root), &catalog)?;
                    wave_error.get_or_insert(error);
                }
                Err(error) => {
                    catalog.details.remove(&job.key);
                    record_failure(&mut catalog, &job.key, job.doc, &error);
                    failed_sources.insert(job.doc.id.clone());
                    catalog_failures += 1;
                    write_json(&catalog_path(&root), &catalog)?;
                }
            }
        }
        // Every response in this wave has already completed. Preserve its
        // successful work before stopping new requests on a service failure.
        if let Some(error) = wave_error {
            return Err(error);
        }
    }
    let initial = {
        let _guard = state.serial.lock().await;
        require_current(state, session)?;
        let mut values = topics(&root)?;
        if reconcile_sources(&mut values, &active, &failed_sources, &docs) {
            save_topics(&root, &values)?;
        }
        values
    };
    let active_topics: Vec<_> = initial
        .into_iter()
        .filter(|topic| {
            topic.collection.is_none()
                && !topic.excluded
                && !topic.pinned
                && !topic.source_ids.is_empty()
                && !topic
                    .published
                    .as_ref()
                    .is_some_and(|page| page.content_hash != store::digest(&page.markdown))
        })
        .collect();
    let total_topics = active_topics.len();
    let mut completed = 0;
    // Full source text is immutable during this pass. Hash it once, then use
    // those identities to decide which topics still need compilation.
    let source_keys: BTreeMap<String, String> = docs
        .iter()
        .map(|doc| (doc.id.clone(), input_key(doc, &config)))
        .collect();
    let pending: Vec<_> = active_topics
        .into_iter()
        .filter_map(|topic| {
            if topic
                .source_ids
                .iter()
                .any(|id| failed_sources.contains(id))
            {
                return None;
            }
            match pending_compilation(
                &topic,
                &docs,
                &manifest,
                &config,
                &failed_sources,
                Some(&source_keys),
            ) {
                Some((selected, version)) => Some((topic, selected, version)),
                None => {
                    completed += 1;
                    None
                }
            }
        })
        .collect();
    let had_work = !jobs.is_empty() || !pending.is_empty();
    let mut topic_failures_run = 0usize;
    // Compile requests run in waves so a first-run backlog uses the shared
    // model queue concurrently; per-topic state changes still apply serially
    // in the original order after each wave completes.
    let compile_wave = state.synthesis_queue.capacity().min(3).max(1);
    for wave in pending.chunks(compile_wave) {
        report_progress(
            app,
            state,
            session,
            WikiProgress {
                stage: "compiling".into(),
                completed,
                total: total_topics,
                failed: carried_failures + catalog_failures + topic_failures_run,
                topic_title: wave
                    .first()
                    .map(|(topic, _, _)| topic.title.clone())
                    .unwrap_or_default(),
                ..Default::default()
            },
        )
        .await?;
        let results = future::join_all(wave.iter().map(|(topic, selected, version)| {
            let manifest = Arc::clone(&shared_manifest);
            let root = root.clone();
            Box::pin(async move {
                compile_automatic(
                    app, state, session, topic, selected, &manifest, &root, version,
                )
                .await
            })
        }))
        .await;
        let mut wave_error = None;
        for ((topic, _, version), result) in wave.iter().zip(results) {
            if let Err(error) = &result {
                if is_service_failure(&error.message) {
                    wave_error.get_or_insert(error.message.clone());
                    continue;
                }
            }
            let _guard = state.serial.lock().await;
            require_current(state, session)?;
            let latest = load_state(app, session)?;
            ready(&latest)?;
            let mut values = topics(&root)?;
            let Some(current) = values
                .iter_mut()
                .find(|current| current.id == topic.id && !current.excluded && !current.pinned)
            else {
                continue;
            };
            if current
                .published
                .as_ref()
                .is_some_and(|page| page.content_hash != store::digest(&page.markdown))
            {
                continue;
            }
            let latest_docs: Vec<_> = documents(&local, &latest)
                .into_iter()
                .filter(|doc| current.source_ids.contains(&doc.id))
                .collect();
            if page_version(current, &latest_docs, &latest, &models(app, session)?) != *version {
                continue;
            }
            let mut discarded = false;
            match result {
                Ok(mut page) => {
                    page.fingerprint = page_fingerprint(current, &latest, &config, &page.citations);
                    if !valid_page(&local, &latest, &page) {
                        // Sources moved mid-compile (e.g. a deferred meeting
                        // finished transcribing during this wave). Keep the
                        // previous page and recompile on the next pass against
                        // the settled sources instead of latching an error no
                        // automatic path ever retries.
                        log::warn!(
                            "[wiki-apply] discarded page for topic {} ({}): citations={:?} sources={:?}",
                            current.title,
                            current.id,
                            page.citations.iter().map(|c| (&c.id, &c.kind, c.revision.as_str())).collect::<Vec<_>>(),
                            current.source_ids
                        );
                        discarded = true;
                        current.error.clear();
                        current.failure = None;
                    } else {
                        let was_auto_retried = current
                            .partial_compilation
                            .as_ref()
                            .is_some_and(|partial| partial.auto_retry_used);
                        let page_is_partial = page.partial;
                        let page_failure_keys = page.partial_failure_keys.clone();
                        publish_automatic(&root, current, page, version)?;
                        current.partial_compilation = if page_is_partial {
                            Some(PartialCompilation {
                                version: version.clone(),
                                failure_keys: page_failure_keys,
                                auto_retry_used: was_auto_retried,
                            })
                        } else {
                            None
                        };
                        if page_is_partial {
                            current.error = "Some evidence batches failed; retry to complete this topic".into();
                        } else {
                            current.error.clear();
                        }
                        current.failure = None;
                        current.last_fingerprint = version.clone();
                        completed += 1;
                    }
                }
                Err(failure) => {
                    current.error = failure.message.clone();
                    current.failure = Some(failure);
                    if let Some(partial) = &mut current.partial_compilation {
                        partial.auto_retry_used = true;
                    }
                    topic_failures_run += 1;
                }
            }
            if !discarded {
                current.last_attempt_fingerprint = version.clone();
            }
            current.force_refresh = false;
            save_topics(&root, &values)?;
            persist(app, session, &latest)?;
        }
        if let Some(error) = wave_error {
            return Err(error);
        }
    }
    // An idle pass (every chunk cached and every topic settled) must not
    // regroup and re-validate every published topic; skip the sweep and just
    // normalize the completion state below.
    if had_work
        || initial_topics.iter().any(|topic| {
            topic
                .collection
                .as_ref()
                .is_some_and(|collection| !collection.hierarchy)
        })
    {
        collections::run(app, state, session).await?;
    }
    let embedding_failures = embed_sources(app, state, session, &config, &root, &local).await?;
    super::drain_usage_receipts(app, session, state).await;
    let _guard = state.serial.lock().await;
    require_current(state, session)?;
    let mut latest = load_state(app, session)?;
    let values = topics(&root)?;
    let active: Vec<_> = values
        .into_iter()
        .filter(|topic| topic.automatic_key.is_empty() || !topic.source_ids.is_empty())
        .collect();
    latest.wiki_attempted_fingerprint = attempted_inputs;
    complete_processing(&mut latest, &active, embedding_failures);
    if catalog_failures > 0 {
        if let Some(progress) = &mut latest.wiki_progress {
            progress.failed += catalog_failures;
        }
        latest.error = format!(
            "Wiki catalog failed for {catalog_failures} sources; retry automatic organization"
        );
    }
    persist(app, session, &latest)
}

pub(super) fn topic_graph(topics: &[Topic], items: &[Value]) -> Value {
    let visible: Vec<_> = topics
        .iter()
        .filter(|topic| {
            !topic.excluded
                && topic.published.is_some()
                && items.iter().any(|item| {
                    item["id"] == topic.id
                        && item["inScope"] != false
                        && item["published"].is_object()
                })
        })
        .collect();
    let nodes: Vec<_> = visible.iter().map(|topic| json!({"id":format!("wiki:{}",topic.id),"wikiId":topic.id,"kind":"wiki",
        "subtype":topic.topic_kind,"title":topic.title,"description":topic.published.as_ref().map(|page| &page.overview),"status":"published","citations":[],"updates":[]})).collect();
    let mut by_source: BTreeMap<&str, BTreeSet<usize>> = BTreeMap::new();
    for (index, topic) in visible.iter().enumerate() {
        for id in topic.source_ids.iter().map(String::as_str).chain(
            topic
                .published
                .iter()
                .flat_map(|page| page.citations.iter().map(|reference| reference.id.as_str())),
        ) {
            by_source.entry(id).or_default().insert(index);
        }
    }
    let mut pairs: BTreeMap<(usize, usize), Vec<&str>> = BTreeMap::new();
    for (source, members) in by_source {
        let members: Vec<_> = members.into_iter().collect();
        for (offset, a) in members.iter().enumerate() {
            for b in &members[offset + 1..] {
                pairs.entry((*a, *b)).or_default().push(source);
            }
        }
    }
    let mut edges: Vec<_> = pairs.into_iter().map(|((a,b),sources)| {
        let (a,b) = (visible[a],visible[b]);
        json!({"id":format!("shared:{}:{}",a.id,b.id),"source":format!("wiki:{}",a.id),"target":format!("wiki:{}",b.id),"kind":"shared_source","sourceIds":sources})
    }).collect();
    for topic in &visible {
        if let Some(collection) = &topic.collection {
            for link in &collection.links {
                if link.state == "included"
                    && visible.iter().any(|member| member.id == link.target_id)
                {
                    edges.push(json!({"id":format!("contains:{}:{}",topic.id,link.target_id),"source":format!("wiki:{}",topic.id),"target":format!("wiki:{}",link.target_id),"kind":"contains_topic"}));
                }
            }
        }
    }
    json!({"nodes":nodes,"edges":edges,"automaticTracking":true,"tracking":{"processing":false,"completed":visible.len(),"total":visible.len(),"failed":0,"error":""}})
}

#[cfg(test)]
#[path = "wiki_automation_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "wiki_incremental_tests.rs"]
mod incremental_tests;
