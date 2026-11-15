//! Preserve unchanged compilation batches when sources are inserted or edited.
use super::*;

fn identity(item: &CompilationEvidence, config: &Models) -> String {
    store::digest(
        json!([
            input_key(&item.source, config),
            content_cache::canonical(&item.value)
        ])
        .to_string(),
    )
}
fn fits(batch: &[CompilationEvidence]) -> bool {
    batch.len() <= 100
        && batch
            .first()
            .is_none_or(|first| batch.iter().all(|item| item.source.id == first.source.id))
        && serde_json::to_vec(batch).is_ok_and(|bytes| bytes.len() <= 50000)
        && compile_sources(batch).is_ok()
}

fn bounded_citations(item: &CompilationEvidence, part: &Document) -> Value {
    let mut citations = Vec::new();
    for reference in analysis_citations(&item.value) {
        let supported = reference["id"] == part.id
            && reference["quote"]
                .as_str()
                .is_some_and(|quote| !quote.trim().is_empty() && part.text().contains(quote));
        if supported {
            citations.push(reference.clone());
        }
    }
    json!({"citations":citations})
}

/// A failed single item can only be recovered by reusing its bounded source in
/// smaller batches. Keep only quotations contained in each part; the final
/// compiler still sees the complete original text and creates its own citations.
fn split_item(item: &CompilationEvidence) -> CommandResult<Vec<CompilationEvidence>> {
    let text = item.source.text();
    sync::split_text(text.trim(), 6000)
        .into_iter()
        .filter(|text| !text.trim().is_empty())
        .map(|text| {
            let part = analysis::part(&item.source, text);
            Ok(CompilationEvidence {
                value: bounded_citations(item, &part),
                source: part,
            })
        })
        .collect()
}
fn append(
    batches: &mut Vec<Vec<CompilationEvidence>>,
    items: Vec<CompilationEvidence>,
) -> CommandResult<()> {
    let mut batch = Vec::new();
    for item in items {
        let mut trial = batch.clone();
        trial.push(item.clone());
        if !batch.is_empty() && !fits(&trial) {
            batches.push(std::mem::take(&mut batch));
        }
        if fits(std::slice::from_ref(&item)) {
            batch.push(item);
        } else {
            if !batch.is_empty() {
                batches.push(std::mem::take(&mut batch));
            }
            for part in split_item(&item)? {
                batches.push(vec![part]);
            }
        }
    }
    if !batch.is_empty() {
        batches.push(batch);
    }
    Ok(())
}

