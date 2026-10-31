//! Bounded cloud reads and a short-lived, verified backend binding.
use super::*;
use std::{
    sync::OnceLock,
    time::{Duration, Instant},
};

const REQUEST_BUDGET: Duration = Duration::from_secs(35);
const BINDING_TTL: Duration = Duration::from_secs(240);

#[derive(Default)]
pub(super) struct Transport {
    client: OnceLock<CommandResult<reqwest::Client>>,
    binding: tokio::sync::Mutex<Option<(String, Instant)>>,
    cooldown: Mutex<Option<(String, Instant, String)>>,
}

pub(super) fn transient(error: &str) -> bool {
    matches!(
        error,
        "Cloud knowledge offline" | "Cloud knowledge unavailable"
    ) || error.starts_with("Cloud knowledge connection failed (")
        || [429, 500, 502, 503, 504].iter().any(|status| {
            error.starts_with(&format!("Cloud knowledge request failed (HTTP {status})"))
        })
}

fn http_error(status: reqwest::StatusCode, stage: &str) -> String {
    format!(
        "{} [stage: {stage}]",
        knowledge_cloud::response_error(status)
    )
}

fn connection_error(error: &reqwest::Error, stage: &str) -> String {
    let reason = if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connect"
    } else if error.is_decode() {
        "invalid_response"
    } else {
        "transport"
    };
    // reqwest's Display can contain URLs and upstream details. Persist only safe codes.
    format!("Cloud knowledge connection failed (stage: {stage}; reason: {reason})")
}

fn retry_after(value: &str) -> Option<Duration> {
    value
        .trim()
        .parse::<u64>()
        .ok()
        .map(Duration::from_secs)
        .or_else(|| {
            let date = chrono::DateTime::parse_from_rfc2822(value).ok()?;
            Some(
                (date.with_timezone(&chrono::Utc) - chrono::Utc::now())
                    .to_std()
                    .unwrap_or_default(),
            )
        })
}

impl Transport {
    fn client(&self) -> CommandResult<&reqwest::Client> {
        self.client
            .get_or_init(|| {
                reqwest::Client::builder()
                    .connect_timeout(Duration::from_secs(8))
                    .redirect(reqwest::redirect::Policy::none())
                    .build()
                    .map_err(|_| "Cloud knowledge unavailable".to_owned())
            })
            .as_ref()
            .map_err(Clone::clone)
    }

