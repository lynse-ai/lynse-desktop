//! Feishu Open Platform HTTP APIs: tenant access token, message sending /
//! replying, chat listing, bot info, and the WS endpoint discovery call that
//! hands out the long-connection URL (`/callback/ws/endpoint`).
//!
//! All calls go through the shared `reqwest` client. Feishu wraps every
//! business response in `{code, msg, ...}` where `code: 0` means success.

use serde_json::{json, Value};
use std::time::Duration;

use crate::CommandResult;

pub(crate) const DEFAULT_DOMAIN: &str = "https://open.feishu.cn";

const HTTP_TIMEOUT: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Parsed `/callback/ws/endpoint` response — everything the WS client needs
/// to dial in and keep the connection alive.
#[derive(Debug, Clone)]
pub(crate) struct ConnectConfig {
    /// Full `wss://…` URL (carries `device_id` / `service_id` / ticket params).
    pub url: String,
    /// Parsed from the URL's `service_id` query param; stamped on every frame.
    pub service_id: i32,
    /// Seconds between heartbeat pings.
    pub ping_interval_secs: u64,
}

pub(crate) struct FeishuApi {
    http: reqwest::Client,
    domain: String,
    app_id: String,
    app_secret: String,
}

impl FeishuApi {
    pub(crate) fn new(domain: &str, app_id: &str, app_secret: &str) -> CommandResult<Self> {
        let http = reqwest::Client::builder()
            .timeout(HTTP_TIMEOUT)
            .connect_timeout(CONNECT_TIMEOUT)
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Self {
            http,
            domain: domain.trim_end_matches('/').to_owned(),
            app_id: app_id.trim().to_owned(),
            app_secret: app_secret.trim().to_owned(),
        })
    }

    fn check_envelope(&self, code: i64, msg: &str, context: &str) -> CommandResult<()> {
        if code == 0 {
            Ok(())
        } else {
            Err(format!("Feishu {context} failed: code={code}, msg={msg}"))
        }
    }

    /// App (tenant) access token. Valid ~2 hours; callers should cache it (the
    /// managed handle does) and only call this on (near-)expiry.
    pub(crate) async fn fetch_tenant_access_token(&self) -> CommandResult<(String, u64)> {
        let response = self
            .http
            .post(format!("{}/open-apis/auth/v3/tenant_access_token/internal", self.domain))
            .json(&json!({ "app_id": self.app_id, "app_secret": self.app_secret }))
            .send()
            .await
            .map_err(|error| format!("Feishu token request failed: {error}"))?;
        let body: Value = response.json().await.map_err(|error| error.to_string())?;
        self.check_envelope(
            body.get("code").and_then(Value::as_i64).unwrap_or(-1),
            body.get("msg").and_then(Value::as_str).unwrap_or(""),
            "token",
        )?;
        let token = body
            .get("tenant_access_token")
            .and_then(Value::as_str)
            .ok_or("Feishu token response missing tenant_access_token")?
            .to_owned();
        let expire = body.get("expire").and_then(Value::as_u64).unwrap_or(7200);
        Ok((token, expire))
    }

    /// Ask the gateway for a long-connection URL. Mirrors the official
    /// node-sdk `WSClient.pullConnectConfig` / Go-sdk `ws.GenEndpointUri`.
    pub(crate) async fn pull_connect_config(&self) -> CommandResult<ConnectConfig> {
        let response = self
            .http
            .post(format!("{}/callback/ws/endpoint", self.domain))
            .header("locale", "zh")
            .json(&json!({ "AppID": self.app_id, "AppSecret": self.app_secret }))
            .send()
            .await
            .map_err(|error| format!("Feishu WS endpoint request failed: {error}"))?;
        let body: Value = response.json().await.map_err(|error| error.to_string())?;
        let code = body.get("code").and_then(Value::as_i64).unwrap_or(-1);
        self.check_envelope(code, body.get("msg").and_then(Value::as_str).unwrap_or(""), "WS endpoint")?;
        let data = body.get("data").ok_or("Feishu WS endpoint response missing data")?;
        let url = data
            .get("URL")
            .and_then(Value::as_str)
            .ok_or("Feishu WS endpoint response missing URL")?
            .to_owned();

        // The gateway reports heartbeat/reconnect tuning in the URL query
        // (`service_id`) and `ClientConfig`; the node-sdk parses the same way.
        let service_id = parse_query_param(&url, "service_id")
            .and_then(|value| value.parse::<i32>().ok())
            .ok_or("Feishu WS endpoint URL missing service_id")?;
        let client_config = data.get("ClientConfig");
        let ping_interval_secs = client_config
            .and_then(|config| config.get("PingInterval"))
            .and_then(Value::as_u64)
            .filter(|value| *value > 0)
            .unwrap_or(30);

        Ok(ConnectConfig {
            url,
            service_id,
            ping_interval_secs,
        })
    }

    /// POST one message (`msg_type`: text / interactive) to a chat.
    pub(crate) async fn send_message(
        &self,
        token: &str,
        chat_id: &str,
        msg_type: &str,
        content: &Value,
    ) -> CommandResult<Value> {
        let response = self
            .http
            .post(format!(
                "{}/open-apis/im/v1/messages?receive_id_type=chat_id",
                self.domain
            ))
            .bearer_auth(token)
            .json(&json!({
                "receive_id": chat_id,
                "msg_type": msg_type,
                "content": content.to_string(),
            }))
            .send()
            .await
            .map_err(|error| format!("Feishu send message failed: {error}"))?;
        self.parse_message_response(response, "send message").await
    }

    /// POST a threaded reply to a specific message.
    pub(crate) async fn reply_message(
        &self,
        token: &str,
        message_id: &str,
        msg_type: &str,
        content: &Value,
    ) -> CommandResult<Value> {
        let response = self
            .http
            .post(format!("{}/open-apis/im/v1/messages/{message_id}/reply", self.domain))
            .bearer_auth(token)
            .json(&json!({ "msg_type": msg_type, "content": content.to_string() }))
            .send()
            .await
            .map_err(|error| format!("Feishu reply failed: {error}"))?;
        self.parse_message_response(response, "reply").await
    }

    /// PATCH the card on an already-sent interactive message — the basis of
    /// the agent's streaming "typewriter" answer (the ack card grows into the
    /// final answer). Fails with a permission error when the app lacks the
    /// card-update scope; callers degrade to plain replies then.
    pub(crate) async fn update_card(
        &self,
        token: &str,
        message_id: &str,
        card: &Value,
    ) -> CommandResult<Value> {
        let response = self
            .http
            .patch(format!("{}/open-apis/im/v1/messages/{message_id}", self.domain))
            .bearer_auth(token)
            .json(&json!({ "content": card.to_string() }))
            .send()
            .await
            .map_err(|error| format!("Feishu card update failed: {error}"))?;
        self.parse_message_response(response, "card update").await
    }

    /// Create a Cardkit card entity (JSON 2.0) and return its `card_id`. The
    /// streaming card the agent replies with; requires the `cardkit:card`
    /// (创建与更新卡片) scope.
    pub(crate) async fn create_card_entity(
        &self,
        token: &str,
        card: &Value,
    ) -> CommandResult<String> {
        let response = self
            .http
            .post(format!("{}/open-apis/cardkit/v1/cards", self.domain))
            .bearer_auth(token)
            .json(&json!({ "type": "card_json", "data": card.to_string() }))
            .send()
            .await
            .map_err(|error| format!("Feishu card entity create failed: {error}"))?;
        let body: Value = response
            .json()
            .await
            .map_err(|error| format!("Feishu card entity create response is not JSON: {error}"))?;
        self.check_envelope(
            body.get("code").and_then(Value::as_i64).unwrap_or(-1),
            body.get("msg").and_then(Value::as_str).unwrap_or(""),
            "card entity create",
        )?;
        body.pointer("/data/card_id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| "Feishu card entity response missing card_id".to_owned())
    }

    /// Push the FULL markdown of a card entity's element. Cardkit renders the
    /// delta client-side as a typewriter when the new text extends the old.
    /// `sequence` must strictly increase per card; streaming mode has no QPS
    /// cap for these updates.
    pub(crate) async fn stream_card_content(
        &self,
        token: &str,
        card_id: &str,
        element_id: &str,
        content: &str,
        sequence: i64,
    ) -> CommandResult<()> {
        let response = self
            .http
            .put(format!(
                "{}/open-apis/cardkit/v1/cards/{card_id}/elements/{element_id}/content",
                self.domain
            ))
            .bearer_auth(token)
            .json(&json!({ "content": content, "sequence": sequence }))
            .send()
            .await
            .map_err(|error| format!("Feishu card stream push failed: {error}"))?;
        let body: Value = response
            .json()
            .await
            .map_err(|error| format!("Feishu card stream push response is not JSON: {error}"))?;
        self.check_envelope(
            body.get("code").and_then(Value::as_i64).unwrap_or(-1),
            body.get("msg").and_then(Value::as_str).unwrap_or(""),
            "card stream push",
        )
    }

    /// Close the card's streaming mode (PATCH cardkit settings) so the chat
    /// preview shows real content and the card can be forwarded.
    pub(crate) async fn finish_streaming_card(
        &self,
        token: &str,
        card_id: &str,
        sequence: i64,
    ) -> CommandResult<()> {
        let response = self
            .http
            .patch(format!("{}/open-apis/cardkit/v1/cards/{card_id}/settings", self.domain))
            .bearer_auth(token)
            .json(&json!({
                "settings": json!({ "config": { "streaming_mode": false } }).to_string(),
                "sequence": sequence,
            }))
            .send()
            .await
            .map_err(|error| format!("Feishu card stream finish failed: {error}"))?;
        let body: Value = response
            .json()
            .await
            .map_err(|error| format!("Feishu card stream finish response is not JSON: {error}"))?;
        self.check_envelope(
            body.get("code").and_then(Value::as_i64).unwrap_or(-1),
            body.get("msg").and_then(Value::as_str).unwrap_or(""),
            "card stream finish",
        )
    }

    async fn parse_message_response(
        &self,
        response: reqwest::Response,
        context: &str,
    ) -> CommandResult<Value> {
        let status = response.status();
        let body: Value = response.json().await.map_err(|error| {
            format!("Feishu {context} response is not JSON (HTTP {status}): {error}")
        })?;
        self.check_envelope(
            body.get("code").and_then(Value::as_i64).unwrap_or(-1),
            body.get("msg").and_then(Value::as_str).unwrap_or(""),
            context,
        )?;
        Ok(body)
    }

    /// Chats the bot is a member of (single chats included), for the settings
    /// page's push-target picker.
    pub(crate) async fn list_chats(&self, token: &str) -> CommandResult<Vec<Value>> {
        let response = self
            .http
            .get(format!("{}/open-apis/im/v1/chats?page_size=100", self.domain))
            .bearer_auth(token)
            .send()
            .await
            .map_err(|error| format!("Feishu chat list failed: {error}"))?;
        let body: Value = response.json().await.map_err(|error| error.to_string())?;
        self.check_envelope(
            body.get("code").and_then(Value::as_i64).unwrap_or(-1),
            body.get("msg").and_then(Value::as_str).unwrap_or(""),
            "chat list",
        )?;
        Ok(body
            .pointer("/data/items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }

    /// The bot app's own identity (`GET /bot/v3/info`) — name, open_id, status.
    pub(crate) async fn bot_info(&self, token: &str) -> CommandResult<Value> {
        let response = self
            .http
            .get(format!("{}/open-apis/bot/v3/info", self.domain))
            .bearer_auth(token)
            .send()
            .await
            .map_err(|error| format!("Feishu bot info failed: {error}"))?;
        let body: Value = response.json().await.map_err(|error| error.to_string())?;
        self.check_envelope(
            body.get("code").and_then(Value::as_i64).unwrap_or(-1),
            body.get("msg").and_then(Value::as_str).unwrap_or(""),
            "bot info",
        )?;
        Ok(body.get("bot").cloned().unwrap_or(Value::Null))
    }

    /// The bot's open_id — used to detect "@bot" mentions in groups.
    pub(crate) async fn bot_open_id(&self, token: &str) -> CommandResult<String> {
        self.bot_info(token)
            .await?
            .get("open_id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| "Feishu bot info missing open_id".to_owned())
    }
}

fn parse_query_param(url: &str, key: &str) -> Option<String> {
    let query = url.split_once('?')?.1;
    for pair in query.split('&') {
        if let Some((name, value)) = pair.split_once('=') {
            if name == key {
                return Some(value.to_owned());
            }
        }
    }
    None
}
