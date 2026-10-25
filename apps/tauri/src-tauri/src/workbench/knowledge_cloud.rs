//! Verified cloud policy and source authority for automatic AI reads.
use super::*;
use std::collections::BTreeSet;
use base64::{engine::general_purpose::STANDARD, Engine};

pub(super) async fn request(
    app: &AppHandle,
    session: &Session,
    path: &str,
    body: Option<Value>,
    operation: Option<&str>,
) -> CommandResult<Value> {
    require_current(&app.state::<WorkbenchState>(), session)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(35))
        .redirect(reqwest::redirect::Policy::none())
        .build().map_err(|_| "Cloud knowledge unavailable")?;
    if session.agent_url != session.base_url {
        let response = client.post(format!("{}/api/session/backend", session.agent_url))
            .header("Authorization", &session.token).json(&json!({"host":session.base_url}))
            .send().await.map_err(|_| "Cloud knowledge offline")?;
        require_current(&app.state::<WorkbenchState>(), session)?;
        if !response.status().is_success() { return Err("Cloud knowledge identity verification failed".into()); }
        let binding: Value = response.json().await.map_err(|_| "Invalid knowledge identity response")?;
        if binding["user_id"].as_str() != Some(&session.user_id)
            || binding["host"].as_str().map(|host| host.trim_end_matches('/')) != Some(session.base_url.trim_end_matches('/')) {
            return Err("Cloud knowledge identity mismatch".into());
        }
    }
    let prefix = if session.agent_url == session.base_url { "/api/business/ai/memory" } else { "/api/memory" };
    let url = format!("{}{prefix}{path}", session.agent_url);
    let mut call = if body.is_some() { client.post(url) } else { client.get(url) }
        .header("Authorization", &session.token);
    if let Some(body) = body { call = call.json(&body); }
    if let Some(operation) = operation { call = call.header("Operation-Id", operation); }
    let response = call.send().await.map_err(|_| "Cloud knowledge offline")?;
    require_current(&app.state::<WorkbenchState>(), session)?;
    if response.status() == reqwest::StatusCode::CONFLICT { return Err("Cloud knowledge policy changed; reload before saving".into()); }
    if !response.status().is_success() { return Err("Cloud knowledge capability unavailable or authorization rejected".into()); }
    let value = response.json().await.map_err(|_| "Invalid cloud knowledge response")?;
    require_current(&app.state::<WorkbenchState>(), session)?;
    Ok(value)
}

pub(super) fn source_id(id: &str) -> String {
    id.strip_prefix("local:").map(|value| format!("desktop:{value}")).unwrap_or_else(|| id.to_owned())
}

pub(super) fn local_allows(doc: &Document, manifest: &Manifest) -> bool {
    let policy = manifest.knowledge_pending.as_ref().and_then(|pending| pending.get("policy"))
        .or(manifest.knowledge_policy.as_ref());
    let Some(policy) = policy else { return true; };
    if policy["enrolled"] != true { return false; }
    if policy["excluded_source_ids"].as_array().is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(&source_id(&doc.id)))) {
        return false;
    }
    if doc.folder_id.is_empty() { policy["include_unfiled"] == true }
    else { policy["folder_ids"].as_array().is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(&doc.folder_id))) }
}

pub(super) async fn authorize(
    app: &AppHandle, session: &Session, documents: &[Document], purpose: &str,
) -> CommandResult<()> {
    if documents.iter().any(|doc| crate::inspiration_private::source_is_protected(app, &doc.id)) { return Err("Encrypted inspirations are unavailable to AI".into()); }
    let sources: Vec<_> = documents.iter().map(|doc| json!({"source_id":source_id(&doc.id),
        "folder_id":doc.folder_id,"local":doc.id.starts_with("local:"),"revision":doc.revision})).collect();
    let result = request(app,session,"/source-eligibility",Some(json!({"sources":sources,"purpose":purpose})),None).await?;
    let allowed = result["allowed_source_ids"].as_array().ok_or("Cloud source eligibility unavailable")?;
    if documents.iter().any(|doc|crate::inspiration_private::source_is_protected(app,&doc.id)) { return Err("Encrypted inspirations are unavailable to AI".into()); }
    if documents.iter().any(|doc| !allowed.iter().any(|value| value.as_str() == Some(&source_id(&doc.id)))) {
        return Err("A source is outside the current cloud policy or stopped from automatic use".into());
    }
    Ok(())
}

