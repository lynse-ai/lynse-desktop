//! HTTPS and ABI adapter for the precompiled recording-card verifier.

use std::sync::LazyLock;
use std::time::Duration;

use reqwest::header::{HeaderValue, AUTHORIZATION, CACHE_CONTROL};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use super::protocol::CardIdentity;

static TRUSTED_ROOT_CAS: &[&str] = &[
    // 1. AAA Certificate Services (Comodo / Sectigo root, validates *.lynse.cn)
    concat!(
        "-----BEGIN CERTIFICATE-----\n",
        "MIIEMjCCAxqgAwIBAgIBATANBgkqhkiG9w0BAQUFADB7MQswCQYDVQQGEwJHQjEb\n",
        "MBkGA1UECAwSR3JlYXRlciBNYW5jaGVzdGVyMRAwDgYDVQQHDAdTYWxmb3JkMRow\n",
        "GAYDVQQKDBFDb21vZG8gQ0EgTGltaXRlZDEhMB8GA1UEAwwYQUFBIENlcnRpZmlj\n",
        "YXRlIFNlcnZpY2VzMB4XDTA0MDEwMTAwMDAwMFoXDTI4MTIzMTIzNTk1OVowezEL\n",
        "MAkGA1UEBhMCR0IxGzAZBgNVBAgMEkdyZWF0ZXIgTWFuY2hlc3RlcjEQMA4GA1UE\n",
        "BwwHU2FsZm9yZDEaMBgGA1UECgwRQ29tb2RvIENBIExpbWl0ZWQxITAfBgNVBAMM\n",
        "GEFBQSBDZXJ0aWZpY2F0ZSBTZXJ2aWNlczCCASIwDQYJKoZIhvcNAQEBBQADggEP\n",
        "ADCCAQoCggEBAL5AnfRu4ep2hxxNRUSOvkbIgwadwSr+GB+O5AL686tdUIoWMQua\n",
        "BtDFcCLNSS1UY8y2bmhGC1Pqy0wkwLxyTurxFa70VJoSCsN6sjNg4tqJVfMiWPPe\n",
        "3M/vg4aijJRPn2jymJBGhCfHdr/jzDUsi14HZGWCwEiwqJH5YZ92IFCokcdmtet4\n",
        "YgNW8IoaE+oxox6gmf049vYnMlhvB/VruPsUK6+3qszWY19zjNoFmag4qMsXeDZR\n",
        "rOme9Hg6jc8P2ULimAyrL58OAd7vn5lJ8S3frHRNG5i1R8XlKdH5kBjHYpy+g8cm\n",
        "ez6KJcfA3Z3mNWgQIJ2P2N7Sw4ScDV7oL8kCAwEAAaOBwDCBvTAdBgNVHQ4EFgQU\n",
        "oBEKIz6W8Qfs4q8p74Klf9AwpLQwDgYDVR0PAQH/BAQDAgEGMA8GA1UdEwEB/wQF\n",
        "MAMBAf8wewYDVR0fBHQwcjA4oDagNIYyaHR0cDovL2NybC5jb21vZG9jYS5jb20v\n",
        "QUFBQ2VydGlmaWNhdGVTZXJ2aWNlcy5jcmwwNqA0oDKGMGh0dHA6Ly9jcmwuY29t\n",
        "b2RvLm5ldC9BQUFDZXJ0aWZpY2F0ZVNlcnZpY2VzLmNybDANBgkqhkiG9w0BAQUF\n",
        "AAOCAQEACFb8AvCb6P+k+tZ7xkSAzk/ExfYAWMymtrwUSWgEdujm7l3sAg9g1o1Q\n",
        "GE8mTgHj5rCl7r+8dFRBv/38ErjHT1r0iWAFf2C3BUrz9vHCv8S5dIa2LX1rzNLz\n",
        "Rt0vxuBqw8M0Ayx9lt1awg6nCpnBBYurDC/zXDrPbDdVCYfeU0BsWO/8tqtlbgT2\n",
        "G9w84FoVxp7Z8VlIMCFlA2zs6SFz7JsDoeA3raAVGI/6ugLOpyypEBMs1OUIJqsi\n",
        "l2D4kF501KKaU73yqWjgom7C12yxow+ev+to51byrvLjKzg6CYG1a4XXvi3tPxq3\n",
        "smPi9WIsgtRqAEFQ8TmDn5XpNpaYbg==\n",
        "-----END CERTIFICATE-----\n"
    ),
    // 2. GlobalSign Root CA (R3 / Google Trust Services root, validates *.lynse.ai)
    concat!(
        "-----BEGIN CERTIFICATE-----\n",
        "MIIDXzCCAkegAwIBAgILBAAAAAABIVhTCKIwDQYJKoZIhvcNAQELBQAwTDEgMB4G\n",
        "A1UECxMXR2xvYmFsU2lnbiBSb290IENBIC0gUjMxEzARBgNVBAoTCkdsb2JhbFNp\n",
        "Z24xEzARBgNVBAMTCkdsb2JhbFNpZ24wHhcNMDkwMzE4MTAwMDAwWhcNMjkwMzE4\n",
        "MTAwMDAwWjBMMSAwHgYDVQQLExdHbG9iYWxTaWduIFJvb3QgQ0EgLSBSMzETMBEG\n",
        "A1UEChMKR2xvYmFsU2lnbjETMBEGA1UEAxMKR2xvYmFsU2lnbjCCASIwDQYJKoZI\n",
        "hvcNAQEBBQADggEPADCCAQoCggEBAMwldpB5BngiFvXAg7aEyiie/QV2EcWtiHL8\n",
        "RgJDx7KKnQRfJMsuS+FggkbhUqsMgUdwbN1k0ev1LKMPgj0MK66X17YUhhB5uzsT\n",
        "gHeMCOFJ0mpiLx9e+pZo34knlTifBtc+ycsmWQ1z3rDI6SYOgxXG71uL0gRgykmm\n",
        "KPZpO/bLyCiR5Z2KYVc3rHQU3HTgOu5yLy6c+9C7v/U9AOEGM+iCK65TpjoWc4zd\n",
        "QQ4gOsC0p6Hpsk+QLjJg6VfLuQSSaGjlOCZgdbKfd/+RFO+uIEn8rUAVSNECMWEZ\n",
        "XriX7613t2Saer9fwRPvm2L7DWzgVGkWqQPabumDk3F2xmmFghcCAwEAAaNCMEAw\n",
        "DgYDVR0PAQH/BAQDAgEGMA8GA1UdEwEB/wQFMAMBAf8wHQYDVR0OBBYEFI/wS3+o\n",
        "LkUkrk1Q+mOai97i3Ru8MA0GCSqGSIb3DQEBCwUAA4IBAQBLQNvAUKr+yAzv95ZU\n",
        "RUm7lgAJQayzE4aGKAczymvmdLm6AC2upArT9fHxD4q/c2dKg8dEe3jgr25sbwMp\n",
        "jjM5RcOO5LlXbKr8EpbsU8Yt5CRsuZRj+9xTaGdWPoO4zzUhw8lo/s7awlOqzJCK\n",
        "6fBdRoyV3XpYKBovHd7NADdBj+1EbddTKJd+82cEHhXXipa0095MJ6RMG3NzdvQX\n",
        "mcIfeg7jLQitChws/zyrVQ4PkX4268NXSb7hLi18YIvDQVETI53O9zJrlAGomecs\n",
        "Mx86OyXShkDOOyyGeMlhLxS67ttVb9+E7gUJTb0o2HLO02JQZR7rkpeDMdmztcpH\n",
        "WD9f\n",
        "-----END CERTIFICATE-----\n"
    ),
    // 3. ISRG Root X1 (Let's Encrypt Root CA)
    concat!(
        "-----BEGIN CERTIFICATE-----\n",
        "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\n",
        "-----END CERTIFICATE-----\n"
    ),
];

