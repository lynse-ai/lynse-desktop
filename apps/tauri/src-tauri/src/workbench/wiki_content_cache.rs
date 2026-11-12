//! Content identities and quotation rebinding never grant access to a source.
use super::*;

pub(super) fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(fields) => {
            let reference = fields.contains_key("quote") && fields.contains_key("id");
            Value::Object(
                fields
                    .iter()
                    .filter(|(key, _)| {
                        !reference
                            || !matches!(
                                key.as_str(),
                                "revision" | "segmentId" | "startMs" | "endMs"
                            )
                    })
                    .map(|(key, value)| (key.clone(), canonical(value)))
                    .collect(),
            )
        }
        Value::Array(rows) => json!(rows.iter().map(canonical).collect::<Vec<_>>()),
        _ => value.clone(),
    }
}

pub(super) fn rebind(
    mut value: Value,
    docs: &[Document],
    manifest: &Manifest,
) -> CommandResult<Value> {
    fn walk(value: &mut Value, docs: &[Document], manifest: &Manifest) -> CommandResult<()> {
        match value {
            Value::Object(fields) if fields.contains_key("quote") => {
                let doc = docs
                    .iter()
                    .find(|doc| {
                        fields.get("id").and_then(Value::as_str) == Some(&doc.id)
                            && fields
                                .get("kind")
                                .and_then(Value::as_str)
                                .is_none_or(|kind| kind == doc.kind)
                    })
                    .ok_or("Cached evidence source is unavailable")?;
                let quote = fields
                    .get("quote")
                    .and_then(Value::as_str)
                    .filter(|quote| !quote.trim().is_empty())
                    .ok_or("Cached evidence has no quotation")?;
                if !automation::allows(doc, manifest) || !doc.text().contains(quote) {
                    return Err("Cached quotation no longer matches an authorized source".into());
                }
                let segment = fields
                    .get("startMs")
                    .and_then(Value::as_u64)
                    .and_then(|start| {
                        doc.segments.iter().find(|segment| {
                            segment["startMs"].as_u64() == Some(start)
                                && segment["text"]
                                    .as_str()
                                    .or_else(|| segment["recognizedText"].as_str())
                                    .is_some_and(|text| text.contains(quote))
                        })
                    });
                if doc.kind == "meeting_summary" || segment.is_none() {
                    for field in ["segmentId", "startMs", "endMs"] {
                        fields.remove(field);
                    }
                } else if let Some(segment) = segment {
                    if let Some(id) = segment["id"].as_str().filter(|id| !id.is_empty()) {
                        fields.insert("segmentId".into(), json!(id));
                    } else {
                        fields.remove("segmentId");
                    }
                    if let Some(end) = segment["endMs"]
                        .as_u64()
                        .filter(|end| Some(*end) >= segment["startMs"].as_u64())
                    {
                        fields.insert("endMs".into(), json!(end));
                    } else {
                        fields.remove("endMs");
                    }
                }
                fields.insert("revision".into(), json!(doc.revision));
                fields.insert("kind".into(), json!(doc.kind));
                sync::validate_result(
                    std::slice::from_ref(doc),
                    manifest,
                    &json!({"citations":[fields]}),
                )?;
            }
            Value::Object(fields) => {
                for child in fields.values_mut() {
                    walk(child, docs, manifest)?;
                }
            }
            Value::Array(rows) => {
                for child in rows {
                    walk(child, docs, manifest)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    walk(&mut value, docs, manifest)?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn model_identity_ignores_credentials_but_tracks_actual_default_model_and_processor() {
        let mut session = Session {
            scope: "scope".into(),
            user_id: "user".into(),
            base_url: "https://business.invalid".into(),
            agent_url: "https://agent.invalid".into(),
            token: "test".into(),
            generation: 1,
            locale: "zh".into(),
            model_override: Some(json!({"preset":"provider","model":"model-a","apiKey":"first"})),
        };
        let profile = json!({"processorVersion":"desktop-evidence-v2","model":"default-a","provider":"https://provider.invalid"});
        let first = text_model_revision(&session, Some(&profile));
        session.model_override.as_mut().unwrap()["apiKey"] = json!("rotated");
        assert_eq!(text_model_revision(&session, Some(&profile)), first);
        session.model_override = None;
        let default = text_model_revision(&session, Some(&profile));
        let mut changed = profile.clone();
        changed["model"] = json!("default-b");
        assert_ne!(text_model_revision(&session, Some(&changed)), default);
        // Direct mode: the desktop is the processor, so the server profile's
        // processorVersion no longer moves the direct revision — processor
        // identity is the separation between direct and gateway revisions.
        changed = profile.clone();
        changed["processorVersion"] = json!("desktop-evidence-v3");
        assert_eq!(text_model_revision(&session, Some(&changed)), default);
        assert_ne!(gateway_text_model_revision(&session, Some(&profile)), default);
        assert_ne!(
            gateway_text_model_revision(&session, Some(&profile)),
            gateway_text_model_revision(&session, Some(&changed))
        );
    }
    #[test]
    fn rebinding_accepts_metadata_changes_but_never_changed_or_revoked_quotes() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let mut doc = Document {
            id: "source".into(),
            kind: "meeting".into(),
            transcript: "A supported decision".into(),
            ai_context_enabled: true,
            ..Default::default()
        };
        doc.refresh_revision();
        let old = json!({"citations":[{"id":doc.id,"kind":doc.kind,"revision":doc.revision,"quote":"A supported decision","startMs":100}]});
        doc.folder_id = "new-folder".into();
        doc.refresh_revision();
        let mut manifest = Manifest::default();
        manifest.entries.insert(
            doc.id.clone(),
            store::write_document(&root, &doc, None).unwrap(),
        );
        let rebound = rebind(old.clone(), &[doc.clone()], &manifest).unwrap();
        assert_eq!(rebound["citations"][0]["revision"], doc.revision);
        assert!(rebound["citations"][0].get("startMs").is_none());
        assert_eq!(canonical(&old), canonical(&rebound));
        doc.transcript = "Different evidence".into();
        assert!(rebind(old.clone(), &[doc.clone()], &manifest).is_err());
        doc.ai_context_enabled = false;
        assert!(rebind(old, &[doc], &manifest).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
