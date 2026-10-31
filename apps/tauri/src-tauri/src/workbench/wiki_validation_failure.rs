//! Bounded validation diagnostics without model quotes or source content.
use super::*;

const MARKER: &str = "\n[lynse-validation] ";
const CODES: &[&str] = &[
    "missing_citations", "invalid_reference", "source_missing", "source_revision_mismatch",
    "quote_missing", "quote_not_found", "quote_too_long", "audio_position_mismatch",
];
const CATALOG_CODES: &[&str] = &[
    "result_format", "topic_format", "too_many_topics", "invalid_field", "invalid_kind",
    "duplicate_key", "missing_new_source", "invalid_existing_id", "existing_kind_mismatch",
    "missing_existing_source", "invalid_citation", "invalid_context",
];

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CatalogIssue {
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topic_index: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CitationIssue {
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub citation_index: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ValidationDetails {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub citation_issue: Option<CitationIssue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub catalog_issue: Option<CatalogIssue>,
    pub correction_attempted: bool,
}

fn safe_location(location: &str) -> bool {
    if location == "citations" { return true; }
    [("memoryItems[",50), ("todoSuggestions[",50), ("decisions[",50), ("topics[",40)].iter().any(|(prefix, limit)| {
        location.strip_prefix(*prefix).and_then(|s| s.strip_suffix("].citations"))
            .and_then(|s| s.parse::<usize>().ok()).is_some_and(|index| index < *limit)
    })
}

fn issue(raw: &Value, sources: &Value) -> Option<CitationIssue> {
    let code = raw["code"].as_str().filter(|code| CODES.contains(code))?;
    let source_id = raw["sourceId"].as_str().filter(|id| sources.as_array().is_some_and(|rows|
        rows.iter().any(|source| source["id"].as_str() == Some(*id)))).map(str::to_owned);
    Some(CitationIssue {
        code: code.into(), source_id,
        citation_index: raw["citationIndex"].as_u64().filter(|index| *index < 40),
        location: raw["location"].as_str().filter(|value| safe_location(value)).map(str::to_owned),
    })
}

pub(super) fn annotate(message: String, response: &Value, request: &Value, correction_attempted: bool) -> String {
    let citation_issue = issue(&response["citationIssue"], &request["sources"]);
    let raw = &response["catalogIssue"];
    let catalog_issue = (request["task"] == "wiki_catalog").then(|| {
        let code = raw["code"].as_str().filter(|code| CATALOG_CODES.contains(code))?;
        Some(CatalogIssue { code: code.into(),
            topic_index: raw["topicIndex"].as_u64().filter(|index| *index < 40),
            field: raw["field"].as_str().filter(|field| ["topics", "key", "title", "overview", "kind", "citations", "existingId"].contains(field)).map(str::to_owned),
        })
    }).flatten();
    let citation_error = ["Citation does not match", "Invalid citation", "Every claim needs source citations", "unsupported audio position"]
        .iter().any(|reason| message.contains(reason));
    if !citation_error && citation_issue.is_none() && catalog_issue.is_none() && !message.contains("Invalid Wiki catalog output") { return message; }
    // CommandResult uses String across the cache layer. Carry only safe metadata
    // until WikiFailure separates it into persistent, typed fields.
    let details = ValidationDetails { citation_issue, catalog_issue,
        correction_attempted: correction_attempted || response["correctionAttempted"] == true };
    format!("{message}{MARKER}{}", serde_json::to_string(&details).expect("validation metadata is serializable"))
}

pub(super) fn split(message: String) -> (String, Option<ValidationDetails>) {
    if let Some((text, raw)) = message.rsplit_once(MARKER) {
        if raw.len() <= 1024 {
            if let Ok(details) = serde_json::from_str(raw) { return (text.to_owned(), Some(details)); }
        }
    }
    (message, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostics_keep_locations_but_never_provider_quotes_or_unknown_sources() {
        let message = annotate("Citation does not match source evidence".into(), &json!({
            "citationIssue":{"code":"quote_not_found","sourceId":"not-requested", "citationIndex":1,
                "location":"memoryItems[2].citations","quote":"PRIVATE_MODEL_QUOTE"}}),
            &json!({"sources":[{"id":"meeting"}]}), true);
        assert!(!message.contains("PRIVATE_MODEL_QUOTE"));
        assert!(!message.contains("not-requested"));
        let (message, details) = split(message);
        assert_eq!(message, "Citation does not match source evidence");
        let details = details.unwrap();
        assert!(details.correction_attempted);
        assert_eq!(details.citation_issue.unwrap().citation_index, Some(1));
        assert_eq!(split("Legacy citation failure".into()).1.is_none(), true);
    }

    #[test]
    fn catalog_diagnostics_drop_values_and_out_of_bounds_locations() {
        let message=annotate("Invalid Wiki catalog output".into(), &json!({
            "catalogIssue":{"code":"invalid_kind","topicIndex":99,"field":"PRIVATE_MODEL_FIELD","title":"PRIVATE_MODEL_TITLE"},
            "correctionAttempted":true}), &json!({"task":"wiki_catalog"}), false);
        assert!(!message.contains("PRIVATE_"));
        let details=split(message).1.unwrap();
        assert!(details.correction_attempted);
        let issue=details.catalog_issue.unwrap();
        assert!(issue.topic_index.is_none());
        assert!(issue.field.is_none());
        assert_eq!(issue.code,"invalid_kind");
        let unknown=annotate("Invalid Wiki catalog output".into(), &json!({"catalogIssue":{"code":"PRIVATE_CODE"}}),
            &json!({"task":"wiki_catalog"}), false);
        assert!(split(unknown).1.unwrap().catalog_issue.is_none());
    }
}
