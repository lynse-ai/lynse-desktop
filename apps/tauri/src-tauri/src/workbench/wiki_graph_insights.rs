//! Read-side topic-graph intelligence: deterministic Louvain communities plus
//! actionable insights (isolated topics, sparse communities, bridge topics,
//! strong cross-community links). Pure local computation over the small topic
//! graph — no model calls, no caching, stable output for rendering.

use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

struct Link {
    a: usize,
    b: usize,
    weight: f64,
}

/// Computes insights over a topic-graph payload (`nodes`/`edges` from
/// `automation::topic_graph`), annotates every wiki node with its community
/// id, and returns the insights object for the state payload.
pub(super) fn attach(graph: &mut Value) -> Value {
    let empty = Vec::new();
    let nodes = graph["nodes"].as_array().unwrap_or(&empty);
    let index: BTreeMap<&str, usize> = nodes
        .iter()
        .enumerate()
        .filter_map(|(position, node)| Some((node["id"].as_str()?, position)))
        .collect();
    let mut pairs: BTreeMap<(usize, usize), f64> = BTreeMap::new();
    for edge in graph["edges"].as_array().unwrap_or(&empty) {
        let source = edge["source"].as_str().unwrap_or_default();
        let target = edge["target"].as_str().unwrap_or_default();
        let (Some(a), Some(b)) = (index.get(source), index.get(target)) else {
            continue;
        };
        let (a, b) = (*a, *b);
        if a == b {
            continue;
        }
        let weight = match edge["kind"].as_str() {
            // Shared evidence is the strongest topical signal; count the sources.
            Some("shared_source") => {
                edge["sourceIds"].as_array().map(|ids| ids.len()).unwrap_or(1) as f64
            }
            _ => 1.0,
        };
        *pairs.entry((a.min(b), a.max(b))).or_default() += weight;
    }
    let links: Vec<Link> = pairs
        .into_iter()
        .map(|((a, b), weight)| Link { a, b, weight })
        .collect();
    let labels = louvain(nodes.len(), &links);
    let insights = analyze(nodes, &links, &labels);
    if let Some(target) = graph.get_mut("nodes").and_then(Value::as_array_mut) {
        for (node, label) in target.iter_mut().zip(&labels) {
            node["community"] = json!(label);
        }
    }
    insights
}

/// One-level Louvain (local moving). The topic graph is small enough that
/// aggregation levels add nothing; determinism comes from input order and
/// lowest-label tie-breaking on equal modularity gain.
fn louvain(node_count: usize, links: &[Link]) -> Vec<usize> {
    let mut community: Vec<usize> = (0..node_count).collect();
    let mut adjacency: Vec<BTreeMap<usize, f64>> = vec![BTreeMap::new(); node_count];
    let mut degree = vec![0.0; node_count];
    for link in links {
        let existing = adjacency[link.a].get(&link.b).copied().unwrap_or(0.0) + link.weight;
        adjacency[link.a].insert(link.b, existing);
        let existing = adjacency[link.b].get(&link.a).copied().unwrap_or(0.0) + link.weight;
        adjacency[link.b].insert(link.a, existing);
        degree[link.a] += link.weight;
        degree[link.b] += link.weight;
    }
    let total: f64 = degree.iter().sum();
    if total <= 0.0 {
        return community;
    }
    let mut sigma_tot = degree.clone();
    for _ in 0..node_count.max(1) {
        let mut moved = false;
        for node in 0..node_count {
            let current = community[node];
            let k = degree[node];
            let mut ki_in: BTreeMap<usize, f64> = BTreeMap::new();
            for (neighbor, weight) in &adjacency[node] {
                if *neighbor != node {
                    *ki_in.entry(community[*neighbor]).or_default() += weight;
                }
            }
            // Baseline removes the node from its own community first.
            let own = ki_in.get(&current).copied().unwrap_or(0.0)
                - (sigma_tot[current] - k) * k / total;
            let mut best: Option<(usize, f64)> = None;
            for (candidate, weight) in &ki_in {
                if *candidate == current {
                    continue;
                }
                let gain = weight - sigma_tot[*candidate] * k / total;
                let better = match best {
                    Some((_, value)) => gain > value + 1e-9,
                    None => gain > own + 1e-9,
                };
                if better {
                    best = Some((*candidate, gain));
                }
            }
            if let Some((target, _)) = best {
                sigma_tot[current] -= k;
                sigma_tot[target] += k;
                community[node] = target;
                moved = true;
            }
        }
        if !moved {
            break;
        }
    }
    // Relabel communities by smallest member index so output stays stable.
    let mut rename: BTreeMap<usize, usize> = BTreeMap::new();
    community
        .iter()
        .map(|label| {
            let next = rename.len();
            *rename.entry(*label).or_insert(next)
        })
        .collect()
}

