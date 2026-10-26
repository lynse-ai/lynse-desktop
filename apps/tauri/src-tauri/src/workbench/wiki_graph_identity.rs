//! Keep review identities only when the same sourced claim can be matched unambiguously.
use super::*;

fn quotes(refs: &[SourceRef]) -> Vec<String> {
    refs.iter()
        .map(|reference| schema::mask(&reference.quote))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}
fn node_signature(node: &ExtractNode) -> String {
    json!([
        node.kind,
        node.title,
        node.modality,
        node.status,
        node.time_text,
        node.due_text,
        quotes(&node.citations)
    ])
    .to_string()
}
fn relation_signature(relation: &schema::ExtractRelation) -> String {
    json!([
        relation.subject,
        relation.target,
        relation.predicate,
        relation.modality,
        quotes(&relation.citations)
    ])
    .to_string()
}
pub(super) fn old_relation_id(
    identity: &str,
    index: usize,
    relation: &schema::ExtractRelation,
) -> String {
    format!(
        "relation:{}",
        store::digest(
            json!([
                identity,
                index,
                relation.subject,
                relation.target,
                relation.predicate
            ])
            .to_string()
        )
    )
}

pub(super) fn stabilize(
    extraction: &mut Extraction,
    previous: Option<&Chunk>,
    identity: &str,
) -> Vec<String> {
    let mut old_nodes: BTreeMap<String, Vec<String>> = BTreeMap::new();
    if let Some(previous) = previous {
        for node in &previous.extraction.nodes {
            old_nodes
                .entry(node_signature(node))
                .or_default()
                .push(node.key.clone());
        }
    }
    let mut keys = BTreeMap::new();
    let mut used = BTreeSet::new();
    for node in &mut extraction.nodes {
        let original = node.key.clone();
        let signature = node_signature(node);
        let matched = old_nodes
            .get(&signature)
            .filter(|keys| keys.len() == 1)
            .map(|keys| keys[0].clone());
        let next = matched
            .filter(|key| !used.contains(key))
            .unwrap_or_else(|| {
                format!(
                    "g:{}",
                    store::digest(json!([signature, original]).to_string())
                )
            });
        used.insert(next.clone());
        keys.insert(original, next.clone());
        node.key = next;
    }
    for relation in &mut extraction.relations {
        if let Some(key) = keys.get(&relation.subject) {
            relation.subject = key.clone();
        }
        if let Some(key) = keys.get(&relation.target) {
            relation.target = key.clone();
        }
    }
    let mut old_relations: BTreeMap<String, Vec<String>> = BTreeMap::new();
    if let Some(previous) = previous {
        for (index, relation) in previous.extraction.relations.iter().enumerate() {
            let id = previous
                .relation_ids
                .get(index)
                .cloned()
                .unwrap_or_else(|| old_relation_id(identity, index, relation));
            old_relations
                .entry(relation_signature(relation))
                .or_default()
                .push(id);
        }
    }
    extraction
        .relations
        .iter()
        .map(|relation| {
            let signature = relation_signature(relation);
            old_relations
                .get(&signature)
                .filter(|ids| ids.len() == 1)
                .map(|ids| ids[0].clone())
                .unwrap_or_else(|| {
                    format!(
                        "relation:{}",
                        store::digest(
                            json!(["graph-relation-v2", identity, signature]).to_string()
                        )
                    )
                })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn model_key_and_relation_order_changes_preserve_matching_manual_identities_only() {
        let source = tests_source();
        let previous: Extraction = serde_json::from_value(json!({"schemaVersion":1,"nodes":[
            {"key":"p","kind":"person","title":"张三","description":"评审人","status":"unknown","modality":"asserted","confidence":0.8,"citations":[source]},
            {"key":"a","kind":"project","title":"A项目","description":"评审项目","status":"unknown","modality":"asserted","confidence":0.8,"citations":[source]}
        ],"relations":[{"subject":"p","target":"a","predicate":"responsible_for","modality":"asserted","confidence":0.8,"citations":[source]}]})).unwrap();
        let old = Chunk {
            extraction: previous.clone(),
            ..Default::default()
        };
        let mut fresh = previous.clone();
        fresh.nodes[0].key = "n7".into();
        fresh.nodes[1].key = "n2".into();
        fresh.nodes.reverse();
        fresh.relations[0].subject = "n7".into();
        fresh.relations[0].target = "n2".into();
        let ids = stabilize(&mut fresh, Some(&old), "stable-source");
        assert_eq!(fresh.nodes[0].key, "a");
        assert_eq!(fresh.nodes[1].key, "p");
        assert_eq!(
            ids[0],
            old_relation_id("stable-source", 0, &previous.relations[0])
        );
        fresh.nodes[1].title = "另一个人".into();
        stabilize(&mut fresh, Some(&old), "stable-source");
        assert_ne!(fresh.nodes[1].key, "p");
    }
    fn tests_source() -> Value {
        json!({"id":"one","kind":"meeting_summary","revision":"r1","quote":"张三负责A项目。"})
    }
}
