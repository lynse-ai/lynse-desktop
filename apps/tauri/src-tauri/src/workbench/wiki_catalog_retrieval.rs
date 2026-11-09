//! Deterministic local retrieval; the model still verifies identities with source evidence.
use super::*;

fn terms(text: &str) -> BTreeSet<String> {
    let mut terms = BTreeSet::new();
    let mut word = String::new();
    let mut previous = None;
    for ch in text.chars().flat_map(char::to_lowercase) {
        if ch.is_ascii_alphanumeric() {
            word.push(ch);
            previous = None;
        } else {
            if word.len() > 1 {
                terms.insert(std::mem::take(&mut word));
            } else {
                word.clear();
            }
            if ch.is_alphanumeric() {
                if let Some(before) = previous {
                    terms.insert(format!("{before}{ch}"));
                }
                previous = Some(ch);
            } else {
                previous = None;
            }
        }
    }
    if word.len() > 1 {
        terms.insert(word);
    }
    terms
}

pub(super) fn candidates<'a>(
    topics: &'a [Topic],
    doc: &Document,
    scope_purpose: &str,
    limit: usize,
) -> Vec<&'a Topic> {
    let query = terms(&format!(
        "{} {} {}",
        doc.title,
        doc.text(),
        doc.tags.join(" ")
    ));
    let scope = terms(scope_purpose);
    let eligible: Vec<_> = topics
        .iter()
        .filter(|topic| topic.collection.is_none() && !topic.excluded)
        .collect();
    let indexed: Vec<_> = eligible
        .iter()
        .map(|topic| {
            terms(&format!(
                "{} {} {}",
                topic.title,
                topic.purpose,
                topic
                    .published
                    .as_ref()
                    .map(|page| page.overview.as_str())
                    .unwrap_or_default()
            ))
        })
        .collect();
    let mut frequencies = BTreeMap::<&str, usize>::new();
    for terms in &indexed {
        for term in terms {
            *frequencies.entry(term).or_default() += 1;
        }
    }
    let mut ranked: Vec<_> = eligible
        .into_iter()
        .zip(indexed.iter())
        .map(|(topic, topic_terms)| {
            let title_terms = terms_of_title(topic);
            let relevance: u64 = topic_terms
                .intersection(&query)
                .map(|term| {
                    let rarity = 1000 / frequencies.get(term.as_str()).copied().unwrap_or(1) as u64;
                    rarity * if title_terms.contains(term) { 4 } else { 1 }
                })
                .sum();
            // Topics aligned with the declared knowledge-base goal are better
            // clustering anchors; a small constant boost, never an eligibility gate.
            let scope_alignment = if scope.is_empty() {
                0
            } else {
                terms(&topic.purpose).intersection(&scope).count() as u64
            };
            let continuity = topic.source_ids.contains(&doc.id);
            (topic, continuity, relevance, scope_alignment)
        })
        .collect();
    ranked.sort_by(|(a, ac, ar, asr), (b, bc, br, bsr)| {
        bc.cmp(ac)
            .then(br.cmp(ar))
            .then(bsr.cmp(asr))
            .then(a.id.cmp(&b.id))
    });
    ranked
        .into_iter()
        .filter(|(_, continuity, relevance, _)| *continuity || *relevance > 0)
        .take(limit)
        .map(|(topic, _, _, _)| topic)
        .collect()
}

