//! Direct-synthesis tests: validator parity with the retired gateway
//! processor, and pipeline behavior against a local mock provider.
use super::*;
use serde_json::json;

fn source(id: &str, text: &str) -> Value {
    json!({"id": id, "revision": "r1", "kind": "meeting", "title": id, "text": text, "segments": []})
}

fn sources() -> Vec<Value> {
    vec![
        source("new", "Alpha project started today. Budget was approved！Beta is delayed。"),
        source("old", "Alpha kicked off last week. Scope was agreed。"),
    ]
}

fn catalog_query() -> String {
    json!({"existingTopics": [
        {"id": "t-old", "kind": "project", "title": "Alpha", "sourceIds": ["old"]}
    ], "newSourceId": "new"})
    .to_string()
}

fn completion(content: &str) -> String {
    json!({"choices": [{"finish_reason": "stop", "message": {"content": content}}]}).to_string()
}

// --- unit: passages and quote relocation ------------------------------------

#[test]
fn passages_split_at_sentence_boundaries_within_the_window() {
    let sentence = "。".to_owned() + &"甲".repeat(240);
    let text = format!("{sentence}{sentence}");
    let parts = passages(&text);
    assert_eq!(parts.len(), 2);
    let plain: String = "x".repeat(1000);
    let parts = passages(&plain);
    assert_eq!(parts.len(), 3);
    assert!(parts.iter().all(|part| part.chars().count() <= 400));
}

#[test]
fn quotes_relocate_across_punctuation_and_whitespace() {
    let text = "预算已通过，含评审费用；工期顺延。";
    // ASR-style comma where the model produced an enumeration mark. The
    // relocated span ends at the last significant character, matching the
    // gateway's algorithm (trailing punctuation is not included).
    let quote = "预算已通过、含评审费用；工期顺延。";
    let relocated = locate_verbatim_quote(quote, text).unwrap();
    assert_eq!(relocated, "预算已通过，含评审费用；工期顺延");
    assert_eq!(locate_verbatim_quote("完全不存在", text), None);
}

#[test]
fn fenced_model_output_parses() {
    let value = model_output("```json\n{\"a\":1}\n```").unwrap();
    assert_eq!(value["a"], json!(1));
    assert!(model_output("not json").is_err());
}

// --- unit: validate_result ---------------------------------------------------

#[test]
fn result_validation_rejects_insufficient_claims_and_bad_kinds() {
    let src = sources();
    let failure = validate_result(
        &json!({"summary": "text", "insufficientEvidence": true}),
        &src,
    )
    .unwrap_err();
    assert_eq!(
        failure.message,
        "Insufficient evidence must not contain factual output"
    );
    let failure =
        validate_result(&json!({"summary": "", "insufficientEvidence": true}), &src).unwrap();
    assert_eq!(failure["insufficientEvidence"], json!(true));
    let failure = validate_result(
        &json!({"summary": "s", "citations": [
            {"id": "new", "revision": "r1", "quote": "Alpha project started today"}
        ], "memoryItems": [{"text": "t", "kind": "decided", "citations": [
            {"id": "new", "revision": "r1", "quote": "Budget was approved"}]}]}),
        &src,
    )
    .unwrap_err();
    assert_eq!(failure.message, "Invalid memory kind");
}

#[test]
fn result_citations_restore_verbatim_quotes_and_audio() {
    let mut src = sources();
    src[0]["segments"] = json!([{"id": "s1", "text": "Budget was approved！", "startMs": 1000, "endMs": 2000}]);
    let result = validate_result(
        &json!({"summary": "预算通过", "citations": [
            {"id": "new", "revision": "r1", "quote": "Budget was approved、", "segmentId": "s1", "startMs": 1000, "endMs": 2000}
        ]}),
        &src,
    )
    .unwrap();
    let reference = &result["citations"][0];
    assert_eq!(reference["quote"], json!("Budget was approved"));
    assert_eq!(reference["segmentId"], json!("s1"));
    let failure = validate_result(
        &json!({"summary": "预算通过", "citations": [
            {"id": "new", "revision": "other", "quote": "Budget was approved"}
        ]}),
        &src,
    )
    .unwrap_err();
    assert_eq!(
        failure.citation_issue.unwrap()["code"],
        json!("source_revision_mismatch")
    );
}