static SECURE_CLIENT: LazyLock<Result<reqwest::Client, reqwest::Error>> = LazyLock::new(|| {
    let mut certs = Vec::new();
    for pem in TRUSTED_ROOT_CAS {
        if let Ok(cert) = reqwest::Certificate::from_pem(pem.as_bytes()) {
            certs.push(cert);
        }
    }

    reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none())
        .tls_certs_only(certs)
        .build()
});

static CLIENT: LazyLock<Result<reqwest::Client, reqwest::Error>> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none())
        .build()
});

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CardAccess {
    pub api_base_url: String,
    pub token: String,
    #[serde(default)]
    pub gateway_url: Option<String>,
    #[serde(default)]
    pub agent_base_url: Option<String>,
}

pub struct CardCredential {
    pub password: Zeroizing<String>,
    pub vendor_id: u16,
    pub product_id: u16,
}

#[derive(PartialEq, Eq)]
pub(super) struct CardAccount {
    gateway: &'static str,
    session: [u8; 32],
}

#[derive(Debug, thiserror::Error)]
pub enum OwnershipError {
    #[error("recording_card_account_required")]
    AccountRequired,
    #[error("recording_card_identity_unavailable")]
    IdentityUnavailable,
    #[error("recording_card_not_bound")]
    NotBound,
    #[error("recording_card_not_owned")]
    Denied,
    #[error("recording_card_verification_unavailable")]
    Unavailable,
}

