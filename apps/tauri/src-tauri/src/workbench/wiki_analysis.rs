//! Bounded recovery for model citations without weakening source validation.
use super::*;
use std::future::Future;

const RECOVERY_CHARS: usize = 4_000;

pub(super) fn part(doc: &Document, text: String) -> Document {
    let mut part = doc.clone();
    part.transcript = text;
    part.outline.clear();
    part.conclusions.clear();
    part.todos.clear();
    part.segments.retain(|segment| {
        segment["text"]
            .as_str()
            .or_else(|| segment["recognizedText"].as_str())
            .is_some_and(|text| !text.is_empty() && part.transcript.contains(text))
    });
    part
}

pub(super) async fn with_recovery<F, Fut>(
    document: Document,
    mut analyze: F,
) -> CommandResult<Vec<Value>>
where
    F: FnMut(Document) -> Fut,
    Fut: Future<Output = CommandResult<Value>>,
{
    match analyze(document.clone()).await {
        Ok(value) => return Ok(vec![value]),
        Err(error) => {
            let citation_failure = error
                == "Lynclaw synthesis failed (HTTP 422): Citation does not match source evidence"
                || error == "AI citation does not match the original source";
            if !citation_failure || document.transcript.chars().count() <= RECOVERY_CHARS {
                return Err(error);
            }
        }
    }
    // Each smaller part still passes the same remote and local evidence checks.
    // The caller caches each part, so a later retry reuses successful work.
    let mut results = Vec::new();
    for text in sync::split_text(&document.transcript, RECOVERY_CHARS) {
        if !text.trim().is_empty() {
            results.push(analyze(part(&document, text)).await?);
        }
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    const CITATION_ERROR: &str =
        "Lynclaw synthesis failed (HTTP 422): Citation does not match source evidence";

    #[tokio::test]
    async fn long_source_recovers_with_complete_ordered_evidence_and_valid_segments() {
        let document = Document {
            id: "meeting".into(),
            revision: "original-revision".into(),
            transcript: format!(
                "{}{}{}",
                "甲".repeat(4000),
                "乙".repeat(4000),
                "丙".repeat(500)
            ),
            segments: vec![
                json!({"id":"first","text":"甲甲","startMs":0}),
                json!({"id":"last","text":"丙丙","startMs":12000}),
            ],
            ..Default::default()
        };
        let seen = RefCell::new(Vec::new());
        let results = with_recovery(document.clone(), |part| {
            seen.borrow_mut().push(part.clone());
            async move {
                if part.transcript.chars().count() > RECOVERY_CHARS {
                    Err(CITATION_ERROR.into())
                } else {
                    Ok(json!({"summary":part.transcript,"citations":[{"id":part.id,"revision":part.revision}]}))
                }
            }
        }).await.unwrap();
        assert_eq!(seen.borrow().len(), 4);
        assert_eq!(
            results
                .iter()
                .map(|v| v["summary"].as_str().unwrap())
                .collect::<String>(),
            document.transcript
        );
        for part in seen.borrow().iter().skip(1) {
            assert_eq!(part.revision, document.revision);
            assert!(part
                .segments
                .iter()
                .all(|s| part.transcript.contains(s["text"].as_str().unwrap())));
        }
    }

    #[tokio::test]
    async fn recovery_keeps_failures_visible_and_does_not_retry_network_or_short_sources() {
        for (length, error, expected_calls) in [
            (12000, CITATION_ERROR, 2),
            (4000, CITATION_ERROR, 1),
            (12000, "Lynclaw model service is unavailable", 1),
            (12000, "Source changed during analysis", 1),
        ] {
            let calls = std::cell::Cell::new(0);
            let result = with_recovery(
                Document {
                    transcript: "字".repeat(length),
                    ..Default::default()
                },
                |_| {
                    calls.set(calls.get() + 1);
                    async { Err(error.to_owned()) }
                },
            )
            .await;
            assert_eq!(result.unwrap_err(), error);
            assert_eq!(calls.get(), expected_calls);
        }
    }

    #[tokio::test]
    async fn recovered_parts_are_revalidated_and_reused_after_an_interrupted_attempt() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let local = root.join("meetings");
        let mut document = Document {
            id: "meeting".into(),
            kind: "meeting".into(),
            transcript: format!("{}{}", "甲".repeat(4000), "乙".repeat(4000)),
            ai_context_enabled: true,
            ..Default::default()
        };
        document.refresh_revision();
        let mut manifest = Manifest::default();
        manifest.entries.insert(
            document.id.clone(),
            store::write_document(&local, &document, None).unwrap(),
        );
        let serial = tokio::sync::Mutex::new(());
        let generated = RefCell::new(Vec::new());
        for attempt in 0..2 {
            let result = with_recovery(document.clone(), |part| {
                let root = &root;
                let manifest = &manifest;
                let serial = &serial;
                let generated = &generated;
                async move {
                    let key = store::digest(&part.transcript);
                    cached_compilation(root, &key, serial, |value| sync::validate_result(std::slice::from_ref(&part), manifest, value), true, async {
                        generated.borrow_mut().push(part.transcript.chars().next().unwrap());
                        if part.transcript.chars().count() > RECOVERY_CHARS {
                            return Err(CITATION_ERROR.into());
                        }
                        let quote = if attempt == 0 && part.transcript.starts_with('乙') {
                            "Invented evidence".to_owned()
                        } else {
                            part.transcript.chars().take(10).collect()
                        };
                        Ok(json!({"summary":"Supported statement", "citations":[{"id":part.id,"revision":part.revision,"kind":part.kind,"quote":quote}]}))
                    }).await
                }
            }).await;
            if attempt == 0 {
                assert_eq!(
                    result.unwrap_err(),
                    "AI citation does not match the original source"
                );
            } else {
                assert_eq!(result.unwrap().len(), 2);
            }
        }
        // The first small part is generated once; the invalid second part is regenerated.
        assert_eq!(*generated.borrow(), vec!['甲', '甲', '乙', '甲', '乙']);
        fs::remove_dir_all(root).unwrap();
    }
}
