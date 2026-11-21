//! Preserve old source chunks as ordered anchors and repartition only changed gaps.
use super::*;

fn layout_path(root: &Path, doc: &Document) -> std::path::PathBuf {
    root.join("source-layouts")
        .join(format!("{}.json", store::digest(&doc.id)))
}

/// Anchors from a stored layout file, in either format: legacy files are a
/// bare chunk array, current files wrap the chunks with a producer marker.
fn stored_anchors(value: &Value) -> Vec<String> {
    if value.is_array() {
        serde_json::from_value(value.clone()).unwrap_or_default()
    } else {
        serde_json::from_value(value["chunks"].clone()).unwrap_or_default()
    }
}

fn split(text: &str, previous: &[String]) -> Vec<String> {
    let mut result = Vec::new();
    let mut cursor = 0;
    for old in previous {
        if old.is_empty() || old.chars().count() > 12000 {
            continue;
        }
        if let Some(offset) = text[cursor..].find(old) {
            let at = cursor + offset;
            result.extend(sync::split_text(&text[cursor..at], 12000));
            result.push(old.clone());
            cursor = at + old.len();
        }
    }
    result.extend(sync::split_text(&text[cursor..], 12000));
    result
}

/// The chunks the pass would process right now, without persisting anything.
/// Status rendering compares recorded failure keys against this key space, so
/// it must match `prepare` exactly while leaving the anchor file untouched.
pub(super) fn chunks(root: &Path, doc: &Document) -> CommandResult<Vec<String>> {
    let value: Value = read_json(&layout_path(root, doc))?;
    Ok(split(doc.text().trim(), &stored_anchors(&value)))
}

pub(super) fn prepare(
    root: &Path,
    doc: &Document,
    text_revision: &str,
) -> CommandResult<Vec<String>> {
    let path = layout_path(root, doc);
    let value: Value = read_json(&path)?;
    // Producer marker: while the source revision and splitter revision are
    // unchanged the stored chunks stay authoritative, so heartbeats stop
    // re-chunking and rewriting every document on every pass. Legacy files
    // (bare arrays, no marker) are treated as stale.
    if value["producer"] == json!(["wiki-layout-v1", doc.revision, text_revision]) {
        if let Some(chunks) = value["chunks"].as_array() {
            return serde_json::from_value(Value::Array(chunks.clone()))
                .map_err(|error| error.to_string());
        }
    }
    let previous = stored_anchors(&value);
    let chunks = split(doc.text().trim(), &previous);
    write_json(
        &path,
        &json!({
            "producer": ["wiki-layout-v1", doc.revision, text_revision],
            "chunks": chunks,
        }),
    )?;
    Ok(chunks)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn insertion_and_edits_keep_unchanged_unicode_chunks_without_dropping_text() {
        let original = format!(
            "{}{}{}",
            "甲".repeat(12000),
            "乙".repeat(12000),
            "丙".repeat(100)
        );
        let prior = split(&original, &[]);
        assert_eq!(prior.len(), 3);
        let inserted = format!("新会议进展\n{original}");
        let next = split(&inserted, &prior);
        assert_eq!(next.concat(), inserted);
        assert_eq!(&next[1..], prior.as_slice());
        let edited = inserted.replacen("乙乙乙", "预算有变化", 1);
        let changed = split(&edited, &next);
        assert_eq!(changed.concat(), edited);
        assert!(changed.contains(&prior[0]));
        assert!(changed.contains(&prior[2]));
        assert!(changed.iter().all(|chunk| chunk.chars().count() <= 12000));
    }
}
