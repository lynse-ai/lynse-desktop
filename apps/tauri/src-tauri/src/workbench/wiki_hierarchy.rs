//! Durable navigation groups. Original topics, evidence and revisions stay intact.
use super::*;
use std::collections::{BTreeMap, BTreeSet};

const VERSION: &str = "topic-hierarchy-v1";

#[derive(Default, Deserialize, Serialize)]
#[serde(default)]
struct GroupState {
    failed: BTreeMap<String, String>,
    inflight: BTreeSet<String>,
    blocked: BTreeSet<String>,
}
fn state_path(root: &Path) -> PathBuf {
    root.join("topic-hierarchy.json")
}
pub(super) fn status(root: &Path) -> CommandResult<Value> {
    let state: GroupState = read_json(&state_path(root))?;
    Ok(json!({"error":state.failed.values().next().cloned()}))
}
pub(super) fn retry(root: &Path) -> CommandResult<()> {
    write_json(&state_path(root), &GroupState::default())
}
fn parent(topic: &Topic) -> bool {
    topic.collection.as_ref().is_some_and(|c| c.hierarchy)
}
fn name_key(title: &str) -> String {
    title
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}
fn version(topic: &Topic, locale: &str, config: &Models) -> String {
    store::digest(
        json!([
            VERSION,
            locale,
            config.text_revision,
            topic.title,
            topic.purpose,
            topic.published.as_ref().map(|p| &p.overview)
        ])
        .to_string(),
    )
}
fn metadata(topic: &Topic, id: &str) -> Value {
    json!({"id":id,"title":topic.title,
        "overview":topic.published.as_ref().unwrap().overview.chars().take(500).collect::<String>(),
        "sourceIds":topic.published.as_ref().unwrap().citations.iter().map(|r|r.id.clone()).collect::<BTreeSet<_>>().into_iter().take(20).collect::<Vec<_>>()})
}

fn assign(values: &mut [Topic], target: &str, ids: &BTreeSet<String>, manual: bool) {
    for topic in values.iter_mut() {
        if let Some(collection) = topic.collection.as_mut().filter(|c| c.hierarchy) {
            for link in &mut collection.links {
                if ids.contains(&link.target_id) && topic.id != target && link.state == "included" {
                    link.state = "excluded".into();
                    link.manual |= manual;
                }
            }
        }
        if ids.contains(&topic.id) && manual {
            topic.grouping_manual = true;
        }
    }
    let collection = values
        .iter_mut()
        .find(|t| t.id == target)
        .unwrap()
        .collection
        .as_mut()
        .unwrap();
    collection.hierarchy = true;
    for id in ids {
        if let Some(link) = collection.links.iter_mut().find(|l| &l.target_id == id) {
            link.state = "included".into();
            link.manual |= manual;
            link.error.clear();
        } else {
            collection.links.push(collections::TopicLink {
                target_id: id.clone(),
                state: "included".into(),
                manual,
                ..Default::default()
            });
        }
    }
}

pub(super) fn manual_link(values: &mut [Topic], request: &Value) -> CommandResult<()> {
    let Some(target) = request["id"].as_str() else {
        return Ok(());
    };
    if !values.iter().any(|t| t.id == target && parent(t)) {
        return Ok(());
    }
    let id = request["targetId"]
        .as_str()
        .ok_or("Choose an existing topic")?;
    let canonical = values
        .iter_mut()
        .find(|t| topic_store::matches_id(t, id))
        .ok_or("Topic not found")?;
    canonical.grouping_manual = true;
    let id = canonical.id.clone();
    if request["state"] == "included" {
        assign(values, target, &BTreeSet::from([id]), true);
    }
    Ok(())
}

