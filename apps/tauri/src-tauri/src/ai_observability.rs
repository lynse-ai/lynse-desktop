//! Best-effort bridge from native model calls to the initialized renderer
//! PostHog client. Keeping capture in the renderer reuses its authenticated
//! distinct ID and makes analytics delivery independent of model requests.

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

const AI_GENERATION_EVENT: &str = "posthog-ai-generation";

pub(crate) fn session_id(value: &str) -> String {
    value
        .chars()
        .map(|character| match character {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '~' | '.' | '@' | '(' | ')' | '!'
            | '\'' | ':' | '|' => character,
            _ => '_',
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn capture_generation(
    app: &AppHandle,
    trace_id: &str,
    session: Option<&str>,
    model: &str,
    provider: &str,
    input: Value,
    output: Option<String>,
    latency_seconds: f64,
    http_status: Option<u16>,
    error: Option<String>,
) {
    let mut properties = json!({
        "$ai_trace_id": trace_id,
        "$ai_session_id": session.map(session_id),
        "$ai_model": model,
        "$ai_provider": provider,
        "$ai_input": input,
        "$ai_latency": latency_seconds,
    });
    if let Some(output) = output {
        properties["$ai_output_choices"] = json!([{"role": "assistant", "content": output}]);
    }
    if let Some(status) = http_status {
        properties["$ai_http_status"] = json!(status);
    }
    if let Some(error) = error {
        properties["$ai_is_error"] = json!(true);
        properties["$ai_error"] = json!(error);
    }
    let _ = app.emit_to("main", AI_GENERATION_EVENT, properties);
}
