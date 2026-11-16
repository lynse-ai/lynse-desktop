//! Preserve old source chunks as ordered anchors and repartition only changed gaps.
use super::*;

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
    let path = root
        .join("source-layouts")
        .join(format!("{}.json", store::digest(&doc.id)));
    let previous: Vec<String> = read_json(&path)?;
    Ok(split(doc.text().trim(), &previous))
}

pub(super) fn prepare(root: &Path, doc: &Document) -> CommandResult<Vec<String>> {
    let chunks = chunks(root, doc)?;
    let path = root
        .join("source-layouts")
        .join(format!("{}.json", store::digest(&doc.id)));
    write_json(&path, &chunks)?;
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