pub(super) fn plan(
    root: &Path,
    topic: &Topic,
    evidence: Vec<CompilationEvidence>,
    config: &Models,
) -> CommandResult<Vec<Vec<CompilationEvidence>>> {
    let path = root
        .join("source-compilation-layouts")
        .join(format!("{}.json", topic.id));
    let mut layouts: BTreeMap<String, Vec<Vec<String>>> = read_json(&path)?;
    let mut sources: BTreeMap<String, Vec<CompilationEvidence>> = BTreeMap::new();
    for item in evidence {
        sources
            .entry(item.source.id.clone())
            .or_default()
            .push(item);
    }
    let mut batches = Vec::new();
    for (id, items) in sources {
        let mut planned = Vec::new();
        let mut remaining = BTreeMap::<String, Vec<CompilationEvidence>>::new();
        for item in items {
            remaining
                .entry(identity(&item, config))
                .or_default()
                .push(item);
        }
        for anchors in layouts.get(&id).into_iter().flatten() {
            let mut preserved = Vec::new();
            for key in anchors {
                if let Some(items) = remaining.get_mut(key) {
                    preserved.extend(items.pop());
                }
            }
            append(&mut planned, preserved)?;
        }
        append(&mut planned, remaining.into_values().flatten().collect())?;
        layouts.insert(
            id,
            planned
                .iter()
                .map(|batch| batch.iter().map(|item| identity(item, config)).collect())
                .collect(),
        );
        batches.extend(planned);
    }
    write_json(&path, &layouts)?;
    Ok(batches)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn evidence(id: &str) -> CompilationEvidence {
        let mut source = Document {
            id: id.into(),
            kind: "meeting".into(),
            transcript: format!("Evidence {id}"),
            ai_context_enabled: true,
            ..Default::default()
        };
        source.refresh_revision();
        CompilationEvidence {
            value: json!({"summary":format!("Evidence {id}"),"citations":[{"id":id,"kind":"meeting","revision":source.revision,"quote":format!("Evidence {id}") }]}),
            source,
        }
    }
    #[test]
    fn insertion_keeps_existing_batch_keys_and_metadata_rebinding_changes_none() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let topic = Topic {
            id: uuid::Uuid::new_v4().to_string(),
            title: "Project".into(),
            ..Default::default()
        };
        let config = Models::default();
        let items = vec![evidence("b"), evidence("c")];
        let first = plan(&root, &topic, items.clone(), &config).unwrap();
        let key = batch_compilation_key(&topic, &config, &first[0]);
        let mut added = items.clone();
        added.insert(0, evidence("a"));
        let second = plan(&root, &topic, added, &config).unwrap();
        assert_eq!(second.len(), 3);
        let unchanged = second
            .iter()
            .find(|batch| batch[0].source.id == "b")
            .unwrap();
        assert_eq!(batch_compilation_key(&topic, &config, unchanged), key);
        let mut rebound = unchanged.clone();
        for item in &mut rebound {
            item.source.folder_id = "new-folder".into();
            item.source.refresh_revision();
            item.value["citations"][0]["revision"] = json!(item.source.revision);
        }
        assert_eq!(batch_compilation_key(&topic, &config, &rebound), key);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn one_changed_source_in_a_large_topic_leaves_other_sections_reusable() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let topic = Topic {
            id: uuid::Uuid::new_v4().to_string(),
            ..Default::default()
        };
        let config = Models::default();
        let original: Vec<_> = (0..200)
            .map(|index| evidence(&format!("source-{index:03}")))
            .collect();
        let before = plan(&root, &topic, original.clone(), &config).unwrap();
        let keys = |batches: Vec<Vec<CompilationEvidence>>| -> BTreeSet<_> {
            batches
                .iter()
                .map(|batch| batch_compilation_key(&topic, &config, batch))
                .collect()
        };
        let before = keys(before);
        let mut changed = original;
        changed[100].source.transcript.push_str(" Revised.");
        changed[100].source.refresh_revision();
        changed[100].value["citations"][0]["revision"] = json!(changed[100].source.revision);
        let after = keys(plan(&root, &topic, changed, &config).unwrap());
        assert_eq!(before.len(), 200);
        assert_eq!(before.intersection(&after).count(), 199);
        assert_eq!(after.difference(&before).count(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn oversized_evidence_is_split_without_transferring_unsupported_citations() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let topic = Topic {
            id: uuid::Uuid::new_v4().to_string(),
            title: "Large source".into(),
            ..Default::default()
        };
        let source = Document {
            id: "large".into(),
            kind: "meeting".into(),
            transcript: format!("{}结尾", "甲".repeat(25000)),
            ..Default::default()
        };
        let item = CompilationEvidence {
            value: json!({
                "summary": "x".repeat(60000),
                "citations":[
                    {"id":"large","quote":"结尾"},
                    {"id":"large","quote":"Missing quotation"}
                ]
            }),
            source,
        };
        let batches = plan(&root, &topic, vec![item], &Models::default()).unwrap();
        assert!(batches.len() >= 5, "batch count={}", batches.len());
        let mut covered = String::new();
        for batch in &batches {
            assert!(fits(batch));
            let sources = compile_sources(batch).unwrap();
            assert_eq!(sources.len(), 1);
            covered.push_str(sources[0]["text"].as_str().unwrap());
            assert!(batch.iter().all(|item| {
                item.value["citations"].as_array().is_none_or(|rows| {
                    rows.iter().all(|row| {
                        row["quote"]
                            .as_str()
                            .is_none_or(|quote| item.source.text().contains(quote))
                    })
                })
            }));
        }
        assert!(covered.contains("结尾"));
        fs::remove_dir_all(root).unwrap();
    }
}
