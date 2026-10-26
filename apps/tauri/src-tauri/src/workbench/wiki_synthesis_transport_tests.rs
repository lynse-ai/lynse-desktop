use super::tests::synthesis_server;
use super::*;

#[tokio::test]
async fn graph_correction_is_bounded_and_accounts_for_failed_generation() {
    let failure = json!({"detail":"Invalid evidence graph output","usage":{"input":100,"output":20,"total":120},
        "metrics":{"calls":1,"generationMs":50,"knownCalls":{"input":1,"output":1,"total":1}}});
    let success = json!({"code":200,"data":{"schemaVersion":1,"nodes":[],"relations":[]},
        "usage":{"input":110,"output":30,"total":140,"cachedInput":90},
        "metrics":{"calls":1,"generationMs":60,"model":"deepseek-flash","profile":"deepseek-graph-v2",
            "knownCalls":{"input":1,"output":1,"total":1,"cachedInput":1}}});
    let (endpoint, server) = synthesis_server(vec![(422, failure), (200, success)]);
    let client = synthesis_client(&endpoint).unwrap();
    let body = json!({"task":"graph_extract","compactGraph":true,"sources":[{"text":"Original evidence"}]});
    let mut report = Accounting::default();
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
    assert_eq!(report.usage.total, Some(260));
    assert_eq!(report.metrics.calls, 2);
    assert_eq!(report.metrics.known_calls["cachedInput"], 1);
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
        let mut report = Accounting::default();
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
        assert_eq!(report.metrics.calls, 1);
        assert_eq!(server.join().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn rate_limit_delay_and_missing_usage_remain_explicit() {
    let (endpoint, server) = synthesis_server(vec![(
        429,
        json!({"detail":"Graph model rate limited",
        "metrics":{"calls":1,"retryAfter":7}}),
    )]);
    let mut report = Accounting::default();
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
    assert_eq!(report.metrics.retry_after, Some(7));
    assert_eq!(report.usage.input, None);
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