// --- unit: catalog -----------------------------------------------------------

#[test]
fn catalog_validation_enforces_new_source_and_identity_keys() {
    let src = sources();
    let query = catalog_query();
    let bank = CitationBank::new(&src, &[], Some("new"));
    assert_eq!(bank.references.len(), 2); // one passage per short source
    let raw = json!({"topics": [
        {"key": "Alpha", "existingId": "t-old", "kind": "project", "title": "Alpha", "overview": "One.", "citations": [0, 1]},
        {"key": "alpha", "existingId": null, "kind": "project", "title": "Dup", "overview": "One.", "citations": [0]}
    ]});
    let expanded = bank.expand(&raw).unwrap();
    let failure = validate_catalog(&expanded, &src, &query).unwrap_err();
    assert_eq!(failure.catalog_issue.unwrap()["code"], json!("duplicate_key"));
    let raw = json!({"topics": [
        {"key": "Alpha", "existingId": "t-old", "kind": "project", "title": "Alpha", "overview": "One.", "citations": [0]}
    ]});
    let failure = validate_catalog(&bank.expand(&raw).unwrap(), &src, &query).unwrap_err();
    assert_eq!(failure.catalog_issue.unwrap()["code"], json!("missing_existing_source"));
    let raw = json!({"topics": [
        {"key": "Alpha", "existingId": "t-old", "kind": "project", "title": "Alpha", "overview": "One.", "citations": [2]}
    ]});
    // Out-of-range passage numbers fail expansion itself.
    let failure = bank.expand(&raw).unwrap_err();
    assert_eq!(failure.catalog_issue.unwrap()["code"], json!("invalid_citation"));
    let raw = json!({"topics": [
        {"key": "Alpha", "existingId": "t-old", "kind": "project", "title": "Alpha", "overview": "One.", "citations": [1, 0]},
        {"key": "Beta", "existingId": null, "kind": "topic", "title": "Beta", "overview": "One.", "citations": [0]}
    ]});
    let value = validate_catalog(&bank.expand(&raw).unwrap(), &src, &query).unwrap();
    // Expanded references keep the model's own order.
    assert_eq!(value["topics"][0]["citations"][0]["id"], json!("old"));
    assert_eq!(value["topics"][0]["citations"][1]["id"], json!("new"));
}

#[test]
fn catalog_salvage_drops_only_evidence_less_rows() {
    let src = sources();
    let query = catalog_query();
    let bank = CitationBank::new(&src, &[], Some("new"));
    // Row 1 lacks the old-source passage; row 2 is fully valid. Salvage runs
    // on expanded output, exactly like the pipeline's last resort.
    let raw = json!({"topics": [
        {"key": "Alpha", "existingId": "t-old", "kind": "project", "title": "Alpha", "overview": "One.", "citations": [0]},
        {"key": "Beta", "existingId": null, "kind": "topic", "title": "Beta", "overview": "One.", "citations": [0]}
    ]});
    let expanded = bank.expand(&raw).unwrap();
    let salvaged = salvage_catalog(&expanded, &src, &query).unwrap();
    assert_eq!(salvaged["topics"].as_array().unwrap().len(), 1);
    assert_eq!(salvaged["topics"][0]["key"], json!("Beta"));
    // All rows valid: nothing wrong here, keep the original failure.
    let raw = json!({"topics": [
        {"key": "Beta", "existingId": null, "kind": "topic", "title": "Beta", "overview": "One.", "citations": [0]}
    ]});
    let expanded = bank.expand(&raw).unwrap();
    assert!(salvage_catalog(&expanded, &src, &query).is_none());
    // Structural defect: no salvage at all.
    let raw = json!({"topics": [{"key": "", "kind": "topic", "title": "x", "overview": "y", "citations": [0]}]});
    assert!(salvage_catalog(&raw, &src, &query).is_none());
}