pub(super) async fn filter_items(app: &AppHandle, session: &Session, items: Vec<Value>) -> CommandResult<Vec<Value>> {
    if items.is_empty() { return Ok(items); }
    let manifest = load_state(app,session)?;
    let (root,_) = roots(app,session)?;
    let mut identifiers = BTreeSet::new();
    for item in &items {
        if item["kind"] == "wiki" || item["document"]["kind"] == "wiki" {
            if let Some(refs) = item["citations"].as_array().or(item["document"]["citations"].as_array()) {
                for reference in refs { if let Some(id) = reference["id"].as_str() { identifiers.insert(id.to_owned()); } }
            }
        } else if let Some(id) = item["id"].as_str().or(item["document"]["id"].as_str()) { identifiers.insert(id.to_owned()); }
    }
    let docs: Vec<_> = identifiers.iter().filter_map(|id| manifest.entries.get(id))
        .filter_map(|entry| store::read_document(&root,entry).ok()).filter(|doc| local_allows(doc,&manifest) && !crate::inspiration_private::source_is_protected(app,&doc.id)).collect();
    let sources: Vec<_> = docs.iter().map(|doc| json!({"source_id":source_id(&doc.id),"folder_id":doc.folder_id,
        "local":doc.id.starts_with("local:"),"revision":doc.revision})).collect();
    let result = request(app,session,"/source-eligibility",Some(json!({"sources":sources})),None).await?;
    let allowed = result["allowed_source_ids"].as_array().ok_or("Cloud source eligibility unavailable")?;
    let allowed = |id: &str| docs.iter().any(|doc| doc.id == id)
        && allowed.iter().any(|value| value.as_str() == Some(&source_id(id)));
    Ok(items.into_iter().filter(|item| {
        if item["kind"] == "wiki" || item["document"]["kind"] == "wiki" {
            item["citations"].as_array().or(item["document"]["citations"].as_array())
                .is_some_and(|refs| !refs.is_empty() && refs.iter().all(|reference| reference["id"].as_str().is_some_and(allowed)))
        } else { item["id"].as_str().or(item["document"]["id"].as_str()).is_some_and(allowed) }
    }).collect())
}

pub(super) async fn policy_action(app: &AppHandle, session: &Session, payload: Value) -> CommandResult<Value> {
    if payload["action"] == "read" {
        let value = request(app,session,"/capabilities",None,None).await?;
        let mut manifest = load_state(app,session)?;
        if let Some(policy) = value.get("policy").filter(|policy| !policy.is_null()) {
            manifest.knowledge_policy = Some(policy.clone());
            persist(app,session,&manifest)?;
        }
        return Ok(json!({"capabilities":value,"pending":manifest.knowledge_pending.is_some()}));
    }
    if payload["action"] != "update" { return Err("Unsupported knowledge policy action".into()); }
    let body = payload.get("policy").filter(|body| body.is_object()).ok_or("Knowledge policy is required")?.clone();
    let mut manifest = load_state(app,session)?;
    let operation = manifest.knowledge_pending.as_ref()
        .filter(|pending| pending["request"] == body)
        .and_then(|pending| pending["operation"].as_str()).map(str::to_owned)
        .unwrap_or_else(|| format!("knowledge-policy-{}",uuid::Uuid::new_v4()));
    let mut local = manifest.knowledge_policy.clone().unwrap_or_else(|| json!({}));
    if let (Some(local),Some(changes)) = (local.as_object_mut(),body.as_object()) {
        for (key,value) in changes { if !key.starts_with("base_") { local.insert(key.clone(),value.clone()); } }
    }
    manifest.knowledge_pending = Some(json!({"policy":local,"request":body,"operation":operation}));
    persist(app,session,&manifest)?;
    let result = request(app,session,"/preferences/actions",Some(json!({"knowledge":body})),Some(&operation)).await?;
    manifest = load_state(app,session)?;
    manifest.knowledge_policy = result.get("knowledge").cloned();
    manifest.knowledge_pending = None;
    persist(app,session,&manifest)?;
    Ok(json!({"policy":manifest.knowledge_policy,"pending":false}))
}

