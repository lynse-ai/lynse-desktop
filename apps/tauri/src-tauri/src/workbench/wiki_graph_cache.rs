//! Content-addressed results and persistent, source-specific chunk boundaries.
use super::*;

pub(super) const PROFILE: &str = "deepseek-graph-v2";
const MASK_VERSION: u32 = 1;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub(super) struct Segment {
    pub identity: String,
    pub text: String,
}

#[derive(Clone)]
pub(super) struct Work {
    pub key: String,
    pub identity: String,
    pub part: Document,
    pub content_revision: String,
}

pub(super) fn content_cache() -> bool {
    std::env::var("LYNSE_GRAPH_CONTENT_CACHE").as_deref() != Ok("0")
}

fn key(doc: &Document, text: &str, tracking: &Tracking) -> String {
    store::digest(
        json!([
            PROFILE,
            schema::VERSION,
            MASK_VERSION,
            tracking.scope,
            doc.id,
            doc.kind,
            schema::mask(&doc.title),
            schema::mask(text),
            tracking.language,
            "deepseek-flash",
            "https://api.deepseek.com",
            compact_output(),
            (!content_cache()).then(|| schema::content_revision(doc))
        ])
        .to_string(),
    )
}

fn legacy_key(doc: &Document, index: usize, text: &str) -> String {
    store::digest(
        json!([
            schema::VERSION,
            doc.id,
            schema::content_revision(doc),
            index,
            store::digest(text)
        ])
        .to_string(),
    )
}

fn append_gap(result: &mut Vec<Segment>, doc: &Document, gap: &str) {
    for text in sync::split_text(gap, 12_000) {
        if text.is_empty() {
            continue;
        }
        result.push(Segment {
            identity: store::digest(json!(["graph-identity-v2", doc.id, text]).to_string()),
            text,
        });
    }
}

fn segments(doc: &Document, tracking: &Tracking) -> Vec<Segment> {
    let text = schema::evidence_text(doc);
    if content_cache() {
        if let Some(previous) = tracking.layouts.get(&doc.id) {
            // Keep unchanged old chunks as anchors, including after insertions before them.
            let mut result = Vec::new();
            let mut cursor = 0;
            for old in previous {
                if old.text.is_empty() {
                    continue;
                }
                if let Some(offset) = text[cursor..].find(&old.text) {
                    let at = cursor + offset;
                    append_gap(&mut result, doc, &text[cursor..at]);
                    result.push(old.clone());
                    cursor = at + old.text.len();
                }
            }
            append_gap(&mut result, doc, &text[cursor..]);
            return result;
        }
    }
    let pieces = sync::split_text(&text, 12_000);
    let single_legacy = if pieces.len() == 1 {
        let matches: Vec<_> = tracking
            .chunks
            .iter()
            .filter(|(_, chunk)| {
                chunk.profile.is_empty()
                    && chunk.source_id == doc.id
                    && chunk.content_revision == schema::content_revision(doc)
            })
            .collect();
        (matches.len() == 1).then(|| matches[0].0.clone())
    } else {
        None
    };
    pieces
        .into_iter()
        .enumerate()
        .map(|(index, text)| {
            let old_key = legacy_key(doc, index, &text);
            let identity = if let Some(identity) = &single_legacy {
                identity.clone()
            } else if tracking.chunks.contains_key(&old_key) {
                old_key
            } else {
                store::digest(json!(["graph-identity-v2", doc.id, text]).to_string())
            };
            Segment { identity, text }
        })
        .collect()
}

fn rebind(chunk: &Chunk, part: &Document) -> CommandResult<Extraction> {
    let mut value = serde_json::to_value(&chunk.extraction).map_err(|e| e.to_string())?;
    for rows in ["nodes", "relations"] {
        for row in value[rows].as_array_mut().into_iter().flatten() {
            for reference in row["citations"].as_array_mut().into_iter().flatten() {
                reference["id"] = json!(part.id);
                reference["revision"] = json!(part.revision);
                reference["kind"] = json!(part.kind);
                reference["quote"] = json!(schema::mask(
                    reference["quote"].as_str().unwrap_or_default()
                ));
            }
        }
    }
    schema::validate(value, part)
}

/// Includes completed and failed work. The caller claims only missing keys.
pub(super) fn plan(docs: &[Document], tracking: &mut Tracking) -> Vec<Work> {
    let mut work = Vec::new();
    for doc in docs.iter().filter(|doc| {
        tracking.selected_sources.contains(&doc.id) && doc.kind == schema::SUMMARY_KIND
    }) {
        let layout = segments(doc, tracking);
        for segment in &layout {
            if segment.text.trim().is_empty() {
                continue;
            }
            let mut part = doc.clone();
            part.transcript = segment.text.clone();
            part.outline.clear();
            part.conclusions.clear();
            part.todos.clear();
            let mut cache_key = key(doc, &segment.text, tracking);
            // Unknown-provenance legacy output stays visible until an explicit refresh.
            if !tracking.refresh_legacy
                && tracking.chunks.get(&segment.identity).is_some_and(|chunk| {
                    chunk.profile.is_empty()
                        && chunk.content_revision == schema::content_revision(doc)
                })
            {
                cache_key = segment.identity.clone();
            }
            if let Some(chunk) = tracking.chunks.get_mut(&cache_key) {
                if chunk.error.is_empty() {
                    if let Ok(extraction) = rebind(chunk, &part) {
                        chunk.extraction = extraction;
                        chunk.content_revision = schema::content_revision(doc);
                    } else {
                        // A corrupt/ambiguous cached result must never bypass evidence validation.
                        tracking.chunks.remove(&cache_key);
                    }
                }
            }
            if !work.iter().any(|item: &Work| item.key == cache_key) {
                work.push(Work {
                    key: cache_key,
                    identity: segment.identity.clone(),
                    part,
                    content_revision: schema::content_revision(doc),
                });
            }
        }
        tracking.layouts.insert(doc.id.clone(), layout);
    }
    work
}

pub(super) fn pending(docs: &[Document], tracking: &Tracking) -> Vec<Work> {
    let mut tracking = tracking.clone();
    plan(docs, &mut tracking)
        .into_iter()
        .filter(|work| !tracking.chunks.contains_key(&work.key))
        .collect()
}

pub(super) fn identity<'a>(key: &'a str, chunk: &'a Chunk) -> &'a str {
    if chunk.identity.is_empty() {
        key
    } else {
        &chunk.identity
    }
}