// --- unit: match and grouping ------------------------------------------------

#[test]
fn match_dates_need_exact_dated_quotes() {
    let src = vec![source(
        "new",
        "Alpha project started today。2026年1月5日启动。",
    )];
    let reference = json!({"id": "new", "revision": "r1", "quote": "Alpha project started today"});
    let raw = json!({"relation": "related", "reason": "same work", "citations": [reference],
        "events": [{"text": "started", "date": "2026-01-05", "dateQuote": "2026年1月5日会议", "citations": [
            {"id": "new", "revision": "r1", "quote": "2026年1月5日启动"}]}]});
    // dateQuote must live inside a cited quote.
    let failure = validate_match(&raw, &src).unwrap_err();
    assert_eq!(failure.message, "Event date needs an exact dated source quote");
    let ok = json!({"relation": "related", "reason": "same work", "citations": [reference],
        "events": [{"text": "started", "date": "2026-01-05", "dateQuote": "2026年1月5日启动", "citations": [
            {"id": "new", "revision": "r1", "quote": "2026年1月5日启动"}]}]});
    let value = validate_match(&ok, &src).unwrap();
    assert_eq!(value["events"][0]["date"], json!("2026-01-05"));
    assert!(date_supported("2026-01-05", "2026年01月05日"));
    assert!(!date_supported("2026-1-5", "2026-1-5"));
    assert!(!date_supported("2026-13-05", "2026-13-05"));
    let unrelated = json!({"relation": "unrelated", "reason": "no", "citations": [], "events": []});
    assert_eq!(validate_match(&unrelated, &src).unwrap()["relation"], json!("unrelated"));
}

#[test]
fn grouping_coalesces_conflicts_and_keeps_singletons_visible() {
    let src = sources();
    let topics = json!([
        {"id": "t0", "title": "Alpha", "overview": "o", "sourceIds": ["new"]},
        {"id": "t1", "title": "Beta", "overview": "o", "sourceIds": ["new"]},
        {"id": "t2", "title": "Gamma", "overview": "o", "sourceIds": ["old"]}
    ]);
    let groups = json!([{"id": "g0", "title": "Existing"}]);
    let query = json!({"topics": topics, "groups": groups}).to_string();
    // A lone new parent drops to unassigned; an unknown parent row is skipped.
    let raw = json!({"groups": [
        {"title": "Lone", "existingId": null, "topicIds": ["t0"]},
        {"title": "Mystery", "existingId": "g9", "topicIds": ["t1"]},
        {"title": "Pair", "existingId": "g0", "topicIds": ["t1", "t2"]}
    ], "unassigned": []});
    let value = validate_groups(&raw, &query, &src).unwrap();
    assert_eq!(value["groups"].as_array().unwrap().len(), 1);
    assert_eq!(value["groups"][0]["title"], json!("Existing"));
    let unassigned = value["unassigned"].as_array().unwrap();
    // Only the lone new parent's single member falls out.
    assert_eq!(unassigned.len(), 1);
    // Conflicting parents for the same member leave the member unassigned.
    let raw = json!({"groups": [
        {"title": "A", "existingId": "g0", "topicIds": ["t0", "t1"]},
        {"title": "B", "existingId": null, "topicIds": ["t0", "t1", "t2"]}
    ], "unassigned": []});
    let value = validate_groups(&raw, &query, &src).unwrap();
    assert!(value["groups"].as_array().unwrap().is_empty());
    assert_eq!(value["unassigned"].as_array().unwrap().len(), 3);
}

// --- pipeline against a mock provider ----------------------------------------

type Captured = Vec<(String, Value)>;