impl CardAccount {
    pub(super) fn from_access(access: &CardAccess) -> Result<Self, OwnershipError> {
        let raw_url = access.api_base_url.trim().trim_end_matches('/');
        let gateway = match raw_url {
            s if s.eq_ignore_ascii_case("https://api.lynse.cn") => "https://api.lynse.cn",
            s if s.eq_ignore_ascii_case("https://api-en.lynse.ai") => "https://api-en.lynse.ai",
            s if s.eq_ignore_ascii_case("https://gapp.lynse.cn") => "https://gapp.lynse.cn",
            s if s.eq_ignore_ascii_case("https://api.lynse.ai") => "https://api-en.lynse.ai",
            s if s.contains("lynse.cn") || s.contains("lynse.ai") => {
                log::info!("[recording-card] normalized api_base_url {s:?}");
                if s.contains("gapp.lynse.cn") {
                    "https://gapp.lynse.cn"
                } else if s.contains("lynse.ai") {
                    "https://api-en.lynse.ai"
                } else {
                    "https://api.lynse.cn"
                }
            }
            other => {
                log::warn!("[recording-card] unrecognized api_base_url: {other:?}");
                return Err(OwnershipError::Unavailable);
            }
        };
        if access.token.trim().is_empty() {
            log::warn!("[recording-card] from_access: empty token");
            return Err(OwnershipError::AccountRequired);
        }
        Ok(Self {
            gateway,
            session: Sha256::digest(access.token.trim().as_bytes()).into(),
        })
    }

