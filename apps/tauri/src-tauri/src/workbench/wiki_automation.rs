//! Automatic, folder-scoped Wiki cataloguing and validated publication.
use super::*;
use std::collections::{BTreeMap, BTreeSet};
#[path = "wiki_scope_cache.rs"]
mod scope_cache;
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
    if !knowledge_cloud::local_allows(doc,manifest) { return false; }
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
        doc.folder_id = folder.into();
        doc.refresh_revision();
        let next = store::write_document(local, &doc, Some(&entry))?;
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
    let query = if matches!(task, "wiki_catalog" | "wiki_topic_match" | "wiki_topic_group") {
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

fn record_failure(catalog: &mut Catalog, key: &str, doc: &Document, error: &str) {
    catalog.failed.insert(key.into(), error.into());
    let (message, validation) = validation_failure::split(error.into());
    catalog.details.insert(key.into(), CatalogFailure {
        id: key.into(), source_id: doc.id.clone(), title: doc.title.clone(),
        stage: "analyzing".into(), message, validation, occurred_at: crate::now(),
    });
}

pub(super) fn source_failures(root: &Path) -> CommandResult<Value> {
    let catalog: Catalog = read_json(&catalog_path(root))?;
    let mut failures: Vec<Value> = catalog.run_failure.iter().map(|failure| json!(failure)).collect();
    failures.extend(catalog.details.values().map(|failure| {
        let mut value = json!(failure);
        value["retrying"] = json!(!catalog.failed.contains_key(&failure.id));
        value
    }));
    Ok(json!(failures))
}

// Only adopt receipts whose complete old input identity and current citations match.
fn migrate_catalog_revision(
    root: &Path, local: &Path, catalog: &mut Catalog, docs: &[Document],
    manifest: &Manifest, config: &Models, previous: &str,
) -> CommandResult<()> {
    if previous.is_empty() || previous == config.text_revision { return Ok(()); }
    let mut old = config.clone();
    old.text_revision = previous.into();
    migrate_scope_cache(root, local, docs, manifest, &old)?;
    let mut values = topics(root)?;
    let mut page_sources = PageSources::new(local, manifest);
    for doc in docs {
        for index in 0..sync::split_text(doc.text().trim(), 12000).len() {
            let key = format!("{}:{index}", input_key(doc, config));
            let old_key = format!("{}:{index}", input_key(doc, &old));
            if catalog.chunks.contains_key(&key) { continue; }
            let Some(rows) = catalog.chunks.get(&old_key).cloned() else { continue; };
            if rows.iter().all(|row| row.citations.iter().any(|r| r.id == doc.id)
                && sync::validate_result(docs, manifest, &json!({"citations":row.citations})).is_ok()) {
                catalog.chunks.insert(key.clone(), rows);
                catalog.failed.remove(&key);
                catalog.details.remove(&key);
                catalog.failed.remove(&old_key);
                catalog.details.remove(&old_key);
            }
        }
    }
    // Recover associations from validated receipts, including state damaged by older retries.
    let mut links: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for doc in docs {
        for index in 0..sync::split_text(doc.text().trim(), 12000).len() {
            if let Some(rows) = catalog.chunks.get(&format!("{}:{index}", input_key(doc, config))) {
                for row in rows {
                    let identity = format!("{}:{}:{}", row.kind, doc.id, normalize(&row.key));
                    if let Some(id) = row.existing_id.as_ref().or_else(|| catalog.identities.get(&identity)) {
                        links.entry(id.clone()).or_default().insert(doc.id.clone());
                        links.entry(id.clone()).or_default().extend(row.citations.iter().map(|r| r.id.clone()));
                    }
                }
            }
        }
    }
    for topic in &mut values {
        if topic.collection.is_some() { continue; }
        if topic.source_ids.is_empty() {
            if let Some(ids) = links.get(&topic.id) { topic.source_ids = ids.iter().cloned().collect(); }
        }
        let selected: Vec<_> = docs.iter().filter(|doc| topic.source_ids.contains(&doc.id)).cloned().collect();
        if !selected.is_empty() && !topic.force_refresh && topic.error.is_empty()
            && topic.published.as_ref().is_some_and(|page| page_sources.valid_page(page)
                && page.content_hash == store::digest(&page.markdown))
            && (topic.last_fingerprint == page_version(topic, &selected, manifest, &old)
                || manifest.wiki_automation.as_ref().is_some_and(|scope|
                    topic.last_fingerprint == scope_cache::legacy_version(topic, &selected, scope, &old))) {
            let expected = page_fingerprint(topic, manifest, &old, &topic.published.as_ref().unwrap().citations);
            let legacy_expected = manifest.wiki_automation.as_ref().map(|scope|
                page_fingerprint_with_legacy_scope(topic, manifest, &old, &topic.published.as_ref().unwrap().citations, Some(scope)));
            let replacement = page_fingerprint(topic, manifest, config, &topic.published.as_ref().unwrap().citations);
            if !topic.published.as_ref().is_some_and(|page|
                page.fingerprint == expected || legacy_expected.as_ref() == Some(&page.fingerprint)) { continue; }
            topic.last_fingerprint = page_version(topic, &selected, manifest, config);
            topic.last_attempt_fingerprint = topic.last_fingerprint.clone();
            if let Some(page) = topic.published.as_mut() {
                page.fingerprint = replacement;
                page.cache_key = topic.last_fingerprint.clone();
                write_json(&root.join(&topic.id).join("published.json"), page)?;
            }
        }
    }
    save_topics(root, &values)?;
    write_json(&catalog_path(root), catalog)
}

fn reconcile_sources(values: &mut [Topic], active: &BTreeMap<String, BTreeSet<String>>,
    failed: &BTreeSet<String>, docs: &[Document]) {
    let available: BTreeSet<_> = docs.iter().map(|doc| &doc.id).collect();
    for topic in values {
        if topic.collection.is_some() || (topic.automatic_key.is_empty() && !active.contains_key(&topic.id)) { continue; }
        let mut ids = active.get(&topic.id).cloned().unwrap_or_default();
        ids.extend(topic.source_ids.iter().filter(|id| failed.contains(*id) && available.contains(id)).cloned());
        if let Some(page) = &topic.published {
            ids.extend(page.citations.iter().filter(|r| failed.contains(&r.id) && available.contains(&r.id)).map(|r| r.id.clone()));
        }
        topic.source_ids = ids.into_iter().collect();
    }
}
fn catalog_path(root: &Path) -> PathBuf {
    root.join("automatic-catalog.json")
}

fn validate_catalog(
    value: &Value,
    docs: &[Document],
    manifest: &Manifest,
    existing: &[Topic],
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
                .find(|topic| &topic.id == id)
                .ok_or("Unknown Wiki catalog topic")?;
            if old.collection.is_some() { return Err("Catalog cannot change a manual topic definition".into()); }
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

pub(super) fn input_key(doc: &Document, config: &Models) -> String {
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
    let mut sources: Vec<_> = docs.iter().map(|doc| input_key(doc, config)).collect();
    sources.sort();
    store::digest(
        json!([
            "wiki-auto-page-v2",
            topic.id,
            topic.title,
            topic.purpose,
            topic.notes,
            sources,
            config.text_revision
        ])
        .to_string(),
    )
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
                .ok_or("Invalid Wiki compilation source")?.source;
            let text = value["text"].as_str().ok_or("Invalid Wiki compilation text")?;
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
    let query = format!("{}\n{}\nUser corrections (user-provided context, not verified meeting evidence): {}\nWrite Current situation, Important changes and Open questions in the requested language. Preserve source uncertainty. Do not treat unsupported user notes as meeting facts.",topic.title,topic.purpose,topic.notes);
    let mut evidence = Vec::new();
    let config = models(app, session)?;
    for doc in docs {
        for (index, text) in sync::split_text(doc.text().trim(), 12000).into_iter().enumerate() {
            let part = analysis::part(doc, text);
            let key = store::digest(
                json!([
                    "wiki-auto-analysis-v1",
                    topic.id,
                    topic.title,
                    topic.purpose,
                    topic.notes,
                    input_key(&part, &config),
                    index
                ])
                .to_string(),
            );
            let value = if let Some(value) = graph::reusable_analysis(root, session, &part, manifest) {
                value
            } else { cached_compilation(
                root,
                &key,
                &state.serial,
                |value| {
                    require_current(state, session)?;
                    sync::validate_result(std::slice::from_ref(&part), manifest, value)
                },
                true,
                request(
                    app,
                    session,
                    "source_analysis",
                    std::slice::from_ref(&part),
                    &query,
                    Value::Null,
                ),
            )
            .await.map_err(|error| WikiFailure::new(error, "analyzing", vec![doc.id.clone()]))? };
            if value["relevant"] != false && value["insufficientEvidence"] != true {
                evidence.push(CompilationEvidence { value, source: part });
            }
        }
    }
    if evidence.is_empty() {
        return Err("No relevant source evidence found for this topic".into());
    }
    let mut batches: Vec<Vec<CompilationEvidence>> = Vec::new();
    let mut batch = Vec::new();
    for item in evidence {
        let mut trial = batch.clone();
        trial.push(item.clone());
        if !batch.is_empty()
            && (trial.len() > 100
                || serde_json::to_string(&trial)
                    .map_err(|e| e.to_string())?
                    .len()
                    > 50000
                || compile_sources(&trial).is_err())
        {
            batches.push(std::mem::take(&mut batch));
        }
        batch.push(item);
        compile_sources(&batch)?;
    }
    if !batch.is_empty() {
        batches.push(batch);
    }
    let mut bodies = Vec::new();
    let mut refs = Vec::new();
    let mut changes = Vec::new();
    let mut overview = String::new();
    for batch in batches {
        let parts = compilation_parts(&batch)?;
        let key = compilation_key(version, &batch);
        let value = cached_compilation(
            root,
            &key,
            &state.serial,
            |value| {
                require_current(state, session)?;
                sync::validate_result(&parts, manifest, value)
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
        .await.map_err(|error| WikiFailure::new(error, "compiling", parts.iter().map(|part| part.id.clone()).collect()))?;
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
        return Err("Wiki page has no supported evidence".into());
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
    let run_recovered = catalog.run_failure.as_ref().is_some_and(|failure| is_service_failure(&failure.message));
    if run_recovered { catalog.run_failure = None; }
    catalog.failed.retain(|_, error| !is_service_failure(error));
    let changed = run_recovered || previous != catalog.failed.len();
    if changed {
        write_json(&path, &catalog)?;
    }
    Ok(changed)
}

async fn checked_preflight(
    root: &Path, catalog: &mut Catalog,
    verify: impl std::future::Future<Output = CommandResult<()>>,
) -> CommandResult<()> {
    if let Some(failure) = &catalog.run_failure {
        if failure.stage != "preparing" || !super::super::knowledge_transport::transient(&failure.message) {
            return Err(failure.message.clone());
        }
    }
    if let Err(error) = verify.await {
        catalog.run_failure = Some(CatalogFailure { id: "organization".into(), source_id: String::new(),
            title: String::new(), stage: "preparing".into(), message: error.clone(), occurred_at: crate::now(), validation: None });
        write_json(&catalog_path(root), catalog)?;
        return Err(error);
    }
    // Only a successful authorization check releases a transient connection latch.
    catalog.run_failure = None;
    catalog.failed.retain(|_, error| !super::super::knowledge_transport::transient(error));
    write_json(&catalog_path(root), catalog)
}

pub(super) async fn run(
    app: &AppHandle,
    state: &WorkbenchState,
    session: &Session,
) -> CommandResult<()> {
    let (root, local, config, manifest, docs) = {
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
    if let Some(failure) = &catalog.run_failure {
        if failure.stage != "preparing" || !super::super::knowledge_transport::transient(&failure.message) {
            return Err(failure.message.clone());
        }
    }
    {
        let _guard = state.serial.lock().await;
        require_current(state, session)?;
        migrate_catalog_revision(&root, &local, &mut catalog, &docs, &manifest, &config, &config.legacy_text_revision)?;
        migrate_scope_cache(&root, &local, &docs, &manifest, &config)?;
    }
    let current_keys: BTreeSet<_> = docs.iter().flat_map(|doc| {
        let prefix = input_key(doc, &config);
        (0..sync::split_text(doc.text().trim(), 12000).len()).map(move |index| format!("{prefix}:{index}"))
    }).collect();
    if let Some(error) = catalog.failed.iter().find_map(|(key, error)| {
        (current_keys.contains(key) && is_service_failure(error)
            && !super::super::knowledge_transport::transient(error)).then_some(error)
    }) { return Err(error.clone()); }
    // Refresh this server's policy before using persisted settings from an earlier route.
    let preflight = checked_preflight(&root, &mut catalog, async {
        let capabilities = knowledge_cloud::request(app, session, "/capabilities", None, None).await?;
        if capabilities["available"] != true { return Err("Cloud knowledge capability unavailable or authorization rejected".into()); }
        let policy = capabilities.get("policy").ok_or("Cloud source eligibility unavailable")?;
        if policy["enrolled"] != true { return Err("Cloud knowledge organization is not enabled on this server".into()); }
        // A changed range requires review instead of silently dropping saved source links.
        if docs.iter().any(|doc| !knowledge_cloud::local_allows(doc, &Manifest {
            knowledge_policy: Some(policy.clone()), knowledge_pending: None, ..manifest.clone()
        })) { return Err("Cloud knowledge selected folders changed; review the organization range".into()); }
        Ok::<(), String>(())
    }).await;
    if let Err(error) = preflight {
        let _guard = state.serial.lock().await;
        require_current(state, session)?;
        let mut latest = load_state(app, session)?;
        latest.wiki_progress = Some(WikiProgress { stage: "preparing".into(), ..Default::default() });
        persist(app, session, &latest)?;
        return Err(error);
    }
    {
        let _guard = state.serial.lock().await;
        require_current(state, session)?;
        backup_legacy(app, session)?;
        let mut values = topics(&root)?;
        if adopt_legacy_sources(&mut values) {
            save_topics(&root, &values)?;
        }
    }
    let mut active: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut catalog_failures = 0;
    let mut failed_sources = BTreeSet::new();
    let catalog_total: usize = docs
        .iter()
        .map(|doc| sync::split_text(doc.text().trim(), 12000).len())
        .sum();
    let mut catalog_completed = 0;
    for doc in &docs {
        for (index, text) in sync::split_text(doc.text().trim(), 12000).into_iter().enumerate() {
            let completed = catalog_completed;
            catalog_completed += 1;
            let key = format!("{}:{index}", input_key(doc, &config));
            if catalog.failed.contains_key(&key) {
                catalog_failures += 1;
                failed_sources.insert(doc.id.clone());
                if !catalog.details.contains_key(&key) {
                    let error = catalog.failed[&key].clone();
                    record_failure(&mut catalog, &key, doc, &error);
                }
                continue;
            }
            let mut existing = topics(&root)?;
            let rows = if let Some(rows) = catalog.chunks.get(&key) {
                rows.clone()
            } else {
                report_progress(
                    app,
                    state,
                    session,
                    WikiProgress {
                        stage: "analyzing".into(),
                        completed,
                        total: catalog_total,
                        current_title: doc.title.clone(),
                        ..Default::default()
                    },
                )
                .await?;
                let mut parts = vec![analysis::part(doc, text)];
                let mut anchors = Vec::new();
                for topic in &existing {
                    if topic.collection.is_some() { continue; }
                    if anchors.len() >= 12 {
                        break;
                    }
                    if !topic.source_ids.contains(&doc.id) && !doc.text().contains(&topic.title) {
                        continue;
                    }
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
                let query = json!({"existingTopics":anchors,"newSourceId":doc.id}).to_string();
                let result = request(app, session, "wiki_catalog", &parts, &query, Value::Null)
                    .await
                    .and_then(|value| validate_catalog(&value, &parts, &manifest, &existing));
                let _guard = state.serial.lock().await;
                require_current(state, session)?;
                match result {
                    Ok(rows) => {
                        catalog.chunks.insert(key.clone(), rows.clone());
                        catalog.failed.remove(&key);
                        catalog.details.remove(&key);
                        rows
                    }
                    // Service failures apply to the whole run, never to an individual source.
                    Err(error) if is_service_failure(&error) => {
                        record_failure(&mut catalog, &key, doc, &error);
                        write_json(&catalog_path(&root), &catalog)?;
                        return Err(error);
                    },
                    Err(error) => {
                        record_failure(&mut catalog, &key, doc, &error);
                        failed_sources.insert(doc.id.clone());
                        catalog_failures += 1;
                        write_json(&catalog_path(&root), &catalog)?;
                        continue;
                    }
                }
            };
            catalog.details.remove(&key);
            let _guard = state.serial.lock().await;
            require_current(state, session)?;
            existing = topics(&root)?;
            let ids = apply_catalog(&mut existing, &mut catalog, &doc.id, &rows);
            for (id, row) in ids.iter().zip(&rows) {
                if id.is_empty() {
                    continue;
                }
                active.entry(id.clone()).or_default().extend(
                    row.citations
                        .iter()
                        .filter(|reference| docs.iter().any(|doc| doc.id == reference.id))
                        .map(|reference| reference.id.clone()),
                );
                active.entry(id.clone()).or_default().insert(doc.id.clone());
            }
            save_topics(&root, &existing)?;
            write_json(&catalog_path(&root), &catalog)?;
        }
    }
    let initial = {
        let _guard = state.serial.lock().await;
        require_current(state, session)?;
        let mut values = topics(&root)?;
        reconcile_sources(&mut values, &active, &failed_sources, &docs);
        save_topics(&root, &values)?;
        values
    };
    let active_topics: Vec<_> = initial
        .into_iter()
        .filter(|topic| {
            topic.collection.is_none() && !topic.excluded
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
    let pending: Vec<_> = active_topics
        .into_iter()
        .filter_map(|topic| {
            // A failed source is unavailable input, not evidence that old content disappeared.
            if topic.source_ids.iter().any(|id| failed_sources.contains(id)) { return None; }
            let selected: Vec<_> = docs
                .iter()
                .filter(|doc| topic.source_ids.contains(&doc.id))
                .cloned()
                .collect();
            let version = page_version(&topic, &selected, &manifest, &config);
            if !topic.force_refresh && topic.last_fingerprint == version {
                completed += 1;
                None
            } else if !topic.force_refresh && topic.last_attempt_fingerprint == version {
                None
            } else {
                Some((topic, selected, version))
            }
        })
        .collect();
    for (topic, selected, version) in pending {
        report_progress(
            app,
            state,
            session,
            WikiProgress {
                stage: "compiling".into(),
                completed,
                total: total_topics,
                topic_title: topic.title.clone(),
                ..Default::default()
            },
        )
        .await?;
        let result = compile_automatic(
            app, state, session, &topic, &selected, &manifest, &root, &version,
        )
        .await;
        if let Err(error) = &result {
            if is_service_failure(&error.message) {
                return Err(error.message.clone());
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
        if page_version(current, &latest_docs, &latest, &models(app, session)?) != version {
            continue;
        }
        match result {
            Ok(mut page) => {
                page.fingerprint = page_fingerprint(current, &latest, &config, &page.citations);
                if !valid_page(&local, &latest, &page) {
                    current.error = "Sources changed; automatic page discarded".into();
                    current.failure = Some(WikiFailure::new(&current.error, "validating", current.source_ids.clone()));
                } else {
                    publish_automatic(&root, current, page, &version)?;
                    current.error.clear();
                    current.failure = None;
                    current.last_fingerprint = version.clone();
                    completed += 1;
                }
            }
            Err(failure) => {
                current.error = failure.message.clone();
                current.failure = Some(failure);
            }
        }
        current.last_attempt_fingerprint = version;
        current.force_refresh = false;
        save_topics(&root, &values)?;
        persist(app, session, &latest)?;
    }
    collections::run(app, state, session).await?;
    let embedding_failures = embed_sources(app, state, session, &config, &root, &local).await?;
    let _guard = state.serial.lock().await;
    require_current(state, session)?;
    let mut latest = load_state(app, session)?;
    let values = topics(&root)?;
    let active: Vec<_> = values
        .into_iter()
        .filter(|topic| topic.automatic_key.is_empty() || !topic.source_ids.is_empty())
        .collect();
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
                && items
                    .iter()
                    .any(|item| item["id"] == topic.id && item["inScope"] != false && item["published"].is_object())
        })
        .collect();
    let nodes: Vec<_> = visible.iter().map(|topic| json!({"id":format!("wiki:{}",topic.id),"wikiId":topic.id,"kind":"wiki",
        "subtype":topic.topic_kind,"title":topic.title,"description":topic.published.as_ref().map(|page| &page.overview),"status":"published","citations":[],"updates":[]})).collect();
    let mut edges = Vec::new();
    for (index, a) in visible.iter().enumerate() {
        for b in visible.iter().skip(index + 1) {
            let source_ids = |topic: &Topic| -> BTreeSet<String> {
                topic
                    .source_ids
                    .iter()
                    .cloned()
                    .chain(topic.published.iter().flat_map(|page| {
                        page.citations.iter().map(|reference| reference.id.clone())
                    }))
                    .collect()
            };
            let sources: Vec<_> = source_ids(a)
                .intersection(&source_ids(b))
                .cloned()
                .collect();
            if !sources.is_empty() {
                edges.push(json!({"id":format!("shared:{}:{}",a.id,b.id),"source":format!("wiki:{}",a.id),"target":format!("wiki:{}",b.id),"kind":"shared_source","sourceIds":sources}));
            }
        }
    }
    for topic in &visible {
        if let Some(collection) = &topic.collection {
            for link in &collection.links {
                if link.state == "included" && visible.iter().any(|member| member.id == link.target_id) {
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