fn provider_server(
    responses: Vec<(u16, String, Option<String>)>,
) -> (String, std::thread::JoinHandle<Captured>) {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let worker = std::thread::spawn(move || {
        let mut captured = Vec::new();
        for (status, body, retry_after) in responses {
            let (mut socket, _) = listener.accept().unwrap();
            socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0; 4096];
            let (headers, request_body) = loop {
                let n = socket.read(&mut buffer).unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&buffer[..n]);
                if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                    let header_text = String::from_utf8_lossy(&bytes[..end]).to_string();
                    let length: usize = header_text
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length:"))
                        .unwrap_or("0")
                        .trim()
                        .parse()
                        .unwrap_or(0);
                    if bytes.len() >= end + 4 + length {
                        break (
                            header_text.to_ascii_lowercase(),
                            bytes[end + 4..end + 4 + length].to_vec(),
                        );
                    }
                }
            };
            let authorization = headers
                .lines()
                .find_map(|line| line.strip_prefix("authorization:"))
                .unwrap_or("")
                .trim()
                .to_owned();
            captured.push((
                authorization,
                serde_json::from_slice(&request_body).unwrap(),
            ));
            let mut head = format!(
                "HTTP/1.1 {status} Response\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
                body.len()
            );
            if let Some(retry_after) = retry_after {
                head.push_str(&format!("Retry-After: {retry_after}\r\n"));
            }
            write!(socket, "{head}\r\n{body}").unwrap();
        }
        captured
    });
    (endpoint, worker)
}

fn direct_model(endpoint: &str, key: Option<&str>) -> DirectModel {
    DirectModel {
        base_url: endpoint.to_owned(),
        model: "synthetic-model".into(),
        key: key.map(str::to_owned),
    }
}

async fn run(
    direct: &DirectModel,
    task: &str,
    query: &str,
    sources: Value,
    evidence: Value,
    report: &mut SynthesisControl,
) -> CommandResult<Value> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let request = PipelineRequest {
        task,
        language: "zh-Hans",
        query,
        sources: &sources,
        evidence: &evidence,
    };
    run_pipeline(&client, direct, request, report).await
}

