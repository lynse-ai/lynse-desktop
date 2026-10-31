//! User-defined topics aggregate evidence-backed ordinary topics without replacing them.
use super::*;
use chrono::Datelike;
use std::collections::BTreeSet;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Collection {
    pub hierarchy: bool,
    pub automatic: bool,
    pub links: Vec<TopicLink>,
    pub status: String,
    pub completed: usize,
    pub total: usize,
}
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TopicLink {
    pub target_id: String,
    pub state: String,
    pub manual: bool,
    pub reason: String,
    pub citations: Vec<SourceRef>,
    pub events: Vec<TimelineEvent>,
    pub fingerprint: String,
    pub error: String,
}
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TimelineEvent {
    pub id: String,
    pub text: String,
    pub date: String,
    pub date_basis: String,
    pub citations: Vec<SourceRef>,
}

pub(super) fn edit_link(topics: &mut [Topic], request: &Value) -> CommandResult<()> {
    let target = request["targetId"]
        .as_str()
        .ok_or("Choose an existing topic")?;
    let member = topics
        .iter()
        .find(|t| {
            topic_store::matches_id(t, target)
                && t.collection.is_none()
                && !t.excluded
                && t.published.is_some()
        })
        .ok_or("Related topic unavailable")?
        .id
        .clone();
    let choice = request["state"]
        .as_str()
        .filter(|s| matches!(*s, "included" | "excluded"))
        .ok_or("Invalid topic link decision")?;
    let topic = topics
        .iter_mut()
        .find(|t| request["id"] == t.id)
        .ok_or("Topic not found")?;
    let collection = topic
        .collection
        .as_mut()
        .ok_or("This topic cannot contain topics")?;
    if let Some(link) = collection.links.iter_mut().find(|l| l.target_id == member) {
        link.state = choice.into();
        link.manual = true;
        if !link.error.is_empty() {
            link.error.clear();
            link.fingerprint.clear();
        }
    } else {
        collection.links.push(TopicLink {
            target_id: member,
            state: choice.into(),
            manual: true,
            ..Default::default()
        });
    }
    if let Some(page) = topic.published.take() {
        topic.history.push(page);
    }
    topic.last_attempt_fingerprint.clear();
    topic.error.clear();
    topic.failure = None;
    collection.status = "pending".into();
    Ok(())
}

