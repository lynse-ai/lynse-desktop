use super::*;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
};

struct Server {
    url: String,
    paths: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl Server {
    fn start(reply: impl Fn(&str) -> (u16, Value, Option<u64>) + Send + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let paths = Arc::new(Mutex::new(Vec::new()));
        let captured = paths.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let ending = stop.clone();
        let worker = std::thread::spawn(move || {
            while !ending.load(Ordering::SeqCst) {
                let Ok((mut stream, _)) = listener.accept() else {
                    std::thread::sleep(Duration::from_millis(5));
                    continue;
                };
                // Accepted sockets can inherit the listener's nonblocking mode on macOS.
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut input = Vec::new();
                let mut buffer = [0u8; 4096];
                loop {
                    let Ok(size) = stream.read(&mut buffer) else {
                        break;
                    };
                    if size == 0 {
                        break;
                    }
                    input.extend_from_slice(&buffer[..size]);
                    if let Some(end) = input.windows(4).position(|v| v == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&input[..end]);
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|v| v.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if input.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                let input = String::from_utf8_lossy(&input);
                let path = input
                    .lines()
                    .next()
                    .unwrap_or("")
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or("");
                captured.lock().unwrap().push(path.to_owned());
                let (status, body, retry) = reply(path);
                let body = body.to_string();
                let retry = retry
                    .map(|value| format!("Retry-After: {value}\r\n"))
                    .unwrap_or_default();
                let _ = write!(stream, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{retry}Connection: close\r\n\r\n{body}", body.len());
            }
        });
        Self {
            url,
            paths,
            stop,
            worker: Some(worker),
        }
    }
    fn count(&self, path: &str) -> usize {
        self.paths
            .lock()
            .unwrap()
            .iter()
            .filter(|p| *p == path)
            .count()
    }
    fn session(&self) -> Session {
        Session {
            scope: "scope-a".into(),
            user_id: "alice".into(),
            base_url: "https://business.invalid".into(),
            agent_url: self.url.clone(),
            token: "private-test-token".into(),
            generation: 1,
            locale: "zh".into(),
            model_override: None,
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.worker.take().unwrap().join().unwrap();
    }
}
fn transport() -> Transport {
    let transport = Transport::default();
    assert!(transport
        .client
        .set(Ok(reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap()))
        .is_ok());
    transport
}
fn binding() -> Value {
    json!({"user_id":"alice", "host":"https://business.invalid"})
}

#[tokio::test]
async fn concurrent_reads_share_verified_binding_and_expired_or_changed_sessions_rebind() {
    let server = Server::start(|path| {
        (
            200,
            if path == "/api/session/backend" {
                binding()
            } else {
                json!({"available":true})
            },
            None,
        )
    });
    let transport = transport();
    let mut session = server.session();
    let (a, b) = tokio::join!(
        transport.request(&session, "/capabilities", None, None, || Ok(())),
        transport.request(&session, "/capabilities", None, None, || Ok(()))
    );
    assert!(a.unwrap()["available"] == true && b.unwrap()["available"] == true);
    assert_eq!(server.count("/api/session/backend"), 1);
    transport.binding.lock().await.as_mut().unwrap().1 = Instant::now() - Duration::from_secs(1);
    transport
        .request(&session, "/capabilities", None, None, || Ok(()))
        .await
        .unwrap();
    session.generation += 1;
    transport
        .request(&session, "/capabilities", None, None, || Ok(()))
        .await
        .unwrap();
    session.token = "rotated-test-token".into();
    transport
        .request(&session, "/capabilities", None, None, || Ok(()))
        .await
        .unwrap();
    assert_eq!(server.count("/api/session/backend"), 4);
}

#[tokio::test]
async fn temporary_read_failure_recovers_without_poisoning_the_binding() {
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let server = Server::start(move |path| {
        if path == "/api/session/backend" {
            return (200, binding(), None);
        }
        let status = if count.fetch_add(1, Ordering::SeqCst) < 2 {
            503
        } else {
            200
        };
        (status, json!({"available":true}), None)
    });
    let transport = transport();
    let session = server.session();
    let error = transport
        .request(&session, "/capabilities", None, None, || Ok(()))
        .await
        .unwrap_err();
    assert_eq!(server.count("/api/memory/capabilities"), 2, "{error}");
    assert!(error.contains("HTTP 503") && error.contains("stage: capabilities"));
    assert!(
        transport
            .request(&session, "/capabilities", None, None, || Ok(()))
            .await
            .unwrap()["available"]
            == true
    );
    assert_eq!(server.count("/api/session/backend"), 1);
}

#[tokio::test]
async fn auth_denials_and_writes_are_never_automatically_replayed() {
    for status in [401, 403, 409, 503] {
        let server = Server::start(move |path| {
            if path == "/api/session/backend" {
                (200, binding(), None)
            } else {
                (status, json!({}), None)
            }
        });
        let transport = transport();
        let session = server.session();
        transport
            .request(
                &session,
                "/preferences/actions",
                Some(json!({"knowledge":{}})),
                Some("operation"),
                || Ok(()),
            )
            .await
            .unwrap_err();
        assert_eq!(server.count("/api/memory/preferences/actions"), 1);
        if status == 401 || status == 403 {
            assert!(transport.binding.lock().await.is_none());
        }
    }
    for status in [401, 403] {
        let server = Server::start(move |path| {
            if path == "/api/session/backend" {
                (200, binding(), None)
            } else {
                (status, json!({}), None)
            }
        });
        let transport = transport();
        transport
            .request(&server.session(), "/capabilities", None, None, || Ok(()))
            .await
            .unwrap_err();
        assert_eq!(server.count("/api/memory/capabilities"), 1);
    }
}

#[tokio::test]
async fn retry_after_is_respected_across_requests_without_waiting_past_the_budget() {
    let server = Server::start(|path| {
        if path == "/api/session/backend" {
            (200, binding(), None)
        } else {
            (429, json!({}), Some(60))
        }
    });
    let transport = transport();
    let session = server.session();
    for _ in 0..2 {
        let error = transport
            .request(&session, "/capabilities", None, None, || Ok(()))
            .await
            .unwrap_err();
        assert!(error.contains("HTTP 429"));
    }
    assert_eq!(server.count("/api/memory/capabilities"), 1);
    assert_eq!(retry_after("2"), Some(Duration::from_secs(2)));
    assert!(retry_after("Thu, 01 Jan 1970 00:00:00 GMT").is_some());
    assert!(retry_after("bad").is_none());
}

#[tokio::test]
async fn binding_mismatch_never_reads_cloud_data_or_caches_the_result() {
    let server = Server::start(|_| {
        (
            200,
            json!({"user_id":"other", "host":"https://business.invalid"}),
            None,
        )
    });
    let transport = transport();
    assert!(transport
        .request(&server.session(), "/capabilities", None, None, || Ok(()))
        .await
        .unwrap_err()
        .contains("identity mismatch"));
    assert!(transport.binding.lock().await.is_none());
    assert_eq!(server.count("/api/memory/capabilities"), 0);
}

#[tokio::test]
async fn session_changes_discard_inflight_bindings_before_reading_data() {
    let current = Arc::new(AtomicBool::new(true));
    let flag = current.clone();
    let server = Server::start(move |_| {
        flag.store(false, Ordering::SeqCst);
        (200, binding(), None)
    });
    let transport = transport();
    let error = transport
        .request(&server.session(), "/capabilities", None, None, || {
            if current.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err("Account or consent changed; result discarded".into())
            }
        })
        .await
        .unwrap_err();
    assert!(error.contains("Account or consent changed"));
    assert!(transport.binding.lock().await.is_none());
    assert_eq!(server.count("/api/memory/capabilities"), 0);
}

#[test]
fn only_connection_failures_can_trigger_automatic_recovery() {
    for error in [
        "Cloud knowledge offline",
        "Cloud knowledge request failed (HTTP 503) [stage: capabilities]",
        "Cloud knowledge connection failed (stage: identity_binding; reason: timeout)",
    ] {
        assert!(transient(error));
    }
    for error in [
        "Cloud knowledge identity verification failed",
        "Cloud knowledge request failed (HTTP 403)",
        "Cloud knowledge request failed (HTTP 409)",
        "Cloud knowledge request failed (HTTP 501)",
        "Lynclaw synthesis request outcome is unknown",
        "Citation does not match source evidence",
    ] {
        assert!(!transient(error));
    }
}

#[tokio::test]
async fn transport_errors_include_safe_phase_codes_and_do_not_expose_request_details() {
    let transport = transport();
    let server = Server::start(|_| (200, binding(), None));
    let mut session = server.session();
    drop(server);
    session.agent_url.push_str("/private-path");
    let error = transport
        .request(&session, "/capabilities", None, None, || Ok(()))
        .await
        .unwrap_err();
    assert!(error.contains("stage: identity_binding") && error.contains("reason: connect"));
    assert!(
        !error.contains("private-path")
            && !error.contains("private-test-token")
            && !error.contains("127.0.0.1")
    );
}