fn chunks(text: &str, limit: usize) -> Vec<String> {
    let mut result=Vec::new();
    let mut current=String::new();
    for character in text.chars() {
        if current.len()+character.len_utf8()>limit { result.push(current);current=String::new(); }
        current.push(character);
    }
    if !current.is_empty() { result.push(current); }
    result
}

pub(super) async fn upload_local(app: &AppHandle, session: &Session, id: &str) -> CommandResult<Value> {
    let uuid=id.strip_prefix("local:").ok_or("Only a local recording can use text synchronization")?;
    uuid::Uuid::parse_str(uuid).map_err(|_| "Invalid recording UUID")?;
    let capability=request(app,session,"/capabilities",None,None).await?;
    let policy=&capability["policy"];
    if capability["available"] != true || policy["local_text_consent"] != true || policy["memory_consent"] != true {
        return Err("Authorize local work transcript synchronization first".into());
    }
    let mut manifest=load_state(app,session)?;
    let (root,_)=roots(app,session)?;
    let entry=manifest.entries.get(id).ok_or("Recording is not available to this account")?;
    let doc=store::read_document(&root,entry)?;
    if !doc.ai_context_enabled || entry.excluded || !local_allows(&doc,&manifest) { return Err("Recording is outside the authorized source range".into()); }
    let preferred=wiki::memory_source(doc.clone(),&manifest);
    let text=wiki::mask_memory_text(&preferred.text());
    if text.trim().is_empty() || text.len()>16*1024*1024 { return Err("Transcript text is empty or exceeds 16 MiB".into()); }
    let content_hash=store::digest(&text);
    let source_fingerprint=store::digest(json!([doc.revision,preferred.text()]).to_string());
    let previous=manifest.knowledge_uploads.get(id).cloned().unwrap_or(Value::Null);
    let remote=request(app,session,&format!("/desktop-sources/{}",source_id(id)),None,None).await?;
    if previous["source_fingerprint"] == source_fingerprint && previous["complete"] == true && previous["source_revision"] == remote["revision"] {
        return Ok(previous);
    }
    if remote["source_fingerprint"] == source_fingerprint && remote["revision"].as_u64().unwrap_or(0)>0 {
        let recovered=json!({"source_fingerprint":source_fingerprint,"content_hash":content_hash,"source_revision":remote["revision"],"complete":true});
        manifest=load_state(app,session)?;
        manifest.knowledge_uploads.insert(id.to_owned(),recovered.clone());
        persist(app,session,&manifest)?;
        return Ok(recovered);
    }
    if previous.is_null() && remote["revision"].as_u64().unwrap_or(0)>0 && remote["source_fingerprint"] != source_fingerprint {
        return Err("Cloud text snapshot differs; review it before replacing from this device".into());
    }
    let stable=store::digest(json!([id,source_fingerprint,content_hash,policy["grant_versions"],policy["range_version"]]).to_string());
    let mut receipt=if previous["input"] == stable { previous } else {
        json!({"input":stable,"content_hash":content_hash,"source_fingerprint":source_fingerprint,"base_revision":previous.get("source_revision").unwrap_or(&remote["revision"])})
    };
    manifest.knowledge_uploads.insert(id.to_owned(),receipt.clone());
    persist(app,session,&manifest)?;
    if receipt["upload_id"].as_str().is_none() {
        let prepared=request(app,session,"/desktop-sources/uploads",Some(json!({"recording_id":uuid,
            "base_revision":receipt["base_revision"],"folder_id":doc.folder_id,"scene":"work",
            "source_fingerprint":source_fingerprint,
            "representation":if preferred.kind == "meeting_summary" {"masked_summary"} else {"masked_transcript"}})),Some(&format!("source-prepare-{stable}"))).await?;
        receipt["upload_id"]=prepared["upload_id"].clone();
        manifest=load_state(app,session)?;
        manifest.knowledge_uploads.insert(id.to_owned(),receipt.clone());
        persist(app,session,&manifest)?;
    }
    let upload_id=receipt["upload_id"].as_str().ok_or("Invalid source upload session")?;
    let pieces=chunks(&text,256*1024);
    for (index,piece) in pieces.iter().enumerate() {
        request(app,session,&format!("/desktop-sources/uploads/{upload_id}/chunks"),
            Some(json!({"index":index,"data":STANDARD.encode(piece.as_bytes())})),Some(&format!("source-chunk-{stable}-{index}"))).await?;
    }
    let committed=request(app,session,&format!("/desktop-sources/uploads/{upload_id}/commit"),
        Some(json!({"chunk_count":pieces.len(),"content_hash":content_hash})),Some(&format!("source-commit-{stable}"))).await?;
    receipt["source_revision"]=committed["source"]["revision"].clone();
    receipt["source_id"]=committed["source"]["source_id"].clone();
    receipt["complete"]=json!(true);
    manifest=load_state(app,session)?;
    manifest.knowledge_uploads.insert(id.to_owned(),receipt.clone());
    persist(app,session,&manifest)?;
    Ok(receipt)
}