fn collection_documents(local: &Path, manifest: &Manifest, topics: &[Topic]) -> Vec<Document> {
    let mut sources = PageSources::new(local, manifest);
    let mut seen = BTreeSet::new();
    topics
        .iter()
        .filter(|t| t.collection.is_none() && !t.excluded)
        .flat_map(|t| t.published.iter().flat_map(|p| &p.citations))
        .filter_map(|r| {
            if !seen.insert((r.id.clone(), r.kind.clone())) {
                return None;
            }
            sources.document(r).cloned()
        })
        .filter_map(super::super::markdown::source)
        .collect()
}
fn member_docs(member: &Topic, docs: &[Document]) -> Vec<Document> {
    let ids: BTreeSet<_> = member
        .published
        .iter()
        .flat_map(|p| p.citations.iter().map(|c| (c.id.as_str(), c.kind.as_str())))
        .collect();
    docs.iter()
        .filter(|d| ids.contains(&(d.id.as_str(), d.kind.as_str())))
        .cloned()
        .collect()
}
fn manually_included(topic: &Topic, id: &str) -> bool {
    topic.collection.as_ref().is_some_and(|c| {
        c.links
            .iter()
            .any(|l| l.target_id == id && l.manual && l.state == "included")
    })
}
fn pair_version(topic: &Topic, member: &Topic, docs: &[Document], config: &Models) -> String {
    store::digest(
        json!([
            "wiki-collection-pair-v1",
            topic.title,
            topic.purpose,
            topic.notes,
            member.id,
            member.title,
            member.published,
            manually_included(topic, &member.id),
            docs.iter()
                .map(|d| automation::input_key(d, config))
                .collect::<Vec<_>>()
        ])
        .to_string(),
    )
}
fn date_in_quote(date: &str, quote: &str) -> bool {
    chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_ok_and(|d| {
        quote.contains(date)
            || quote.contains(&format!("{}年{}月{}日", d.year(), d.month(), d.day()))
            || quote.contains(&format!("{}年{:02}月{:02}日", d.year(), d.month(), d.day()))
    })
}
fn valid_date(date: &str) -> bool {
    chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_ok() && date.len() == 10
}
fn validate_match(value: &Value, docs: &[Document], manifest: &Manifest) -> CommandResult<()> {
    let relation = value["relation"].as_str().ok_or("Invalid topic relation")?;
    if !matches!(relation, "related" | "uncertain" | "unrelated")
        || !value["reason"]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty() && s.chars().count() <= 1000)
    {
        return Err("Invalid topic relation".into());
    }
    let refs = value["citations"]
        .as_array()
        .ok_or("Invalid topic relation citations")?;
    if relation != "unrelated" || !refs.is_empty() {
        sync::validate_result(docs, manifest, value)?;
    }
    let events = value["events"]
        .as_array()
        .filter(|r| r.len() <= 50)
        .ok_or("Invalid topic timeline")?;
    if relation == "unrelated" && (!refs.is_empty() || !events.is_empty()) {
        return Err("Unrelated topic must contain no claims".into());
    }
    for event in events {
        if !event["text"]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty() && s.chars().count() <= 1000)
        {
            return Err("Invalid topic timeline".into());
        }
        sync::validate_result(docs, manifest, event)?;
        if let Some(date) = event["date"].as_str().filter(|s| !s.is_empty()) {
            let quote = event["dateQuote"].as_str().unwrap_or_default();
            let refs: Vec<SourceRef> = serde_json::from_value(event["citations"].clone())
                .map_err(|_| "Invalid event date")?;
            if !valid_date(date)
                || !date_in_quote(date, quote)
                || !refs.iter().any(|r| r.quote.contains(quote))
            {
                return Err("Event date needs an exact dated source quote".into());
            }
        }
    }
    Ok(())
}
fn event_from(value: &Value, docs: &[Document]) -> CommandResult<TimelineEvent> {
    let citations: Vec<SourceRef> = serde_json::from_value(value["citations"].clone())
        .map_err(|_| "Invalid timeline citations")?;
    let explicit = value["date"].as_str().filter(|s| !s.is_empty());
    let recorded = citations
        .iter()
        .filter_map(|r| docs.iter().find(|d| d.id == r.id))
        .filter_map(|d| d.created_at.get(..10))
        .filter(|d| valid_date(d))
        .min();
    let text = value["text"]
        .as_str()
        .ok_or("Invalid timeline text")?
        .to_owned();
    Ok(TimelineEvent {
        id: store::digest(json!([text, citations]).to_string()),
        text,
        date: explicit.or(recorded).unwrap_or_default().into(),
        date_basis: if explicit.is_some() {
            "event"
        } else if recorded.is_some() {
            "record"
        } else {
            "unknown"
        }
        .into(),
        citations,
    })
}

fn matching_parts(member: &Topic, doc: &Document) -> Vec<String> {
    let text = doc.text();
    let mut ranges = Vec::<(usize, usize)>::new();
    for reference in member
        .published
        .iter()
        .flat_map(|p| &p.citations)
        .filter(|r| r.id == doc.id)
    {
        if let Some(at) = text.find(&reference.quote) {
            let start = text[..at]
                .char_indices()
                .rev()
                .nth(300)
                .map(|(i, _)| i)
                .unwrap_or(0);
            let quote_end = at + reference.quote.len();
            let end = text[quote_end..]
                .char_indices()
                .nth(300)
                .map(|(i, _)| quote_end + i)
                .unwrap_or(text.len());
            ranges.push((start, end));
        }
    }
    ranges.sort();
    let mut merged = Vec::<(usize, usize)>::new();
    for (start, end) in ranges {
        if let Some(last) = merged.last_mut().filter(|last| start <= last.1) {
            last.1 = last.1.max(end);
        } else {
            merged.push((start, end));
        }
    }
    merged
        .into_iter()
        .flat_map(|(start, end)| sync::split_text(&text[start..end], 12000))
        .collect()
}

