//! Strict graph contract and privacy copies of existing meeting summaries.
use super::*;

pub const VERSION: u32 = 1;
pub const SUMMARY_KIND: &str = "meeting_summary";
pub const ENTITIES: &[&str] = &[
    "person",
    "organization",
    "department",
    "location",
    "product",
    "project",
    "document",
    "term",
    "system",
    "customer",
    "supplier",
];
pub const EVENTS: &[&str] = &[
    "meeting",
    "task",
    "commitment",
    "decision",
    "issue",
    "risk",
    "change",
    "milestone",
    "opinion",
    "need",
];
pub const PREDICATES: &[&str] = &[
    "responsible_for",
    "participates_in",
    "belongs_to",
    "approves",
    "reports_to",
    "delivers_to",
    "owner",
    "project",
    "recipient",
    "object",
    "about",
    "supports",
    "opposes",
    "concerned_about",
    "needs",
    "topic",
];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtractNode {
    pub key: String,
    pub kind: String,
    pub title: String,
    pub description: String,
    pub status: String,
    pub modality: String,
    pub confidence: f64,
    #[serde(default)]
    pub time_text: String,
    #[serde(default)]
    pub due_text: String,
    pub citations: Vec<SourceRef>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtractRelation {
    pub subject: String,
    pub target: String,
    pub predicate: String,
    pub modality: String,
    pub confidence: f64,
    pub citations: Vec<SourceRef>,
}
#[derive(Clone, Default, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Extraction {
    pub schema_version: u32,
    pub nodes: Vec<ExtractNode>,
    pub relations: Vec<ExtractRelation>,
}

pub fn mask(text: &str) -> String {
    static PATTERNS: std::sync::OnceLock<Vec<regex::Regex>> = std::sync::OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        [
            r"(?i)[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+",
            r"(?:\+?86[- ]?)?1[3-9][0-9]{9}",
            r"[0-9]{17}[0-9Xx]",
            r"[0-9]{13,19}",
            r"\b(?:sk|pk|ghp|github_pat)[-_][A-Za-z0-9_-]{12,}\b",
        ]
        .iter()
        .map(|pattern| regex::Regex::new(pattern).expect("static privacy pattern"))
        .collect()
    });
    let mut result = text.to_owned();
    for pattern in patterns {
        result = pattern
            .replace_all(&result, |capture: &regex::Captures<'_>| {
                "*".repeat(capture[0].chars().count())
            })
            .into_owned();
    }
    result
}

pub fn summary_source(doc: &Document, manifest: &Manifest) -> Option<Document> {
    if doc.kind != "meeting" || !doc.ai_context_enabled {
        return None;
    }
    let mut summaries = Vec::new();
    let local = manifest
        .artifacts
        .get(&doc.id)
        .into_iter()
        .flat_map(|artifact| artifact["summaries"].as_array().into_iter().flatten())
        .filter(|summary| summary["sourceRevision"] == doc.revision)
        .filter_map(|summary| summary["markdown"].as_str());
    for text in doc
        .conclusions
        .iter()
        .filter_map(|summary| summary["conclusionText"].as_str())
        .chain(local)
    {
        if text.trim().is_empty() || summaries.iter().any(|summary| summary == text) {
            continue;
        }
        // Reuse Markdown filtering independently for each summary; never fall back to a transcript.
        if let Some(summary) = super::super::super::markdown::source(Document {
            transcript: text.into(),
            ai_context_enabled: true,
            ..Default::default()
        }) {
            summaries.push(summary.transcript);
        }
    }
    (!summaries.is_empty()).then(|| Document {
        id: doc.id.clone(),
        kind: SUMMARY_KIND.into(),
        title: doc.title.clone(),
        revision: doc.revision.clone(),
        transcript: summaries.join("\n\n"),
        ai_context_enabled: true,
        ..Default::default()
    })
}
pub fn content_revision(doc: &Document) -> String {
    store::digest(json!(["meeting-summary-graph-v1", doc.transcript]).to_string())
}
pub fn evidence_text(doc: &Document) -> String {
    if doc.kind == SUMMARY_KIND {
        doc.transcript.clone()
    } else {
        String::new()
    }
}
pub fn transport(doc: &Document) -> CommandResult<Document> {
    if doc.kind != SUMMARY_KIND || doc.transcript.trim().is_empty() {
        return Err("Graph extraction requires an existing meeting summary".into());
    }
    Ok(Document {
        id: doc.id.clone(),
        kind: SUMMARY_KIND.into(),
        revision: doc.revision.clone(),
        title: mask(&doc.title),
        transcript: mask(&doc.transcript),
        ai_context_enabled: true,
        ..Default::default()
    })
}