    async fn send(
        &self,
        call: reqwest::RequestBuilder,
        stage: &str,
        read: bool,
        route: &str,
        deadline: Instant,
        check: &impl Fn() -> CommandResult<()>,
    ) -> CommandResult<Value> {
        for attempt in 0..2 {
            check()?;
            let cooldown = self
                .cooldown
                .lock()
                .map_err(|_| "Cloud knowledge unavailable")?
                .clone();
            if let Some((_, until, error)) =
                cooldown.filter(|(key, until, _)| key == route && *until > Instant::now())
            {
                let delay = until.saturating_duration_since(Instant::now());
                if delay >= deadline.saturating_duration_since(Instant::now()) {
                    return Err(error);
                }
                tokio::time::sleep(delay).await;
                check()?;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(format!(
                    "Cloud knowledge connection failed (stage: {stage}; reason: timeout)"
                ));
            }
            let call = call
                .try_clone()
                .ok_or("Cloud knowledge unavailable")?
                .timeout(if read {
                    remaining.min(Duration::from_secs(15))
                } else {
                    remaining
                });
            let response = call.send().await;
            check()?;
            let error = match response {
                Ok(response) if response.status().is_success() => {
                    let value = response.json().await.map_err(|error| {
                        if error.is_timeout() {
                            connection_error(&error, stage)
                        } else {
                            format!("Invalid cloud knowledge response [stage: {stage}]")
                        }
                    })?;
                    check()?;
                    return Ok(value);
                }
                Ok(response) => {
                    let error = http_error(response.status(), stage);
                    if transient(&error) {
                        if let Some(delay) = response
                            .headers()
                            .get("Retry-After")
                            .and_then(|value| value.to_str().ok())
                            .and_then(retry_after)
                        {
                            if let Some(until) = Instant::now().checked_add(delay) {
                                let mut cooldown = self
                                    .cooldown
                                    .lock()
                                    .map_err(|_| "Cloud knowledge unavailable")?;
                                if cooldown.as_ref().is_none_or(|(key, previous, _)| {
                                    key != route || *previous < until
                                }) {
                                    *cooldown = Some((route.to_owned(), until, error.clone()));
                                }
                            }
                        }
                    }
                    error
                }
                Err(error) => connection_error(&error, stage),
            };
            // Writes and unknown model outcomes must never be replayed here.
            if !read
                || attempt > 0
                || !transient(&error)
                || deadline.saturating_duration_since(Instant::now()) <= Duration::from_millis(500)
            {
                return Err(error);
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        unreachable!()
    }

    pub(super) async fn request(
        &self,
        session: &Session,
        path: &str,
        body: Option<Value>,
        operation: Option<&str>,
        check: impl Fn() -> CommandResult<()>,
    ) -> CommandResult<Value> {
        check()?;
        let deadline = Instant::now() + REQUEST_BUDGET;
        let key = store::digest(
            json!([
                session.scope,
                session.generation,
                session.user_id,
                session.base_url,
                session.agent_url,
                store::digest(&session.token)
            ])
            .to_string(),
        );
        let client = self.client()?;
        if session.agent_url != session.base_url {
            // Single-flight binding is separate from the local commit lock.
            let mut binding = tokio::time::timeout(REQUEST_BUDGET, self.binding.lock())
                .await
                .map_err(|_| {
                    "Cloud knowledge connection failed (stage: identity_binding; reason: timeout)"
                })?;
            check()?;
            if !binding
                .as_ref()
                .is_some_and(|(cached, until)| cached == &key && *until > Instant::now())
            {
                *binding = None;
                let value = self
                    .send(
                        client
                            .post(format!("{}/api/session/backend", session.agent_url))
                            .header("Authorization", &session.token)
                            .json(&json!({"host": session.base_url})),
                        "identity_binding",
                        true,
                        &key,
                        deadline,
                        &check,
                    )
                    .await?;
                if value["user_id"].as_str() != Some(&session.user_id)
                    || value["host"]
                        .as_str()
                        .map(|host| host.trim_end_matches('/'))
                        != Some(session.base_url.trim_end_matches('/'))
                {
                    return Err("Cloud knowledge identity mismatch".into());
                }
                check()?;
                *binding = Some((key.clone(), Instant::now() + BINDING_TTL));
            }
        }
        let prefix = if session.agent_url == session.base_url {
            "/api/business/ai/memory"
        } else {
            "/api/memory"
        };
        let stage = if path == "/capabilities" {
            "capabilities"
        } else {
            "cloud_access"
        };
        let url = format!("{}{prefix}{path}", session.agent_url);
        let read = body.is_none();
        let mut call = if read {
            client.get(url)
        } else {
            client.post(url)
        }
        .header("Authorization", &session.token);
        if let Some(body) = body {
            call = call.json(&body);
        }
        if let Some(operation) = operation {
            call = call.header("Operation-Id", operation);
        }
        let result = self.send(call, stage, read, &key, deadline, &check).await;
        if result.as_ref().is_err_and(|error| {
            error.contains("identity verification failed") || error.contains("HTTP 403")
        }) {
            let mut binding = self.binding.lock().await;
            if binding.as_ref().is_some_and(|(cached, _)| cached == &key) {
                *binding = None;
            }
        }
        result
    }
}

#[cfg(test)]
#[path = "knowledge_transport_tests.rs"]
mod tests;