async fn match_member(
    app: &AppHandle,
    state: &WorkbenchState,
    session: &Session,
    topic: &Topic,
    member: &Topic,
    docs: &[Document],
    manifest: &Manifest,
    root: &Path,
    version: &str,
) -> CommandResult<TopicLink> {
    let mut link = TopicLink {
        target_id: member.id.clone(),
        state: "unrelated".into(),
        fingerprint: version.into(),
        ..Default::default()
    };
    for doc in docs {
        for (index, text) in matching_parts(member, doc).into_iter().enumerate() {
            let part = analysis::part(doc, text);
            let query = json!({"title":topic.title,"purpose":topic.purpose,"notes":topic.notes,"candidateTitle":member.title,"manualIncluded":manually_included(topic,&member.id),"candidateOverview":member.published.as_ref().map(|p| &p.overview)}).to_string();
            let key =
                store::digest(json!(["wiki-topic-match-v1", version, doc.id, index]).to_string());
            let value = cached_compilation(
                root,
                &key,
                &state.serial,
                |v| {
                    require_current(state, session)?;
                    validate_match(v, std::slice::from_ref(&part), manifest)
                },
                true,
                automation::request(
                    app,
                    session,
                    "wiki_topic_match",
                    std::slice::from_ref(&part),
                    &query,
                    Value::Null,
                ),
            )
            .await?;
            let relation = value["relation"].as_str().unwrap_or("unrelated");
            if relation == "related" || (relation == "uncertain" && link.state != "included") {
                link.state = if relation == "related" {
                    "included"
                } else {
                    "candidate"
                }
                .into();
                link.reason = value["reason"].as_str().unwrap_or_default().into();
            } else if link.reason.is_empty() {
                link.reason = value["reason"].as_str().unwrap_or_default().into();
            }
            link.citations.extend(
                serde_json::from_value::<Vec<SourceRef>>(value["citations"].clone())
                    .map_err(|_| "Invalid topic relation citations")?,
            );
            for event in value["events"].as_array().into_iter().flatten() {
                link.events
                    .push(event_from(event, std::slice::from_ref(doc))?);
            }
        }
    }
    if link.reason.is_empty() {
        return Err("Related topic source quotations changed".into());
    }
    Ok(link)
}

pub(super) fn filter_view(
    value: &mut Value,
    topics: &[Topic],
    sources: &mut PageSources<'_>,
    manifest: &Manifest,
) {
    if value["collection"].is_null() {
        return;
    }
    let hidden_member = value["collection"]["links"]
        .as_array()
        .is_some_and(|links| {
            links.iter().any(|link| {
                link["state"] == "included"
                    && !topics.iter().any(|t| {
                        link["targetId"] == t.id
                            && !t.excluded
                            && t.published.as_ref().is_some_and(|p| sources.valid_page(p))
                    })
            })
        });
    let invalid_page = value["published"].is_object()
        && !serde_json::from_value::<Revision>(value["published"].clone())
            .is_ok_and(|page| sources.valid_page(&page));
    if (hidden_member && value["collection"]["hierarchy"] != true) || invalid_page {
        value["published"] = Value::Null;
    }
    let Some(collection) = value.get_mut("collection").and_then(Value::as_object_mut) else {
        return;
    };
    if let Some(links) = collection.get_mut("links").and_then(Value::as_array_mut) {
        links.retain(|link| {
            topics.iter().any(|t| {
                link["targetId"] == t.id
                    && t.collection.is_none()
                    && !t.excluded
                    && t.published.as_ref().is_some_and(|p| sources.valid_page(p))
            })
        });
        for link in links {
            if let Some(events) = link["events"].as_array_mut() {
                events.retain(|event| {
                    serde_json::from_value::<Vec<SourceRef>>(event["citations"].clone()).is_ok_and(
                        |refs| {
                            refs.iter().all(|r| {
                                sources.document(r).is_some_and(|d| {
                                    sync::validate_result(
                                        std::slice::from_ref(d),
                                        manifest,
                                        &json!({"citations":[r]}),
                                    )
                                    .is_ok()
                                })
                            })
                        },
                    )
                });
            }
        }
    }
}