pub(super) async fn publish_events(app: &AppHandle,session: &Session,pages: Vec<Value>) -> CommandResult<()> {
    let capability=request(app,session,"/capabilities",None,None).await?;
    let policy=&capability["policy"];
    if capability["available"] != true || policy["memory_consent"] != true || policy["extraction_paused"] == true { return Ok(()); }
    let mut failed=false;
    for page in pages {
        let outcome: CommandResult<()> = async {
        let refs=page["citations"].as_array().ok_or("Wiki citations unavailable")?;
        let ids: BTreeSet<_>=refs.iter().filter_map(|reference|reference["id"].as_str()).map(str::to_owned).collect();
        let cloud: Vec<_>=ids.iter().filter(|id|!id.starts_with("local:")).cloned().collect();
        let synced=if cloud.is_empty() { json!({"sources":[]}) } else {
            request(app,session,"/sources/sync",Some(json!({"source_ids":cloud})),None).await?
        };
        let mut versions=std::collections::BTreeMap::new();
        if let Some(sources)=synced["sources"].as_array() {
            for source in sources { if let (Some(id),Some(version))=(source["source_id"].as_str(),source["revision"].as_u64()) { versions.insert(id.to_owned(),version); } }
        }
        let manifest=load_state(app,session)?;
        for id in ids.iter().filter(|id|id.starts_with("local:")) {
            if manifest.knowledge_uploads.get(id).is_some_and(|receipt|receipt["complete"] == true) {
                let receipt=upload_local(app,session,id).await?;
                if let Some(version)=receipt["source_revision"].as_u64() { versions.insert(source_id(id),version); }
            }
        }
        if ids.iter().any(|id|!versions.contains_key(&source_id(id))) { return Ok(()); }
        let source_refs: Vec<_>=ids.iter().map(|id| json!({"source_id":source_id(id),"source_revision":versions[&source_id(id)]})).collect();
        let identity=store::digest(json!([page["topic_id"],page["topic_title"],page["fingerprint"],source_refs,policy["processing_version"],policy["grant_version"]]).to_string());
        let mut manifest=load_state(app,session)?;
        let topic=page["topic_id"].as_str().ok_or("Invalid Wiki topic")?;
        if manifest.knowledge_events.get(topic).is_some_and(|saved|saved == &identity) { return Ok(()); }
        request(app,session,"/wiki-memory/events",Some(json!({"topic_id":topic,"topic_title":page["topic_title"],"input_fingerprint":identity,"source_refs":source_refs})),Some(&format!("wiki-memory-{identity}"))).await?;
        manifest=load_state(app,session)?;
        manifest.knowledge_events.insert(topic.to_owned(),identity);
        persist(app,session,&manifest)?;
        Ok(())
        }.await;
        failed |= outcome.is_err();
    }
    if failed { Err("Some Wiki memory events await retry".into()) } else { Ok(()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn upload_chunks_count_utf8_bytes_and_preserve_text() {
        let text="中🙂".repeat(50000);
        let pieces=chunks(&text,256*1024);
        assert!(pieces.iter().all(|piece|piece.len()<=256*1024));
        assert_eq!(pieces.concat(),text);
    }
    #[test]
    fn pending_range_is_enforced_before_cloud_acknowledgement() {
        let doc=Document{folder_id:"old".into(),..Default::default()};
        let mut manifest=Manifest::default();
        manifest.knowledge_pending=Some(json!({"policy":{"enrolled":true,"folder_ids":["new"],"include_unfiled":false}}));
        assert!(!local_allows(&doc,&manifest));
    }
}