#[tokio::test]
async fn catalog_passages_reach_the_provider_and_citations_expand() {
    let (endpoint, server) = provider_server(vec![(
        200,
        completion(r#"{"topics":[{"key":"Alpha","existingId":null,"kind":"project","title":"Alpha","overview":"One supported sentence.","citations":[0]}]}"#),
        None,
    )]);
    let direct = direct_model(&endpoint, Some("k"));
    let mut report = SynthesisControl::default();
    let value = run(
        &direct,
        "wiki_catalog",
        &catalog_query(),
        json!(sources()),
        json!(null),
        &mut report,
    )
    .await
    .unwrap();
    let captured = server.join().unwrap();
    assert_eq!(captured.len(), 1);
    let (authorization, body) = &captured[0];
    // The key's only destination is the selected endpoint's auth header.
    // (The mock lowercases captured headers.)
    assert_eq!(authorization.to_ascii_lowercase(), "bearer k");
    assert!(body.get("modelOverride").is_none());
    assert!(body.get("apiKey").is_none());
    assert!(serde_json::to_string(body).unwrap().contains("synthetic-model"));
    // Sources arrive as numbered passages inside the user message; no raw
    // id/revision/quote fields travel to the provider.
    let payload: Value =
        serde_json::from_str(body["messages"][1]["content"].as_str().unwrap()).unwrap();
    let model_source = &payload["sources"][0];
    assert_eq!(model_source["role"], json!("current"));
    assert!(model_source.get("revision").is_none());
    assert_eq!(model_source["passages"].as_array().unwrap().len(), 1);
    // Citations expanded back to full references for consumers.
    assert_eq!(value["topics"][0]["citations"][0]["id"], json!("new"));
    assert_eq!(value["topics"][0]["citations"][0]["quote"], json!("Alpha project started today. Budget was approved！Beta is delayed。"));
}

#[tokio::test]
async fn catalog_corrects_once_with_a_followup_call() {
    let (endpoint, server) = provider_server(vec![
        (
            200,
            completion(r#"{"topics":[{"key":"Alpha","existingId":"t-old","kind":"project","title":"Alpha","overview":"One.","citations":[0]}]}"#),
            None,
        ),
        (
            200,
            completion(r#"{"topics":[{"key":"Alpha","existingId":"t-old","kind":"project","title":"Alpha","overview":"One.","citations":[0,1]}]}"#),
            None,
        ),
    ]);
    let direct = direct_model(&endpoint, Some("k"));
    let mut report = SynthesisControl::default();
    let outcome = run(
        &direct,
        "wiki_catalog",
        &catalog_query(),
        json!(sources()),
        json!(null),
        &mut report,
    )
    .await;
    let captured = server.join().unwrap();
    let value = outcome.unwrap();
    let captured_messages = captured[1].1["messages"].as_array().unwrap();
    assert_eq!(captured_messages.len(), 3);
    assert_eq!(captured_messages[2]["role"], json!("user"));
    assert!(captured_messages[2]["content"]
        .as_str()
        .unwrap()
        .contains("current-source passage"));
    assert_eq!(value["topics"][0]["existingId"], json!("t-old"));
}

#[tokio::test]
async fn rate_limits_surface_retry_after_to_the_queue() {
    let (endpoint, server) = provider_server(vec![(
        429,
        json!({"error": "slow down"}).to_string(),
        Some("7".into()),
    )]);
    let direct = direct_model(&endpoint, Some("k"));
    let mut report = SynthesisControl::default();
    let error = run(
        &direct,
        "wiki_topic_match",
        &json!({"title": "Alpha"}).to_string(),
        json!(sources()),
        json!(null),
        &mut report,
    )
    .await
    .unwrap_err();
    assert_eq!(error, "Model provider failed (HTTP 429): Model rate limited");
    assert_eq!(report.retry_after, Some(7));
    assert_eq!(tasks::Outcome::classify(&error), tasks::Outcome::Retryable);
    assert_eq!(server.join().unwrap().len(), 1);
}

#[tokio::test]
async fn malformed_model_output_is_annotated_as_model_failure() {
    // Bank tasks run one internal correction round before giving up.
    let (endpoint, _) = provider_server(vec![
        (200, completion("not json at all"), None),
        (200, completion("still not json"), None),
    ]);
    let direct = direct_model(&endpoint, Some("k"));
    let mut report = SynthesisControl::default();
    let error = run(
        &direct,
        "source_analysis",
        "Project Alpha purpose",
        json!(sources()),
        json!(null),
        &mut report,
    )
    .await
    .unwrap_err();
    let (_, details) = validation_failure::split(error);
    let details = details.expect("model-output failures carry validation metadata");
    assert_eq!(details.failure_origin.as_deref(), Some("model_output"));
    assert!(details.correction_attempted);
}

#[tokio::test]
async fn loopback_endpoints_run_without_a_key() {
    let (endpoint, server) = provider_server(vec![(
        200,
        completion(r#"{"summary":"","insufficientEvidence":true,"citations":[],"memoryItems":[],"todoSuggestions":[],"decisions":[]}"#),
        None,
    )]);
    let direct = direct_model(&endpoint, None);
    let mut report = SynthesisControl::default();
    run(
        &direct,
        "meeting_summary",
        "summarize",
        json!(sources()),
        json!(null),
        &mut report,
    )
    .await
    .unwrap();
    let captured = server.join().unwrap();
    let (authorization, _) = &captured[0];
    assert_eq!(authorization, "");
}

#[tokio::test]
async fn truncated_output_is_reported_without_correction() {
    let (endpoint, server) = provider_server(vec![(
        200,
        json!({"choices": [{"finish_reason": "length", "message": {"content": "{\"topics\":"}}]}).to_string(),
        None,
    )]);
    let direct = direct_model(&endpoint, Some("k"));
    let mut report = SynthesisControl::default();
    let error = run(
        &direct,
        "wiki_catalog",
        &catalog_query(),
        json!(sources()),
        json!(null),
        &mut report,
    )
    .await
    .unwrap_err();
    assert_eq!(error, "Model output was truncated");
    assert_eq!(server.join().unwrap().len(), 1);
}

#[tokio::test]
async fn source_analysis_flow_marks_relevance_and_prompt_version() {
    let (endpoint, server) = provider_server(vec![(
        200,
        completion(
            r#"{"summary":"预算通过","relevant":true,"insufficientEvidence":false,"citations":[0],"memoryItems":[{"text":"预算已批准","kind":"decision","citations":[1]}],"todoSuggestions":[],"decisions":[]}"#,
        ),
        None,
    )]);
    let direct = direct_model(&endpoint, Some("k"));
    let mut report = SynthesisControl::default();
    let value = run(
        &direct,
        "source_analysis",
        "Project Alpha purpose and budget",
        json!(sources()),
        json!(null),
        &mut report,
    )
    .await
    .unwrap();
    assert_eq!(value["relevant"], json!(true));
    assert_eq!(value["promptVersion"], json!(DIRECT_PROCESSOR_VERSION));
    assert_eq!(value["citations"][0]["id"], json!("new"));
    assert_eq!(value["memoryItems"][0]["citations"][0]["id"], json!("old"));
    let (_, body) = &server.join().unwrap()[0];
    let system = body["messages"][0]["content"].as_str().unwrap();
    assert!(system.contains("passage numbers"));
    assert!(system.contains("source_analysis"));
}

#[tokio::test]
async fn grouping_and_matching_flow_through_their_validators() {
    let (endpoint, server) = provider_server(vec![
        (
            200,
            completion(r#"{"groups":[{"title":"Broad","existingId":null,"topicIds":["t0","t1"]}],"unassigned":["t2"]}"#),
            None,
        ),
        (
            200,
            completion(r#"{"relation":"uncertain","reason":"maybe same work","citations":[{"id":"new","revision":"r1","kind":"meeting","quote":"Alpha project started today"}],"events":[{"text":"started","date":null,"dateQuote":"","citations":[{"id":"new","revision":"r1","kind":"meeting","quote":"Alpha project started today"}]}]}"#),
            None,
        ),
    ]);
    let direct = direct_model(&endpoint, Some("k"));
    let src = json!(sources());
    let mut report = SynthesisControl::default();
    let topics = json!([
        {"id": "t0", "title": "Alpha", "overview": "o", "sourceIds": ["new"]},
        {"id": "t1", "title": "Beta", "overview": "o", "sourceIds": ["new"]},
        {"id": "t2", "title": "Gamma", "overview": "o", "sourceIds": ["old"]}
    ]);
    let query = json!({"topics": topics, "groups": []}).to_string();
    let groups = run(&direct, "wiki_topic_group", &query, src.clone(), json!(null), &mut report)
        .await
        .unwrap();
    assert_eq!(groups["groups"][0]["title"], json!("Broad"));
    let query = json!({"title": "Alpha", "purpose": "work"}).to_string();
    let relation = run(&direct, "wiki_topic_match", &query, src, json!(null), &mut report)
        .await
        .unwrap();
    assert_eq!(relation["relation"], json!("uncertain"));
    assert_eq!(server.join().unwrap().len(), 2);
}

#[test]
fn plain_corrections_only_cover_eligible_failures() {
    assert!(plain_correction("Invalid memory kind").is_some());
    assert!(plain_correction("Citation does not match source evidence").is_some());
    assert!(plain_correction("Invalid topic match output").is_none());
    assert!(plain_correction("Invalid topic grouping output").is_none());
}

#[test]
fn pipeline_bank_reproduces_two_passages_on_normalized_sources() {
    // The pipeline banks from normalized sources; replicate that exactly and
    // prove both passages exist before any provider call.
    let src = normalize_sources(&json!(sources())).unwrap();
    let bank = CitationBank::new(&src, &[], Some("new"));
    assert_eq!(bank.references.len(), 2, "one passage per short source");
    let raw = json!({"topics": [
        {"key": "Alpha", "existingId": "t-old", "kind": "project", "title": "Alpha", "overview": "One.", "citations": [0, 1]}
    ]});
    let expanded = bank.expand(&raw).unwrap();
    let value = validate_catalog(&expanded, &src, &catalog_query()).unwrap();
    assert_eq!(value["topics"][0]["existingId"], json!("t-old"));
}