pub(super) async fn run(
    app: &AppHandle,
    state: &WorkbenchState,
    session: &Session,
) -> CommandResult<()> {
    let (root, local, manifest, config, docs, values) = {
        let _guard = state.serial.lock().await;
        require_current(state, session)?;
        let manifest = load_state(app, session)?;
        if ready(&manifest).is_err() {
            return Ok(());
        }
        let local = roots(app, session)?.0;
        let values = topics(&wiki_root(app, session)?)?;
        let docs = collection_documents(&local, &manifest, &values);
        (
            wiki_root(app, session)?,
            local.clone(),
            manifest.clone(),
            models(app, session)?,
            docs,
            values,
        )
    };
    let mut source_cache = PageSources::new(&local, &manifest);
    let members: Vec<_> = values
        .iter()
        .filter(|t| {
            t.collection.is_none()
                && !t.excluded
                && t.published
                    .as_ref()
                    .is_some_and(|p| source_cache.valid_page(p))
        })
        .cloned()
        .collect();
    for topic in values.iter().filter(|t| {
        t.collection.is_some()
            && !t.collection.as_ref().is_some_and(|c|c.hierarchy)
            && !t.excluded
            && !t.pinned
            && !t
                .published
                .as_ref()
                .is_some_and(|p| p.content_hash != store::digest(&p.markdown))
    }) {
        let input = store::digest(
            json!([
                topic.title,
                topic.purpose,
                topic.notes,
                members
                    .iter()
                    .map(|m| pair_version(topic, m, &member_docs(m, &docs), &config))
                    .collect::<Vec<_>>(),
                topic
                    .collection
                    .as_ref()
                    .unwrap()
                    .links
                    .iter()
                    .filter(|l| l.manual)
                    .map(|l| (&l.target_id, &l.state, l.manual))
                    .collect::<Vec<_>>()
            ])
            .to_string(),
        );
        if !topic.last_attempt_fingerprint.is_empty() && topic.last_attempt_fingerprint == input {
            continue;
        }
        let mut first_failure: Option<WikiFailure> = None;
        for (index, member) in members.iter().enumerate() {
            let selected = member_docs(member, &docs);
            if selected.is_empty() {
                continue;
            }
            let version = pair_version(topic, member, &selected, &config);
            let old = topic
                .collection
                .as_ref()
                .unwrap()
                .links
                .iter()
                .find(|l| l.target_id == member.id);
            if old.is_some_and(|l| l.manual && l.state == "excluded")
                || old.is_some_and(|l| l.fingerprint == version && l.error.is_empty())
            {
                continue;
            }
            if old.is_some_and(|l| l.fingerprint == version && !l.error.is_empty()) {
                first_failure = Some(WikiFailure::new(
                    &old.unwrap().error,
                    "matching",
                    selected.iter().map(|d| d.id.clone()).collect(),
                ));
                continue;
            }
            {
                let _guard = state.serial.lock().await;
                require_current(state, session)?;
                let mut latest = topics(&root)?;
                if let Some(c) = latest
                    .iter_mut()
                    .find(|t| t.id == topic.id)
                    .and_then(|t| t.collection.as_mut())
                {
                    c.status = "matching".into();
                    c.completed = index;
                    c.total = members.len();
                }
                save_topics(&root, &latest)?;
                persist(app, session, &load_state(app, session)?)?;
            }
            let result = match_member(
                app, state, session, topic, member, &selected, &manifest, &root, &version,
            )
            .await;
            let service_failure = result.as_ref().err().is_some_and(|e| is_service_failure(e));
            let _guard = state.serial.lock().await;
            require_current(state, session)?;
            let latest_manifest = load_state(app, session)?;
            ready(&latest_manifest)?;
            let mut latest = topics(&root)?;
            let latest_docs = collection_documents(&local, &latest_manifest, &latest);
            let Some(current_member) = latest
                .iter()
                .find(|m| m.id == member.id && !m.excluded)
                .cloned()
            else {
                continue;
            };
            let Some(current) = latest
                .iter_mut()
                .find(|t| t.id == topic.id && !t.excluded && !t.pinned)
            else {
                continue;
            };
            if pair_version(
                current,
                &current_member,
                &member_docs(&current_member, &latest_docs),
                &models(app, session)?,
            ) != version
            {
                continue;
            }
            let collection = current.collection.as_mut().unwrap();
            let prior = collection
                .links
                .iter()
                .find(|l| l.target_id == member.id)
                .cloned();
            let mut link = match result {
                Ok(link) => link,
                Err(error) => {
                    first_failure = Some(WikiFailure::new(
                        &error,
                        "matching",
                        selected.iter().map(|d| d.id.clone()).collect(),
                    ));
                    TopicLink {
                        target_id: member.id.clone(),
                        fingerprint: version,
                        error,
                        ..prior.clone().unwrap_or_default()
                    }
                }
            };
            if let Some(prior) = prior.filter(|p| p.manual) {
                link.state = prior.state;
                link.manual = true;
            }
            collection.links.retain(|l| l.target_id != member.id);
            collection.links.push(link);
            collection.completed = index + 1;
            save_topics(&root, &latest)?;
            if service_failure {
                break;
            }
        }
        let (current, selected, version) = {
            let _guard = state.serial.lock().await;
            require_current(state, session)?;
            let mut latest = topics(&root)?;
            let mut source_cache = PageSources::new(&local, &manifest);
            let available: BTreeSet<_> = latest
                .iter()
                .filter(|m| {
                    m.collection.is_none()
                        && !m.excluded
                        && m.published
                            .as_ref()
                            .is_some_and(|p| source_cache.valid_page(p))
                })
                .map(|m| m.id.clone())
                .collect();
            let Some(current) = latest
                .iter_mut()
                .find(|t| t.id == topic.id && !t.excluded && !t.pinned)
            else {
                continue;
            };
            if current.title != topic.title
                || current.purpose != topic.purpose
                || current.notes != topic.notes
            {
                continue;
            }
            let collection = current.collection.as_mut().unwrap();
            let included: BTreeSet<_> = collection
                .links
                .iter()
                .filter(|l| {
                    l.state == "included" && l.error.is_empty() && available.contains(&l.target_id)
                })
                .map(|l| l.target_id.clone())
                .collect();
            let source_ids: BTreeSet<_> = members
                .iter()
                .filter(|m| included.contains(&m.id))
                .flat_map(|m| member_docs(m, &docs).into_iter().map(|d| d.id))
                .collect();
            current.source_ids = source_ids.iter().cloned().collect();
            let selected: Vec<_> = docs
                .iter()
                .filter(|d| source_ids.contains(&d.id))
                .cloned()
                .collect();
            let version = store::digest(
                json!([
                    "collection-compile-v1",
                    current.title,
                    current.purpose,
                    current.notes,
                    &current.source_ids,
                    collection
                        .links
                        .iter()
                        .filter(|l| included.contains(&l.target_id))
                        .map(|l| (&l.target_id, &l.fingerprint))
                        .collect::<Vec<_>>(),
                    selected
                        .iter()
                        .map(|d| automation::input_key(d, &config))
                        .collect::<Vec<_>>()
                ])
                .to_string(),
            );
            collection.status = "compiling".into();
            let current = current.clone();
            save_topics(&root, &latest)?;
            persist(app, session, &load_state(app, session)?)?;
            (current, selected, version)
        };
        let result = if selected.is_empty() || current.last_fingerprint == version {
            None
        } else {
            Some(
                automation::compile_automatic(
                    app, state, session, &current, &selected, &manifest, &root, &version,
                )
                .await,
            )
        };
        let _guard = state.serial.lock().await;
        require_current(state, session)?;
        let latest_manifest = load_state(app, session)?;
        ready(&latest_manifest)?;
        let mut latest = topics(&root)?;
        let Some(target) = latest
            .iter_mut()
            .find(|t| t.id == topic.id && !t.excluded && !t.pinned)
        else {
            continue;
        };
        if serde_json::to_string(&target.collection).ok()
            != serde_json::to_string(&current.collection).ok()
            || target.title != current.title
            || target.purpose != current.purpose
            || target.notes != current.notes
        {
            continue;
        }
        if let Some(result) = result {
            match result {
                Ok(mut page) if valid_page(&local, &latest_manifest, &page) => {
                    page.fingerprint =
                        page_fingerprint(target, &latest_manifest, &config, &page.citations);
                    automation::publish_automatic(&root, target, page, &version)?;
                    target.last_fingerprint = version;
                }
                Ok(_) => {
                    first_failure = Some(WikiFailure::new(
                        "Sources changed; automatic page discarded",
                        "validating",
                        target.source_ids.clone(),
                    ))
                }
                Err(error) => first_failure = Some(error),
            }
        }
        if selected.is_empty() && first_failure.is_none() {
            if let Some(page) = target.published.take() {
                target.history.push(page);
            }
        }
        target.error = first_failure
            .as_ref()
            .map(|f| f.message.clone())
            .unwrap_or_default();
        target.failure = first_failure;
        target.last_attempt_fingerprint = input;
        target.force_refresh = false;
        if let Some(c) = &mut target.collection {
            c.status = if target.error.is_empty() {
                "ready"
            } else {
                "failed"
            }
            .into();
            c.completed = c.total;
        }
        save_topics(&root, &latest)?;
        persist(app, session, &latest_manifest)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_topics_are_not_collections() {
        let topic: Topic = serde_json::from_value(json!({"id":"old"})).unwrap();
        assert!(topic.collection.is_none());
    }
    #[test]
    fn event_dates_need_dated_quotes_and_record_dates_are_labeled() {
        let doc = Document {
            id: "s".into(),
            kind: "meeting".into(),
            revision: "r".into(),
            transcript: "We plan a release.".into(),
            created_at: "2026-10-01T00:00:00Z".into(),
            ..Default::default()
        };
        let event = json!({"text":"Release proposed","citations":[{"id":"s","revision":"r","kind":"meeting","quote":"We plan a release."}]});
        let parsed = event_from(&event, std::slice::from_ref(&doc)).unwrap();
        assert_eq!(parsed.date, "2026-10-01");
        assert_eq!(parsed.date_basis, "record");
        let undated = event_from(&event, &[]).unwrap();
        assert_eq!(undated.date_basis, "unknown");
        assert!(!valid_date("2026-02-30"));
    }
    #[test]
    fn manual_membership_is_local_and_cannot_form_cycles() {
        let mut topics = vec![
            Topic {
                id: "collection".into(),
                collection: Some(Collection::default()),
                ..Default::default()
            },
            Topic {
                id: "ordinary".into(),
                published: Some(Revision::default()),
                ..Default::default()
            },
        ];
        edit_link(
            &mut topics,
            &json!({"id":"collection","targetId":"ordinary","state":"excluded"}),
        )
        .unwrap();
        assert!(!topics[1].excluded);
        assert!(topics[0].collection.as_ref().unwrap().links[0].manual);
        assert!(edit_link(
            &mut topics,
            &json!({"id":"collection","targetId":"collection","state":"included"})
        )
        .is_err());
    }
    #[test]
    fn collection_creation_does_not_merge_an_ordinary_same_name_topic() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        let mut topics = vec![Topic {
            id: uuid::Uuid::new_v4().to_string(),
            title: "Delivery".into(),
            ..Default::default()
        }];
        topic_store::upsert(
            &root,
            &mut topics,
            &json!({"title":"Delivery","purpose":"Track progress","mode":"collection"}),
        )
        .unwrap();
        assert_eq!(topics.len(), 2);
        assert!(topics[1].collection.is_some());
        assert!(!topic_store::deduplicate(&root, &mut topics).unwrap());
        assert_eq!(super::super::topics(&root).unwrap().len(), 2);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn matching_uses_original_quote_context_not_unrelated_parts_of_the_meeting() {
        let doc = Document {
            id: "s".into(),
            transcript: format!(
                "UNRELATED_PRIVATE {} TARGET_EVIDENCE {}",
                "甲".repeat(4000),
                "乙".repeat(4000)
            ),
            ..Default::default()
        };
        let member = Topic {
            published: Some(Revision {
                citations: vec![SourceRef {
                    id: "s".into(),
                    quote: "TARGET_EVIDENCE".into(),
                    ..Default::default()
                }],
                ..Default::default()
            }),
            ..Default::default()
        };
        let parts = matching_parts(&member, &doc);
        assert_eq!(parts.len(), 1);
        assert!(parts[0].contains("TARGET_EVIDENCE"));
        assert!(!parts[0].contains("UNRELATED_PRIVATE"));
        assert!(doc.text().contains(&parts[0]));
    }
    #[test]
    fn explicit_dates_require_valid_source_evidence_and_revocation_is_rejected() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let mut doc = Document {
            id: "s".into(),
            kind: "meeting".into(),
            transcript: "2026年10月25日提出方案，尚未批准。".into(),
            ai_context_enabled: true,
            ..Default::default()
        };
        doc.refresh_revision();
        let mut manifest = Manifest::default();
        manifest.entries.insert(
            doc.id.clone(),
            store::write_document(&root, &doc, None).unwrap(),
        );
        let reference = SourceRef {
            quote: doc.text(),
            ..doc.reference()
        };
        let value = json!({"relation":"related","reason":"Same work","citations":[reference],"events":[{"text":"Proposed, not approved","date":"2026-10-25","dateQuote":"2026年10月25日","citations":[reference]}]});
        validate_match(&value, std::slice::from_ref(&doc), &manifest).unwrap();
        assert_eq!(
            event_from(&value["events"][0], std::slice::from_ref(&doc))
                .unwrap()
                .date_basis,
            "event"
        );
        let mut forged = value.clone();
        forged["events"][0]["date"] = json!("2026-10-24");
        assert!(validate_match(&forged, std::slice::from_ref(&doc), &manifest).is_err());
        manifest.entries.get_mut("s").unwrap().excluded = true;
        assert!(validate_match(&value, std::slice::from_ref(&doc), &manifest).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn retry_reuses_successful_association_receipts_and_only_generates_failed_work() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        let serial = tokio::sync::Mutex::new(());
        let calls = std::cell::Cell::new(0);
        for attempt in 0..2 {
            cached_compilation(
                &root,
                "successful-match",
                &serial,
                |_| Ok(()),
                true,
                async {
                    calls.set(calls.get() + 1);
                    Ok(json!({"relation":"related"}))
                },
            )
            .await
            .unwrap();
            let result =
                cached_compilation(&root, "failed-match", &serial, |_| Ok(()), true, async {
                    calls.set(calls.get() + 1);
                    if attempt == 0 {
                        Err("Network unavailable".into())
                    } else {
                        Ok(json!({"relation":"unrelated"}))
                    }
                })
                .await;
            assert_eq!(result.is_ok(), attempt == 1);
        }
        assert_eq!(calls.get(), 3);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn manual_membership_changes_only_its_own_pair_cache_key() {
        let member = Topic {
            id: "one".into(),
            ..Default::default()
        };
        let other = Topic {
            id: "two".into(),
            ..Default::default()
        };
        let mut parent = Topic {
            collection: Some(Collection::default()),
            ..Default::default()
        };
        let first = pair_version(&parent, &member, &[], &Models::default());
        let second = pair_version(&parent, &other, &[], &Models::default());
        parent.collection.as_mut().unwrap().links.push(TopicLink {
            target_id: "one".into(),
            state: "included".into(),
            manual: true,
            ..Default::default()
        });
        assert_ne!(
            pair_version(&parent, &member, &[], &Models::default()),
            first
        );
        assert_eq!(
            pair_version(&parent, &other, &[], &Models::default()),
            second
        );
    }
    #[test]
    fn members_keep_their_original_transcript_or_summary_representation() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let mut doc = Document {
            id: "one".into(),
            kind: "meeting".into(),
            transcript: "RAW_ORIGINAL_EVIDENCE".into(),
            conclusions: vec![json!({"conclusionText":"# Summary\nSUMMARY_EVIDENCE"})],
            ai_context_enabled: true,
            ..Default::default()
        };
        doc.refresh_revision();
        let mut manifest = Manifest::default();
        manifest.entries.insert(
            doc.id.clone(),
            store::write_document(&root, &doc, None).unwrap(),
        );
        let member = |kind: &str, quote: &str| Topic {
            published: Some(Revision {
                citations: vec![SourceRef {
                    kind: kind.into(),
                    quote: quote.into(),
                    ..doc.reference()
                }],
                ..Default::default()
            }),
            ..Default::default()
        };
        let members = vec![
            member("meeting", "RAW_ORIGINAL_EVIDENCE"),
            member("meeting_summary", "SUMMARY_EVIDENCE"),
        ];
        let docs = collection_documents(&root, &manifest, &members);
        assert_eq!(docs.len(), 2);
        let raw = member_docs(&members[0], &docs);
        assert_eq!(raw.len(), 1);
        assert!(raw[0].text().contains("RAW_ORIGINAL_EVIDENCE"));
        let summary = member_docs(&members[1], &docs);
        assert_eq!(summary.len(), 1);
        assert!(!summary[0].text().contains("RAW_ORIGINAL_EVIDENCE"));
        fs::remove_dir_all(root).unwrap();
    }
}