fn terms_of_title(topic: &Topic) -> BTreeSet<String> {
    terms(&topic.title)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retrieves_related_purpose_without_literal_title_and_ignores_storage_order() {
        let topics = vec![
            Topic {
                id: "z".into(),
                title: "桌面产品演进".into(),
                purpose: "录音转写模型与会议摘要".into(),
                ..Default::default()
            },
            Topic {
                id: "a".into(),
                title: "品牌设计".into(),
                purpose: "包装配色与网站字体".into(),
                ..Default::default()
            },
        ];
        let doc = Document {
            title: "本周开发会议".into(),
            transcript: "讨论录音转写的模型，改进会议摘要。".into(),
            ..Default::default()
        };
        assert!(!doc.text().contains(&topics[0].title));
        let ids = |values: &[Topic]| {
            candidates(values, &doc, "", 1)
                .into_iter()
                .map(|topic| topic.id.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(&topics), vec!["z"]);
        let mut reverse = topics.clone();
        reverse.reverse();
        assert_eq!(ids(&topics), ids(&reverse));
    }
    #[test]
    fn preserves_source_continuity_but_never_recalls_excluded_or_parent_topics() {
        let topics = vec![
            Topic {
                id: "existing".into(),
                source_ids: vec!["source".into()],
                ..Default::default()
            },
            Topic {
                id: "excluded".into(),
                title: "release".into(),
                excluded: true,
                ..Default::default()
            },
            Topic {
                id: "parent".into(),
                title: "release".into(),
                collection: Some(collections::Collection::default()),
                ..Default::default()
            },
            Topic {
                id: "related".into(),
                title: "release".into(),
                ..Default::default()
            },
        ];
        let doc = Document {
            id: "source".into(),
            transcript: "release schedule".into(),
            ..Default::default()
        };
        assert_eq!(
            candidates(&topics, &doc, "", 12)
                .iter()
                .map(|topic| topic.id.as_str())
                .collect::<Vec<_>>(),
            vec!["existing", "related"]
        );
    }
    #[test]
    fn scope_purpose_breaks_relevance_ties_without_recalling_unmatched_topics() {
        let topics = vec![
            Topic {
                id: "aligned".into(),
                title: "release".into(),
                purpose: "录音转写模型与会议摘要".into(),
                ..Default::default()
            },
            Topic {
                id: "other".into(),
                title: "release".into(),
                purpose: "包装配色与网站字体".into(),
                ..Default::default()
            },
            Topic {
                id: "unmatched".into(),
                title: "release".into(),
                ..Default::default()
            },
        ];
        let doc = Document {
            transcript: "release schedule".into(),
            ..Default::default()
        };
        // Equal relevance and no continuity: the scope-aligned topic ranks first.
        assert_eq!(
            candidates(&topics, &doc, "录音转写 会议摘要", 12)
                .iter()
                .map(|topic| topic.id.as_str())
                .collect::<Vec<_>>(),
            vec!["aligned", "other", "unmatched"]
        );
        // Without a scope purpose the tie breaks by id instead.
        assert_eq!(
            candidates(&topics, &doc, "", 12)
                .iter()
                .map(|topic| topic.id.as_str())
                .collect::<Vec<_>>(),
            vec!["aligned", "other", "unmatched"]
        );
        // A topic matching neither the query nor the scope is never recalled.
        let unrelated = vec![Topic {
            id: "far".into(),
            title: "unrelated".into(),
            ..Default::default()
        }];
        assert!(candidates(&unrelated, &doc, "录音转写 会议摘要", 12).is_empty());
    }
    #[test]
    fn inverted_graph_retains_all_shared_evidence_without_duplicate_pairs() {
        let mut topics = Vec::new();
        let mut items = Vec::new();
        for index in 0..1000 {
            let id = format!("topic-{index}");
            topics.push(Topic {
                id: id.clone(),
                source_ids: vec![format!("source-{}", index / 2)],
                published: Some(Revision::default()),
                ..Default::default()
            });
            items.push(json!({"id":id,"published":{}}));
        }
        let graph = topic_graph(&topics, &items);
        assert_eq!(graph["nodes"].as_array().unwrap().len(), 1000);
        let edges = graph["edges"].as_array().unwrap();
        assert_eq!(edges.len(), 500);
        assert!(edges
            .iter()
            .all(|edge| edge["sourceIds"].as_array().unwrap().len() == 1));
        topics[0]
            .source_ids
            .extend(["source-0".into(), "extra".into()]);
        topics[1].source_ids.push("extra".into());
        let graph = topic_graph(&topics, &items);
        assert_eq!(graph["edges"].as_array().unwrap().len(), 500);
        assert_eq!(graph["edges"][0]["sourceIds"], json!(["extra", "source-0"]));
    }
}
