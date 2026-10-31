use super::tests::synthesis_server;
use super::*;

#[tokio::test]
async fn server_corrected_indexed_citations_do_not_trigger_another_client_retry() {
    let (endpoint, server) = synthesis_server(vec![(422, json!({
        "detail":"Invalid citation", "correctionAttempted":true,
        "citationIssue":{"code":"invalid_reference","location":"citations","citationIndex":0}
    }))]);
    let error = send_synthesis(&synthesis_client(&endpoint).unwrap(), &endpoint, "synthetic",
        json!({"task":"source_analysis","citationFormat":"indexed","sources":[{"id":"meeting"}]}), || Ok(())).await.unwrap_err();
    assert_eq!(server.join().unwrap().len(), 1);
    assert!(WikiFailure::new(error,"analyzing",vec!["meeting".into()]).validation.unwrap().correction_attempted);
}

#[test]
fn indexed_correction_preserves_the_passage_selection_protocol() {
    let corrected = corrected_synthesis_request(&json!({"task":"source_analysis","citationFormat":"indexed","query":"Launch"}),
        &json!({"detail":"Model did not return valid structured output"})).unwrap();
    assert!(corrected["query"].as_str().unwrap().contains("integer passage numbers"));
}

#[tokio::test]
async fn catalog_diagnostics_keep_server_repair_without_a_second_client_submission() {
    let (endpoint, server) = synthesis_server(vec![(422, json!({
        "detail":"Citation does not match source evidence", "correctionAttempted":true,
        "catalogIssue":{"code":"invalid_citation","topicIndex":1,"field":"citations","quote":"PRIVATE_MODEL_QUOTE"},
        "citationIssue":{"code":"quote_not_found","sourceId":"meeting","citationIndex":0,"location":"topics[1].citations"}
    }))]);
    let error = send_synthesis(&synthesis_client(&endpoint).unwrap(), &endpoint, "synthetic",
        json!({"task":"wiki_catalog","sources":[{"id":"meeting"}]}), || Ok(())).await.unwrap_err();
    assert_eq!(server.join().unwrap().len(), 1);
    assert!(!error.contains("PRIVATE_MODEL_QUOTE"));
    let failure=WikiFailure::new(error,"analyzing",vec!["meeting".into()]);
    let restored: WikiFailure=serde_json::from_value(serde_json::to_value(&failure).unwrap()).unwrap();
    let validation=restored.validation.unwrap();
    assert!(validation.correction_attempted);
    assert_eq!(validation.catalog_issue.unwrap().topic_index,Some(1));
    assert_eq!(validation.citation_issue.unwrap().location.as_deref(),Some("topics[1].citations"));
}

#[tokio::test]
async fn failed_citation_correction_reaches_topic_recovery_as_typed_diagnostics() {
    let failure = json!({"detail":"Citation does not match source evidence", "citationIssue":{
        "code":"quote_not_found","sourceId":"meeting","citationIndex":1,"location":"memoryItems[2].citations",
        "quote":"PRIVATE_MODEL_QUOTE"}});
    let (endpoint, server) = synthesis_server(vec![(422, failure.clone()), (422, failure)]);
    let error = send_synthesis(&synthesis_client(&endpoint).unwrap(), &endpoint, "synthetic",
        json!({"task":"source_analysis","sources":[{"id":"meeting"}]}), || Ok(())).await.unwrap_err();
    assert!(!error.contains("PRIVATE_MODEL_QUOTE"));
    let failure = WikiFailure::new(error, "analyzing", vec!["meeting".into()]);
    assert_eq!(server.join().unwrap().len(), 2);
    assert!(!failure.message.contains("lynse-validation"));
    let validation = failure.validation.unwrap();
    assert!(validation.correction_attempted);
    let issue = validation.citation_issue.unwrap();
    assert_eq!(issue.source_id.as_deref(), Some("meeting"));
    assert_eq!(issue.citation_index, Some(1));
    assert_eq!(issue.location.as_deref(), Some("memoryItems[2].citations"));
}