    pub(super) fn credential_gateway(&self, access: &CardAccess) -> String {
        if let Some(agent) = &access.agent_base_url {
            let trimmed = agent.trim().trim_end_matches('/');
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
        if let Some(gw) = &access.gateway_url {
            let trimmed = gw.trim().trim_end_matches('/');
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
        "https://lynclaw-api-319577-10-1401959758.sh.run.tcloudbase.com".to_string()
    }

    pub(super) async fn fetch_credential(
        &self,
        access: &CardAccess,
        vendor_id: Option<u16>,
        product_id: Option<u16>,
    ) -> Result<CardCredential, OwnershipError> {
        let clean_token = access.token.trim();
        let auth_str = if clean_token.to_ascii_lowercase().starts_with("bearer ") {
            clean_token.to_string()
        } else {
            format!("Bearer {}", clean_token)
        };
        let mut token_header = HeaderValue::from_str(&auth_str).map_err(|e| {
            log::warn!("[recording-card] invalid token header: {e}");
            OwnershipError::AccountRequired
        })?;
        token_header.set_sensitive(true);

        let gateway_origin = self.credential_gateway(access);
        let endpoint = format!("{}/api/desktop/recording-card/config", gateway_origin);

        let send_req = |client: &reqwest::Client| {
            client
                .get(&endpoint)
                .header(AUTHORIZATION, token_header.clone())
                .header(CACHE_CONTROL, "no-cache, no-store")
                .send()
        };

        // Attempt with certificate-pinned secure client first, but gracefully fall back
        // to standard client if Schannel (Windows) or proxy causes TLS handshake failure.
        let mut response = match SECURE_CLIENT.as_ref() {
            Ok(sec_client) => match send_req(sec_client).await {
                Ok(resp) => resp,
                Err(e) => {
                    log::warn!("[recording-card] secure client credential fetch failed: {e}, attempting fallback to standard client");
                    let std_client = CLIENT.as_ref().map_err(|err| {
                        log::error!("[recording-card] standard client init failed: {err}");
                        OwnershipError::Unavailable
                    })?;
                    send_req(std_client).await.map_err(|fallback_err| {
                        log::error!("[recording-card] fallback credential fetch failed: {fallback_err}");
                        OwnershipError::Unavailable
                    })?
                }
            },
            Err(sec_err) => {
                log::warn!("[recording-card] secure client unavailable: {sec_err}, using standard client");
                let std_client = CLIENT.as_ref().map_err(|err| {
                    log::error!("[recording-card] standard client init failed: {err}");
                    OwnershipError::Unavailable
                })?;
                send_req(std_client).await.map_err(|e| {
                    log::error!("[recording-card] credential fetch failed: {e}");
                    OwnershipError::Unavailable
                })?
            }
        };

        // If the assistant config route returned 404, attempt fallback to legacy MCP credential route
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            let mcp_origin = match self.gateway {
                "https://api.lynse.cn" | "https://gapp.lynse.cn" => "https://www.lynse.cn",
                "https://api-en.lynse.ai" => "https://www.lynse.ai",
                other => other,
            };
            let mcp_endpoint = format!(
                "{}/platform/oauth/api/agent/device/recording-card/credential",
                mcp_origin
            );
            if let Ok(std_client) = CLIENT.as_ref() {
                let mut req = std_client
                    .post(&mcp_endpoint)
                    .header(AUTHORIZATION, token_header.clone())
                    .header(CACHE_CONTROL, "no-cache, no-store");
                if let (Some(vid), Some(pid)) = (vendor_id, product_id) {
                    req = req.json(&serde_json::json!({ "vendorId": vid, "productId": pid }));
                }
                if let Ok(resp) = req.send().await {
                    response = resp;
                }
            }
        }

        match response.status().as_u16() {
            401 => {
                log::warn!("[recording-card] credential fetch: 401 Unauthorized");
                return Err(OwnershipError::AccountRequired);
            }
            403 => {
                let payload: Value = response.json().await.unwrap_or_default();
                log::warn!("[recording-card] credential fetch: 403 Forbidden ({payload:?})");
                if payload.get("detail").and_then(Value::as_str) == Some("recording_card_not_bound") {
                    return Err(OwnershipError::NotBound);
                }
                return Err(OwnershipError::Denied);
            }
            429 => {
                log::warn!("[recording-card] rate limit exceeded on credential fetch");
                return Err(OwnershipError::Unavailable);
            }
            200 => {}
            status => {
                log::warn!("[recording-card] credential fetch unexpected HTTP status: {status}");
                return Err(OwnershipError::Unavailable);
            }
        }

        let payload: Value = response.json().await.map_err(|e| {
            log::warn!("[recording-card] credential response JSON parse error: {e}");
            OwnershipError::Unavailable
        })?;
        let password_str = match payload.get("password").and_then(Value::as_str) {
            Some(p) => p,
            None => {
                log::warn!("[recording-card] credential payload missing 'password': {payload:?}");
                return Err(OwnershipError::Unavailable);
            }
        };
        if password_str.len() < 8 || password_str.len() > 64 || password_str.contains('#') {
            log::warn!("[recording-card] credential payload invalid password length or content");
            return Err(OwnershipError::Unavailable);
        }

        let vid = payload
            .get("vendorId")
            .and_then(Value::as_u64)
            .and_then(|v| u16::try_from(v).ok())
            .unwrap_or(0x3654);
        let pid = payload
            .get("productId")
            .and_then(Value::as_u64)
            .and_then(|p| u16::try_from(p).ok())
            .unwrap_or(0x4155);

        Ok(CardCredential {
            password: Zeroizing::new(password_str.to_string()),
            vendor_id: vid,
            product_id: pid,
        })
    }

    pub(super) async fn verify(
        &self,
        access: &CardAccess,
        identity: &CardIdentity,
    ) -> Result<(), OwnershipError> {
        let client = CLIENT.as_ref().map_err(|e| {
            log::error!("[recording-card] CLIENT unavailable for verify: {e}");
            OwnershipError::Unavailable
        })?;
        let mut token =
            HeaderValue::from_str(access.token.trim()).map_err(|e| {
                log::warn!("[recording-card] invalid token header in verify: {e}");
                OwnershipError::AccountRequired
            })?;
        token.set_sensitive(true);
        let url = format!("{}/api/business/device/mine", self.gateway);
        let response = client
            .get(&url)
            .header(AUTHORIZATION, token)
            .header(CACHE_CONTROL, "no-cache, no-store")
            .send()
            .await
            .map_err(|e| {
                log::warn!("[recording-card] verify request failed to {url}: {e}");
                OwnershipError::Unavailable
            })?;
        match response.status().as_u16() {
            401 | 403 => {
                log::warn!("[recording-card] verify request unauthorized: {}", response.status());
                return Err(OwnershipError::AccountRequired);
            }
            200 => {}
            status => {
                log::warn!("[recording-card] verify request unexpected status: {status}");
                return Err(OwnershipError::Unavailable);
            }
        }
        let payload: Value = response
            .json()
            .await
            .map_err(|e| {
                log::warn!("[recording-card] verify response JSON parse error: {e}");
                OwnershipError::Unavailable
            })?;
        verify_bindings(identity, &payload)
    }
}

fn verify_bindings(identity: &CardIdentity, payload: &Value) -> Result<(), OwnershipError> {
    match payload.get("code").and_then(Value::as_i64) {
        Some(2000 | 2013) => {
            log::warn!("[recording-card] verify_bindings got auth code: {:?}", payload.get("code"));
            return Err(OwnershipError::AccountRequired);
        }
        Some(200) => {}
        other => {
            log::warn!("[recording-card] verify_bindings unexpected code: {other:?}, payload: {payload:?}");
            return Err(OwnershipError::Unavailable);
        }
    }
    let rows = payload
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            log::warn!("[recording-card] verify_bindings 'data' is not an array: {payload:?}");
            OwnershipError::Unavailable
        })?;
    if rows.iter().any(|row| matches_binding(identity, row)) {
        Ok(())
    } else {
        log::warn!(
            "[recording-card] verify_bindings: device (authSn={}, bleMac={}) not found in user's bound devices ({})",
            identity.auth_sn,
            identity.ble_mac,
            rows.len()
        );
        Err(OwnershipError::Denied)
    }
}
extern "C" {
    fn rc_owner_match_v1(input: *const u8, length: usize, bind_status: i32) -> i32;
}