pub(super) fn group(
    root: &Path,
    values: &mut Vec<Topic>,
    request: &Value,
) -> CommandResult<String> {
    let ids: Vec<String> =
        serde_json::from_value(request["ids"].clone()).map_err(|_| "Choose topics to group")?;
    if ids.is_empty() || ids.len() > 1000 {
        return Err("Choose 1–1000 topics to group".into());
    }
    let members: BTreeSet<_> = ids
        .iter()
        .map(|id| {
            values
                .iter()
                .find(|t| {
                    topic_store::matches_id(t, id)
                        && t.collection.is_none()
                        && !t.excluded
                        && t.published.is_some()
                })
                .map(|t| t.id.clone())
                .ok_or_else(|| "A selected topic is unavailable".to_owned())
        })
        .collect::<CommandResult<_>>()?;
    let existing = request["targetId"].as_str().filter(|id| !id.is_empty());
    let title = request["title"].as_str().unwrap_or_default().trim();
    let target = if let Some(id) = existing {
        values
            .iter()
            .find(|t| topic_store::matches_id(t, id) && t.collection.is_some() && !t.excluded)
            .map(|t| t.id.clone())
            .ok_or("Parent topic unavailable")?
    } else {
        if title.is_empty() || title.chars().count() > 200 {
            return Err("Enter a parent topic title".into());
        }
        values
            .iter()
            .find(|t| parent(t) && !t.excluded && name_key(&t.title) == name_key(title))
            .map(|t| t.id.clone())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
    };
    // Local backups make the membership decision reviewable without changing originals.
    write_json(
        &root
            .join("topic-group-actions")
            .join(format!("{}.json", uuid::Uuid::new_v4())),
        values,
    )?;
    if !values.iter().any(|t| t.id == target) {
        values.push(Topic {
            id: target.clone(),
            title: title.into(),
            collection: Some(collections::Collection {
                hierarchy: true,
                ..Default::default()
            }),
            ..Default::default()
        });
    }
    assign(values, &target, &members, true);
    save_topics(root, values)?;
    Ok(target)
}