pub fn validate(value: Value, part: &Document) -> CommandResult<Extraction> {
    let invalid = "Invalid evidence graph output";
    if part.kind != SUMMARY_KIND {
        return Err(invalid.into());
    }
    let mut result: Extraction = serde_json::from_value(value).map_err(|_| invalid)?;
    if result.schema_version != VERSION || result.nodes.len() > 40 || result.relations.len() > 60 {
        return Err(invalid.into());
    }
    let original: Vec<_> = part.transcript.chars().collect();
    let masked = mask(&part.transcript);
    let restore =
        |refs: &mut Vec<SourceRef>, confidence: f64, modality: &str| -> CommandResult<()> {
            if refs.is_empty()
                || refs.len() > 4
                || !confidence.is_finite()
                || !(0.0..=1.0).contains(&confidence)
                || !["asserted", "planned", "proposed", "negated", "uncertain"].contains(&modality)
            {
                return Err(invalid.into());
            }
            for reference in refs {
                if reference.id != part.id
                    || reference.revision != part.revision
                    || reference.kind != part.kind
                    || reference.quote.trim().is_empty()
                    || reference.quote.chars().count() > 500
                    || reference.segment_id.is_some()
                    || reference.start_ms.is_some()
                    || reference.end_ms.is_some()
                {
                    return Err(invalid.into());
                }
                let locations: Vec<_> = masked.match_indices(&reference.quote).collect();
                if locations.is_empty() {
                    return Err("Graph citation does not match source evidence".into());
                }
                let quotes: BTreeSet<String> = locations
                    .iter()
                    .map(|(offset, _)| {
                        let start = masked[..*offset].chars().count();
                        original[start..start + reference.quote.chars().count()]
                            .iter()
                            .collect()
                    })
                    .collect();
                // A masked quote matching different private values has no unambiguous inverse mapping.
                if quotes.len() != 1 {
                    return Err("Graph citation is ambiguous after privacy masking".into());
                }
                reference.quote = quotes.into_iter().next().unwrap_or_default();
            }
            Ok(())
        };
    let mut keys = BTreeMap::new();
    for node in &mut result.nodes {
        let named = ENTITIES.contains(&node.kind.as_str()) || node.kind == "topic";
        if (!named && !EVENTS.contains(&node.kind.as_str()))
            || node.key.is_empty()
            || node.key.len() > 80
            || keys.insert(node.key.clone(), node.kind.clone()).is_some()
            || !(1..=160).contains(&node.title.trim().chars().count())
            || node.description.trim().is_empty()
            || node.description.chars().count() > 1000
            || ![
                "unknown",
                "proposed",
                "active",
                "blocked",
                "completed",
                "cancelled",
                "unresolved",
            ]
            .contains(&node.status.as_str())
        {
            return Err(invalid.into());
        }
        // Validate against what the model actually saw before restoring local private text.
        if named
            && !node
                .citations
                .iter()
                .any(|reference| reference.quote.contains(&node.title))
        {
            return Err(invalid.into());
        }
        for time in [&node.time_text, &node.due_text] {
            if time.chars().count() > 160
                || (!time.is_empty()
                    && !node
                        .citations
                        .iter()
                        .any(|reference| reference.quote.contains(time)))
            {
                return Err(invalid.into());
            }
        }
        restore(&mut node.citations, node.confidence, &node.modality)?;
    }
    for relation in &mut result.relations {
        if !keys.contains_key(&relation.subject)
            || !keys.contains_key(&relation.target)
            || relation.subject == relation.target
            || !PREDICATES.contains(&relation.predicate.as_str())
        {
            return Err(invalid.into());
        }
        let subject = keys[&relation.subject].as_str();
        let target = keys[&relation.target].as_str();
        if (["owner", "project", "recipient", "object"].contains(&relation.predicate.as_str())
            && !EVENTS.contains(&subject))
            || (relation.predicate == "project" && target != "project")
            || (relation.predicate == "topic" && target != "topic")
            || (relation.predicate == "responsible_for"
                && !["person", "organization", "department"].contains(&subject))
        {
            return Err(invalid.into());
        }
        restore(
            &mut relation.citations,
            relation.confidence,
            &relation.modality,
        )?;
    }
    Ok(result)
}

pub fn locate(reference: &SourceRef, doc: &Document) -> Value {
    let mut value = json!(reference);
    value["revision"] = json!(doc.revision);
    if doc.kind == SUMMARY_KIND {
        value["kind"] = json!(SUMMARY_KIND);
        value["positions"] = json!([]);
        for key in ["segmentId", "startMs", "endMs"] {
            value.as_object_mut().unwrap().remove(key);
        }
        return value;
    }
    let positions: Vec<_> = doc.segments.iter().filter_map(|segment| {
        let text = segment["text"].as_str().or_else(|| segment["recognizedText"].as_str())?;
        if !text.contains(&reference.quote) { return None; }
        Some(json!({"segmentId":segment["id"],"startMs":segment["startMs"],"endMs":segment["endMs"],"speaker":segment["speakerName"].as_str().or_else(|| segment["speaker"].as_str()).unwrap_or("")}))
    }).collect();
    value["positions"] = json!(positions);
    if positions.len() == 1 {
        for key in ["segmentId", "startMs", "endMs"] {
            if !positions[0][key].is_null() {
                value[key] = positions[0][key].clone();
            }
        }
        value["speaker"] = positions[0]["speaker"].clone();
    }
    value
}