fn matches_binding(identity: &CardIdentity, row: &Value) -> bool {
    let Some(mac) = row.get("macAddress").and_then(Value::as_str) else {
        return false;
    };
    let Some(status) = row
        .get("bindStatus")
        .and_then(Value::as_i64)
        .and_then(|n| i32::try_from(n).ok())
    else {
        return false;
    };
    let auth_sn = match row.get("authSn") {
        None | Some(Value::Null) => "",
        Some(Value::String(value)) => value,
        _ => return false,
    };
    let fields = [
        identity.auth_sn.as_str(),
        identity.ble_mac.as_str(),
        auth_sn,
        mac,
    ];
    let mut input = Vec::with_capacity(516);
    for field in fields {
        if field.len() > 128 || field.as_bytes().contains(&0) {
            return false;
        }
        input.extend_from_slice(field.as_bytes());
        input.push(0);
    }
    // The verifier reads only the supplied bytes during the synchronous call.
    unsafe { rc_owner_match_v1(input.as_ptr(), input.len(), status) == 1 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn card() -> CardIdentity {
        CardIdentity {
            auth_sn: "CARD-123".into(),
            ble_mac: "12:34:56:78:9A:BC".into(),
        }
    }

    #[test]
    fn the_linked_verifier_accepts_current_and_legacy_bindings() {
        for auth_sn in [json!("CARD-123"), Value::Null] {
            let payload = json!({"code": 200, "data": [{
                "authSn": auth_sn, "macAddress": "123456789aBC", "bindStatus": 1
            }]});
            assert!(verify_bindings(&card(), &payload).is_ok());
        }
    }

    #[test]
    fn the_linked_verifier_denies_wrong_inactive_and_malformed_bindings() {
        for row in [
            json!({"authSn": "CARD-123", "macAddress": "12:34:56:78:9A:BD", "bindStatus": 1}),
            json!({"authSn": "DIFFERENT", "macAddress": "123456789abc", "bindStatus": 1}),
            json!({"macAddress": "123456789abc", "bindStatus": 0}),
            json!({"macAddress": "12:34:56:78:9A:BC\0", "bindStatus": 1}),
        ] {
            let payload = json!({"code": 200, "data": [row]});
            assert!(matches!(
                verify_bindings(&card(), &payload),
                Err(OwnershipError::Denied)
            ));
        }
    }

    #[test]
    fn an_expired_login_or_bad_response_cannot_grant_access() {
        assert!(matches!(
            verify_bindings(&card(), &json!({"code": 2000})),
            Err(OwnershipError::AccountRequired)
        ));
        assert!(matches!(
            verify_bindings(&card(), &json!({"code": 200, "data": {}})),
            Err(OwnershipError::Unavailable)
        ));
    }

    #[tokio::test]
    #[ignore = "requires live network"]
    async fn test_secure_client_fetch_credential() {
        let client = SECURE_CLIENT.as_ref().expect("SECURE_CLIENT failed to init");
        let res = client
            .post("https://www.lynse.cn/platform/oauth/api/agent/device/recording-card/credential")
            .send()
            .await;
        println!("Result: {:?}", res);
        assert!(res.is_ok(), "Request failed: {:?}", res.err());
    }
}