pub(super) fn refresh(
    root: &Path,
    local: &Path,
    manifest: &Manifest,
    locale: &str,
) -> CommandResult<()> {
    let mut values = topics(root)?;
    if !values.iter().any(parent) {
        return Ok(());
    }
    let mut sources = PageSources::new(local, manifest);
    let members: BTreeMap<_, _> = values
        .iter()
        .filter(|t| t.collection.is_none() && !t.excluded)
        .filter(|t| t.published.as_ref().is_some_and(|p| sources.valid_page(p)))
        .map(|t| (t.id.clone(), t.clone()))
        .collect();
    let mut changed = false;
    for group in values.iter_mut().filter(|t| parent(t) && !t.excluded) {
        if group
            .published
            .as_ref()
            .is_some_and(|p| p.content_hash != store::digest(&p.markdown))
        {
            continue;
        }
        let collection = group.collection.as_mut().unwrap();
        let selected: Vec<_> = collection
            .links
            .iter()
            .filter(|l| l.state == "included")
            .filter_map(|l| members.get(&l.target_id))
            .collect();
        let fingerprint = store::digest(
            json!([
                VERSION,
                group.title,
                group.purpose,
                group.notes,
                selected
                    .iter()
                    .map(|t| (
                        &t.id,
                        t.published
                            .as_ref()
                            .map(|p| (&p.id, &p.content_hash, &p.overview))
                    ))
                    .collect::<Vec<_>>()
            ])
            .to_string(),
        );
        if group.last_fingerprint == fingerprint {
            continue;
        }
        let mut citations = Vec::new();
        let mut seen = BTreeSet::new();
        for member in &selected {
            for reference in &member.published.as_ref().unwrap().citations {
                if seen.insert(serde_json::to_string(reference).unwrap_or_default()) {
                    citations.push(reference.clone());
                }
            }
        }
        for link in &mut collection.links {
            if let Some(member) = members.get(&link.target_id) {
                let page = member.published.as_ref().unwrap();
                link.citations = page.citations.clone();
                link.reason = page.overview.clone();
                link.error.clear();
                link.events = page
                    .changes
                    .iter()
                    .map(|change| collections::TimelineEvent {
                        id: change.id.clone(),
                        text: change.text.clone(),
                        date: String::new(),
                        date_basis: "unknown".into(),
                        citations: change.citations.clone(),
                    })
                    .collect();
            }
        }
        collection.status = "ready".into();
        collection.completed = selected.len();
        collection.total = selected.len();
        let label = if locale.starts_with("zh") {
            "内部议题"
        } else {
            "Issues"
        };
        let mut markdown = format!("# {}\n\n## {label}\n", group.title);
        for member in &selected {
            markdown.push_str(&format!(
                "\n### {}\n\n{}\n",
                member.title,
                member.published.as_ref().unwrap().overview
            ));
        }
        group.source_ids = citations
            .iter()
            .map(|r| r.id.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        // This is a navigation view of validated pages, not a new factual model result.
        if let Some(previous) = group.published.take().filter(|p| p.review != "hierarchy") {
            group.history.push(previous);
        }
        group.published = (!selected.is_empty()).then(|| Revision {
            id: format!("hierarchy-{fingerprint}"),
            markdown: markdown.clone(),
            content_hash: store::digest(&markdown),
            citations,
            fingerprint: fingerprint.clone(),
            overview: group.purpose.clone(),
            created_at: crate::now(),
            review: "hierarchy".into(),
            ..Default::default()
        });
        group.last_fingerprint = fingerprint;
        if let Some(page) = &group.published {
            save_page(root, group, page, false)?;
        }
        changed = true;
    }
    if changed {
        save_topics(root, &values)?;
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GroupRow {
    title: String,
    existing_id: Option<String>,
    topic_ids: Vec<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResultGroups {
    groups: Vec<GroupRow>,
    unassigned: Vec<String>,
}

fn validate(value: Value, members: usize, groups: usize) -> CommandResult<ResultGroups> {
    let result: ResultGroups =
        serde_json::from_value(value).map_err(|_| "Invalid topic grouping output")?;
    let allowed: BTreeSet<_> = (0..members).map(|i| format!("t{i}")).collect();
    let parents: BTreeSet<_> = (0..groups).map(|i| format!("g{i}")).collect();
    let mut seen = BTreeSet::new();
    let mut used = BTreeSet::new();
    let mut names = BTreeSet::new();
    for row in &result.groups {
        if row.title.trim().is_empty()
            || row.title.chars().count() > 200
            || row.topic_ids.len() < if row.existing_id.is_some() { 1 } else { 2 }
            || !names.insert(name_key(&row.title))
            || row
                .existing_id
                .as_ref()
                .is_some_and(|id| !parents.contains(id) || !used.insert(id.clone()))
        {
            return Err("Invalid topic grouping output".into());
        }
    }
    for id in result
        .groups
        .iter()
        .flat_map(|g| &g.topic_ids)
        .chain(&result.unassigned)
    {
        if !allowed.contains(id) || !seen.insert(id.clone()) {
            return Err("Invalid topic grouping output".into());
        }
    }
    if seen != allowed {
        return Err("Invalid topic grouping output".into());
    }
    Ok(result)
}

fn pending_topics(
    values: &[Topic],
    local: &Path,
    manifest: &Manifest,
    locale: &str,
    config: &Models,
) -> Vec<Topic> {
    let mut sources = PageSources::new(local, manifest);
    values
        .iter()
        .filter(|t| t.collection.is_none() && !t.excluded && !t.grouping_manual)
        .filter(|t| {
            !values.iter().any(|g| {
                g.collection
                    .as_ref()
                    .is_some_and(|c| c.links.iter().any(|l| l.target_id == t.id && l.manual))
            })
        })
        .filter(|t| t.grouping_revision != version(t, locale, config))
        .filter(|t| t.published.as_ref().is_some_and(|p| sources.valid_page(p)))
        .cloned()
        .collect()
}

pub(super) async fn run(
    app: &AppHandle,
    state: &WorkbenchState,
    session: &Session,
) -> CommandResult<()> {
    let (root, local, manifest, config, mut pending) = {
        let _guard = state.serial.lock().await;
        require_current(state, session)?;
        let manifest = load_state(app, session)?;
        if ready(&manifest).is_err() {
            return Ok(());
        }
        let root = wiki_root(app, session)?;
        let local = roots(app, session)?.0;
        let config = models(app, session)?;
        let values = topics(&root)?;
        let mut work: GroupState = read_json(&state_path(&root))?;
        for key in std::mem::take(&mut work.inflight) {
            work.failed.insert(
                key,
                "Topic grouping outcome is unknown; retry explicitly".into(),
            );
        }
        let mut pending = pending_topics(&values, &local, &manifest, &session.locale, &config);
        if pending.is_empty() {
            work = GroupState::default();
        }
        write_json(&state_path(&root), &work)?;
        pending.retain(|t| !work.blocked.contains(&t.id));
        pending.sort_by(|a, b| a.id.cmp(&b.id));
        (root, local, manifest, config, pending)
    };
    let total = pending.len();
    let mut completed = 0;
    while !pending.is_empty() {
        let mut ids = BTreeSet::new();
        let mut members = Vec::new();
        let mut rest = Vec::new();
        let mut chars = 0;
        for topic in pending {
            let row = metadata(&topic, &format!("t{}", members.len()));
            let size = row.to_string().len();
            let refs: BTreeSet<_> = row["sourceIds"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect();
            if members.len() < 30 && ids.union(&refs).count() <= 20 && chars + size < 18000 {
                chars += size;
                ids.extend(refs);
                members.push(topic);
            } else {
                rest.push(topic);
            }
        }
        pending = rest;
        if members.is_empty() {
            break;
        }
        let latest = topics(&root)?;
        let mut groups: Vec<_> = latest
            .iter()
            .filter(|t| parent(t) && !t.excluded)
            .cloned()
            .collect();
        groups.sort_by(|a, b| a.id.cmp(&b.id));
        let mut group_chars = 0;
        groups = groups
            .into_iter()
            .take(100)
            .take_while(|t| {
                group_chars += t.title.len() + 50;
                group_chars < 8000
            })
            .collect();
        let docs: Vec<_> = ids
            .iter()
            .map(|id| {
                let entry = manifest
                    .entries
                    .get(id)
                    .ok_or("Grouping source unavailable")?;
                let doc = store::read_document(&local, entry)?;
                Ok(analysis::part(
                    &doc,
                    "Navigation metadata only; classify the supplied topic labels.".into(),
                ))
            })
            .collect::<CommandResult<_>>()?;
        let query=json!({"topics":members.iter().enumerate().map(|(i,t)|metadata(t,&format!("t{i}"))).collect::<Vec<_>>(),
            "groups":groups.iter().enumerate().map(|(i,t)|json!({"id":format!("g{i}"),"title":t.title})).collect::<Vec<_>>()}).to_string();
        let payload =
            automation::transport_payload("wiki_topic_group", &docs, &query, Value::Null)?;
        let key = store::digest(
            json!([VERSION, session.locale, config.text_revision, payload]).to_string(),
        );
        let mut work: GroupState = read_json(&state_path(&root))?;
        if work.inflight.remove(&key) {
            work.failed.insert(
                key.clone(),
                "Topic grouping outcome is unknown; retry explicitly".into(),
            );
            write_json(&state_path(&root), &work)?;
        }
        if work.failed.contains_key(&key) {
            continue;
        }
        report_progress(
            app,
            state,
            session,
            WikiProgress {
                stage: "grouping".into(),
                completed,
                total,
                ..Default::default()
            },
        )
        .await?;
        let authority_ids: BTreeSet<_> = members
            .iter()
            .flat_map(|t| &t.published.as_ref().unwrap().citations)
            .map(|r| r.id.clone())
            .collect();
        let authority_docs: Vec<_> = authority_ids
            .iter()
            .map(|id| {
                let entry = manifest
                    .entries
                    .get(id)
                    .ok_or("Grouping source unavailable")?;
                store::read_document(&local, entry)
            })
            .collect::<CommandResult<_>>()?;
        let result = if let Some(value) = receipt(&root, &key)? {
            Ok(value)
        } else {
            work.inflight.insert(key.clone());
            work.blocked.extend(members.iter().map(|t| t.id.clone()));
            write_json(&state_path(&root), &work)?;
            async {
                knowledge_cloud::authorize(app, session, &authority_docs, "wiki_compile").await?;
                let value = automation::request(
                    app,
                    session,
                    "wiki_topic_group",
                    &docs,
                    &query,
                    Value::Null,
                )
                .await?;
                knowledge_cloud::authorize(app, session, &authority_docs, "wiki_compile").await?;
                Ok::<Value, String>(value)
            }
            .await
        }
        .and_then(|v| {
            validate(v.clone(), members.len(), groups.len())?;
            Ok(v)
        });
        let _guard = state.serial.lock().await;
        require_current(state, session)?;
        let current_manifest = load_state(app, session)?;
        ready(&current_manifest)?;
        work = read_json(&state_path(&root))?;
        work.inflight.remove(&key);
        match result {
            Err(error) => {
                if error == TEXT_MODEL_CHANGED {
                    for member in &members {
                        work.blocked.remove(&member.id);
                    }
                    write_json(&state_path(&root), &work)?;
                    return Err(error);
                }
                work.failed.insert(key, error);
                write_json(&state_path(&root), &work)?;
                break;
            }
            Ok(value) => {
                let result = validate(value.clone(), members.len(), groups.len())?;
                let mut values = topics(&root)?;
                let current_config = models(app, session)?;
                let mut sources = PageSources::new(&local, &current_manifest);
                let valid: BTreeSet<_> = members
                    .iter()
                    .filter(|old| {
                        values.iter().any(|t| {
                            t.id == old.id
                                && !t.grouping_manual
                                && !t.excluded
                                && version(t, &session.locale, &current_config)
                                    == version(old, &session.locale, &config)
                                && t.published.as_ref().is_some_and(|p| sources.valid_page(p))
                        })
                    })
                    .map(|t| t.id.clone())
                    .collect();
                for row in result.groups {
                    let selected: BTreeSet<_> = row
                        .topic_ids
                        .iter()
                        .filter_map(|id| {
                            id.strip_prefix('t')?
                                .parse::<usize>()
                                .ok()
                                .and_then(|i| members.get(i))
                        })
                        .filter(|t| valid.contains(&t.id))
                        .map(|t| t.id.clone())
                        .collect();
                    if selected.is_empty() {
                        continue;
                    }
                    let existing = row
                        .existing_id
                        .as_ref()
                        .and_then(|id| id.strip_prefix('g')?.parse::<usize>().ok())
                        .and_then(|i| groups.get(i))
                        .and_then(|g| {
                            values
                                .iter()
                                .find(|t| t.id == g.id && parent(t) && !t.excluded)
                        })
                        .map(|t| t.id.clone())
                        .or_else(|| {
                            values
                                .iter()
                                .find(|t| {
                                    parent(t)
                                        && !t.excluded
                                        && name_key(&t.title) == name_key(&row.title)
                                })
                                .map(|t| t.id.clone())
                        });
                    if existing.is_none() && selected.len() < 2 {
                        continue;
                    }
                    let target = existing.unwrap_or_else(|| {
                        let id = uuid::Uuid::new_v4().to_string();
                        values.push(Topic {
                            id: id.clone(),
                            title: row.title,
                            collection: Some(collections::Collection {
                                hierarchy: true,
                                automatic: true,
                                ..Default::default()
                            }),
                            ..Default::default()
                        });
                        id
                    });
                    assign(&mut values, &target, &selected, false);
                }
                for old in &members {
                    if valid.contains(&old.id) {
                        if let Some(t) = values.iter_mut().find(|t| t.id == old.id) {
                            t.grouping_revision = version(old, &session.locale, &config);
                        }
                    }
                }
                save_topics(&root, &values)?;
                job(&root, &key, "done", Some(&value), "")?;
                work.failed.remove(&key);
                for member in &members {
                    work.blocked.remove(&member.id);
                }
                write_json(&state_path(&root), &work)?;
                refresh(&root, &local, &current_manifest, &session.locale)?;
                persist(app, session, &current_manifest)?;
            }
        }
        completed += members.len();
    }
    let _guard = state.serial.lock().await;
    require_current(state, session)?;
    let manifest = load_state(app, session)?;
    let values = topics(&root)?;
    if pending_topics(
        &values,
        &local,
        &manifest,
        &session.locale,
        &models(app, session)?,
    )
    .is_empty()
    {
        write_json(&state_path(&root), &GroupState::default())?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "wiki_hierarchy_tests.rs"]
mod tests;
