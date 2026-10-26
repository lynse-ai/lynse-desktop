//! Optional cross-topic reuse; never remove original text from the compilation request.
use super::*;

fn analysis(tracking: &Tracking, doc: &Document, language: &str) -> Option<Value> {
    if doc.kind != schema::SUMMARY_KIND || !doc.ai_context_enabled || tracking.language != language
    {
        return None;
    }
    let mut rebound = tracking.clone();
    let work = cache::plan(std::slice::from_ref(doc), &mut rebound);
    if work.is_empty() {
        return None;
    }
    let mut findings = Vec::new();
    let mut refs = BTreeMap::new();
    for item in work {
        let chunk = rebound.chunks.get(&item.key)?;
        if chunk.profile != cache::PROFILE || !chunk.error.is_empty() || chunk.in_flight {
            return None;
        }
        let names: BTreeMap<_, _> = chunk
            .extraction
            .nodes
            .iter()
            .map(|node| (node.key.as_str(), node.title.as_str()))
            .collect();
        for node in &chunk.extraction.nodes {
            findings.push(json!({"kind":node.kind,"title":node.title,"description":node.description,
                "status":node.status,"modality":node.modality,"timeText":node.time_text,"dueText":node.due_text}));
        }
        for relation in &chunk.extraction.relations {
            findings.push(json!({"subject":names.get(relation.subject.as_str())?,"target":names.get(relation.target.as_str())?,
                "predicate":relation.predicate,"modality":relation.modality}));
        }
        for reference in chunk
            .extraction
            .nodes
            .iter()
            .flat_map(|node| &node.citations)
            .chain(
                chunk
                    .extraction
                    .relations
                    .iter()
                    .flat_map(|relation| &relation.citations),
            )
        {
            refs.insert(reference.quote.clone(), reference.clone());
        }
    }
    if findings.is_empty() || refs.is_empty() || refs.len() > 40 {
        return None;
    }
    // Partial graph evidence cannot establish that a topic-specific analysis saw all facts.
    // Fall back to the original analysis for every uncovered non-whitespace character.
    let mut covered = vec![false; doc.transcript.len()];
    for quote in refs.keys() {
        for (offset, _) in doc.transcript.match_indices(quote) {
            covered[offset..offset + quote.len()].fill(true);
        }
    }
    if doc
        .transcript
        .char_indices()
        .any(|(index, ch)| !ch.is_whitespace() && !covered[index])
    {
        return None;
    }
    let summary = serde_json::to_string(&findings).ok()?;
    if summary.chars().count() > 24000 {
        return None;
    }
    Some(
        json!({"summary":summary,"citations":refs.into_values().collect::<Vec<_>>(),
        "memoryItems":[],"todoSuggestions":[],"decisions":[],"insufficientEvidence":false,
        "relevant":true,"promptVersion":cache::PROFILE,"graphReused":true}),
    )
}

pub(in crate::workbench::wiki) fn read(
    root: &Path,
    session: &Session,
    doc: &Document,
    manifest: &Manifest,
) -> Option<Value> {
    // Roll out only after comparing real model quality; all fallback paths remain available.
    if std::env::var("LYNSE_GRAPH_REUSE_FACTS").as_deref() != Ok("1") {
        return None;
    }
    let tracking: Tracking = read_json(&path(root)).ok()?;
    if tracking.scope != session.scope || !manifest.enabled || !manifest.allow_ai {
        return None;
    }
    let value = analysis(&tracking, doc, &session.locale)?;
    sync::validate_result(std::slice::from_ref(doc), manifest, &value).ok()?;
    Some(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn thirty_fixtures_reuse_verified_graph_facts_without_dropping_original_evidence() {
        for index in 0..30 {
            let mut doc = Document {
                id: "source".into(),
                kind: schema::SUMMARY_KIND.into(),
                title: "Review".into(),
                transcript: format!(
                    "评审{index}：张三计划周五提交方案；李四反对，不代表已经承诺或完成。"
                ),
                revision: "r1".into(),
                ai_context_enabled: true,
                ..Default::default()
            };
            let mut tracking = Tracking {
                scope: "user".into(),
                language: "zh".into(),
                selected_sources: BTreeSet::from([doc.id.clone()]),
                ..Default::default()
            };
            let work = cache::plan(std::slice::from_ref(&doc), &mut tracking).remove(0);
            let extraction: Extraction = serde_json::from_value(json!({"schemaVersion":1,"nodes":[{
                "key":"task","kind":"task","title":"提交方案","description":"计划而非承诺","status":"proposed",
                "modality":"planned","confidence":0.8,"citations":[SourceRef {quote:doc.transcript.clone(),..doc.reference()}]
            }],"relations":[]})).unwrap();
            tracking.chunks.insert(
                work.key,
                Chunk {
                    source_id: doc.id.clone(),
                    identity: work.identity,
                    profile: cache::PROFILE.into(),
                    extraction,
                    ..Default::default()
                },
            );
            let value = analysis(&tracking, &doc, "zh").unwrap();
            assert_eq!(value["citations"][0]["quote"], doc.transcript);
            assert!(value["summary"].as_str().unwrap().contains("planned"));
            let evidence = CompilationEvidence {
                value,
                source: doc.clone(),
            };
            let compilation = compile_sources(&[evidence]).unwrap();
            assert_eq!(compilation[0]["text"], doc.transcript);
            assert!(analysis(&tracking, &doc, "en").is_none());
            doc.transcript.push_str("另一个尚未覆盖的问题。");
            assert!(analysis(&tracking, &doc, "zh").is_none());
            doc.kind = "meeting".into();
            assert!(analysis(&tracking, &doc, "zh").is_none());
        }
    }
}