#[tokio::test]
async fn graph_correction_is_bounded_and_retains_only_provenance() {
    let failure = json!({"detail":"Invalid evidence graph output","usage":{"input":100,"output":20,"total":120},
        "metrics":{"calls":1,"generationMs":50,"knownCalls":{"input":1,"output":1,"total":1}}});
    let success = json!({"code":200,"data":{"schemaVersion":1,"nodes":[],"relations":[]},
        "usage":{"input":110,"output":30,"total":140,"cachedInput":90},
        "metrics":{"calls":1,"generationMs":60,"model":"deepseek-flash","profile":"deepseek-graph-v2",
            "knownCalls":{"input":1,"output":1,"total":1,"cachedInput":1}}});
    let (endpoint, server) = synthesis_server(vec![(422, failure), (200, success)]);
    let client = synthesis_client(&endpoint).unwrap();
    let body = json!({"task":"graph_extract","compactGraph":true,"includeGraphProfile":true,"includeUsage":true,"sources":[{"text":"Original evidence"}]});
    let mut report = SynthesisControl::default();
    let result = send_synthesis_report(
        &client,
        &endpoint,
        "synthetic-token",
        body.clone(),
        &mut report,
        || Ok(()),
    )
    .await
    .unwrap();
    assert_eq!(result["schemaVersion"], 1);
    assert_eq!(report.model.as_deref(), Some("deepseek-flash"));
    assert_eq!(report.profile.as_deref(), Some("deepseek-graph-v2"));
    let requests = server.join().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0]["sources"], requests[1]["sources"]);
    assert!(requests[1]["query"]
        .as_str()
        .unwrap()
        .contains("schemaVersion 2"));
}

#[tokio::test]
async fn truncation_and_unknown_outcomes_do_not_trigger_hidden_retry() {
    for (status, detail) in [
        (422, "Model output was truncated"),
        (503, "Model outcome is unknown; retry explicitly"),
    ] {
        let (endpoint, server) = synthesis_server(vec![(
            status,
            json!({"detail":detail,"usage":{"input":10,"output":5},"metrics":{"calls":1}}),
        )]);
        let mut report = SynthesisControl::default();
        let result = send_synthesis_report(
            &synthesis_client(&endpoint).unwrap(),
            &endpoint,
            "synthetic",
            json!({"task":"graph_extract"}),
            &mut report,
            || Ok(()),
        )
        .await;
        assert!(result.unwrap_err().contains(detail));
        assert_eq!(server.join().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn rate_limit_delay_remains_explicit_without_accounting() {
    let (endpoint, server) = synthesis_server(vec![(
        429,
        json!({"detail":"Graph model rate limited",
        "metrics":{"calls":1,"retryAfter":7}}),
    )]);
    let mut report = SynthesisControl::default();
    let result = send_synthesis_report(
        &synthesis_client(&endpoint).unwrap(),
        &endpoint,
        "synthetic",
        json!({"task":"graph_extract"}),
        &mut report,
        || Ok(()),
    )
    .await;
    assert!(result.is_err());
    assert_eq!(report.retry_after, Some(7));
    assert_eq!(server.join().unwrap().len(), 1);
    let date = (chrono::Utc::now() + chrono::Duration::seconds(120)).to_rfc2822();
    assert!((118..=120).contains(&retry_after_seconds(&date)));
}

#[test]
fn graph_payload_never_inherits_chat_model_or_credentials() {
    let session = Session {
        scope: "user".into(),
        user_id: "verified".into(),
        base_url: "https://business.invalid".into(),
        agent_url: "https://agent.invalid".into(),
        token: "synthetic".into(),
        generation: 1,
        locale: "zh".into(),
        model_override: Some(
            json!({"model":"glm-5.3-flash","baseUrl":"https://chat.invalid","apiKey":"chat-secret"}),
        ),
    };
    let graph = lynclaw_payload(&session, "graph_extract", json!({"sources":[]}));
    assert_eq!(graph["modelOverride"]["model"], "deepseek-flash");
    assert!(graph["modelOverride"].get("apiKey").is_none());
    assert!(!graph.to_string().contains("chat-secret"));
    assert_eq!(graph["includeUsage"], true);
    assert_eq!(graph["includeGraphProfile"], true);
    assert!(graph.get("citationFormat").is_none());
    for task in ["wiki_catalog", "source_analysis", "topic_compile"] {
        assert_eq!(lynclaw_payload(&session, task, json!({"sources":[]}))["citationFormat"], "indexed");
    }
    assert_eq!(
        lynclaw_payload(&session, "meeting_summary", json!({"sources":[]}))["modelOverride"],
        session.model_override.unwrap()
    );
}

#[test]
fn stale_chat_model_cancels_only_text_synthesis_and_not_graph_requests() {
    let state = WorkbenchState::default();
    let old = Session { scope:"same-user".into(),user_id:"verified".into(),base_url:"https://business.invalid".into(),
        agent_url:"https://agent.invalid".into(),token:"synthetic".into(),generation:7,locale:"zh".into(),model_override:None };
    let mut next = old.clone();
    next.model_override = Some(json!({"model":"glm-5.3-flash","preset":"miaoyun"}));
    *state.session.lock().unwrap() = Some(next);
    assert!(require_task_model(&state, &old, "graph_extract").is_ok());
    assert_eq!(require_task_model(&state, &old, "source_analysis").unwrap_err(), TEXT_MODEL_CHANGED);
    assert!(is_service_failure(TEXT_MODEL_CHANGED));
}