fn analyze(nodes: &[Value], links: &[Link], labels: &[usize]) -> Value {
    let title = |position: usize| nodes[position]["title"].as_str().unwrap_or_default();
    let id = |position: usize| nodes[position]["id"].as_str().unwrap_or_default();
    let mut neighbors: Vec<BTreeSet<usize>> = vec![BTreeSet::new(); nodes.len()];
    for link in links {
        neighbors[link.a].insert(link.b);
        neighbors[link.b].insert(link.a);
    }
    let mut members: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for (position, label) in labels.iter().enumerate() {
        members.entry(*label).or_default().push(position);
    }
    let communities: Vec<Value> = members
        .iter()
        .map(|(label, members)| {
            let size = members.len();
            let intra = links
                .iter()
                .filter(|link| labels[link.a] == *label && labels[link.b] == *label)
                .count() as f64;
            let possible = size * (size - 1) / 2;
            let cohesion = if possible == 0 {
                1.0
            } else {
                intra / possible as f64
            };
            // Label a community by its best-connected member.
            let headline = members
                .iter()
                .copied()
                .max_by_key(|position| (neighbors[*position].len(), std::cmp::Reverse(*position)))
                .map(title)
                .unwrap_or_default();
            json!({"id":label,"label":headline,"size":size,"titles":members.iter().map(|p| title(*p)).collect::<Vec<_>>(),"members":members.iter().map(|p| id(*p)).collect::<Vec<_>>(),"cohesion":(cohesion*1000.0).round()/1000.0})
        })
        .collect();
    let isolated: Vec<Value> = (0..nodes.len())
        .filter(|position| neighbors[*position].len() <= 1)
        .map(|position| {
            json!({"id":id(position),"title":title(position),"degree":neighbors[position].len()})
        })
        .collect();
    let sparse: Vec<Value> = communities
        .iter()
        .filter(|community| {
            community["size"].as_u64().unwrap_or(0) >= 3
                && community["cohesion"].as_f64().unwrap_or(1.0) < 0.15
        })
        .cloned()
        .collect();
    let bridge_communities = |position: usize| -> usize {
        let own = labels[position];
        neighbors[position]
            .iter()
            .map(|neighbor| labels[*neighbor])
            .chain(std::iter::once(own))
            .collect::<BTreeSet<_>>()
            .len()
    };
    let bridges: Vec<Value> = (0..nodes.len())
        .filter(|position| bridge_communities(*position) >= 3)
        .map(|position| {
            json!({"id":id(position),"title":title(position),"communities":bridge_communities(position)})
        })
        .collect();
    let mut cross: Vec<&Link> = links
        .iter()
        .filter(|link| labels[link.a] != labels[link.b])
        .collect();
    cross.sort_by(|x, y| {
        y.weight
            .total_cmp(&x.weight)
            .then(x.a.cmp(&y.a))
            .then(x.b.cmp(&y.b))
    });
    let cross_links: Vec<Value> = cross
        .into_iter()
        .take(5)
        .map(|link| {
            json!({"source":id(link.a),"target":id(link.b),"sourceTitle":title(link.a),"targetTitle":title(link.b),"weight":link.weight})
        })
        .collect();
    json!({"communities":communities,"isolatedTopics":isolated,"sparseCommunities":sparse,"bridgeTopics":bridges,"crossCommunityLinks":cross_links})
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a topic-graph payload: `titles` per node, `edges` pairs joined
    /// by shared_source edges (weight = sourceIds length).
    fn graph(titles: &[&str], edges: &[(usize, usize)]) -> Value {
        let nodes: Vec<_> = titles
            .iter()
            .enumerate()
            .map(|(index, title)| json!({"id":format!("wiki:t{index}"),"title":title}))
            .collect();
        let edges: Vec<_> = edges
            .iter()
            .map(|(a, b)| {
                json!({"id":format!("shared:t{a}:t{b}"),"source":format!("wiki:t{a}"),"target":format!("wiki:t{b}"),"kind":"shared_source","sourceIds":["s1"]})
            })
            .collect();
        json!({"nodes":nodes,"edges":edges})
    }

    #[test]
    fn clusters_split_and_hub_bridges_three_communities() {
        let mut value = graph(
            &["A", "B", "C", "D", "E", "F", "G", "H", "I", "Hub"],
            &[
                (0, 1),
                (1, 2),
                (0, 2), // cluster one
                (3, 4),
                (4, 5),
                (3, 5), // cluster two
                (6, 7),
                (7, 8),
                (6, 8), // cluster three
                (0, 9),
                (3, 9),
                (6, 9), // hub joins all three
            ],
        );
        let insights = attach(&mut value);
        let communities = insights["communities"].as_array().unwrap();
        assert_eq!(communities.len(), 3);
        let bridges = insights["bridgeTopics"].as_array().unwrap();
        assert_eq!(bridges.len(), 1);
        assert_eq!(bridges[0]["id"], json!("wiki:t9"));
        assert_eq!(bridges[0]["communities"], json!(3));
        // The hub lands in the first cluster; its other two links cross communities.
        let cross = insights["crossCommunityLinks"].as_array().unwrap();
        assert_eq!(cross.len(), 2);
        assert!(cross.iter().any(|link| link["source"] == json!("wiki:t3")));
        assert!(cross.iter().any(|link| link["source"] == json!("wiki:t6")));
        // Community labels ride on the nodes for frontend coloring.
        assert!(value["nodes"][0]["community"].is_u64());
        assert!(value["nodes"][3]["community"].is_u64());
        assert!(value["nodes"][9]["community"].is_u64());
    }

    #[test]
    fn unconnected_topics_are_reported_isolated_and_own_their_community() {
        let mut value = graph(&["Lone", "Paired"], &[]);
        let insights = attach(&mut value);
        let isolated = insights["isolatedTopics"].as_array().unwrap();
        assert_eq!(isolated.len(), 2);
        assert!(isolated.iter().any(|topic| topic["id"] == json!("wiki:t0")));
        assert!(isolated.iter().any(|topic| topic["degree"] == json!(0)));
        let communities = insights["communities"].as_array().unwrap();
        assert_eq!(communities.len(), 2);
        assert!(communities.iter().all(|community| community["cohesion"] == json!(1.0)));
    }

    #[test]
    fn weakly_connected_groups_are_flagged_sparse() {
        let labels = vec![0, 0, 0, 0, 0];
        let links = vec![Link { a: 0, b: 1, weight: 1.0 }];
        let nodes: Vec<_> = (0..5)
            .map(|index| json!({"id":format!("wiki:t{index}"),"title":format!("T{index}")}))
            .collect();
        let insights = analyze(&nodes, &links, &labels);
        let sparse = insights["sparseCommunities"].as_array().unwrap();
        assert_eq!(sparse.len(), 1);
        assert_eq!(sparse[0]["size"], json!(5));
        assert_eq!(sparse[0]["cohesion"], json!(0.1));
    }

    #[test]
    fn shared_source_weight_ranks_the_strongest_cross_link_first() {
        // Two heavy triangles joined by a lighter shared_source bridge: the
        // bridge must cross communities carrying its source count as weight.
        let heavy = [(0usize, 1usize), (1, 2), (0, 2), (3, 4), (4, 5), (3, 5)];
        let mut value = graph(
            &["A", "B", "C", "D", "E", "F"],
            &heavy,
        );
        // Give the triangle edges five shared sources each via direct JSON,
        // then add the weight-3 bridge.
        value["edges"] = json!(heavy.iter().map(|(a, b)| json!({"id":format!("shared:t{a}:t{b}"),"source":format!("wiki:t{a}"),"target":format!("wiki:t{b}"),"kind":"shared_source","sourceIds":["s1","s2","s3","s4","s5"]})).collect::<Vec<_>>()
            .into_iter()
            .chain(std::iter::once(json!({"id":"shared:t2:t3","source":"wiki:t2","target":"wiki:t3","kind":"shared_source","sourceIds":["s1","s2","s3"]})))
            .collect::<Vec<_>>());
        let insights = attach(&mut value);
        let cross = insights["crossCommunityLinks"].as_array().unwrap();
        assert_eq!(cross.len(), 1);
        assert_eq!(cross[0]["weight"], json!(3.0));
        assert_eq!(cross[0]["source"], json!("wiki:t2"));
        assert_eq!(cross[0]["target"], json!("wiki:t3"));
    }
}
