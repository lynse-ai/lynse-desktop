//! Canonical topic identity and lossless repair of legacy duplicate topics.
use super::*;
use std::collections::{BTreeMap, BTreeSet};

fn title_key(title: &str) -> String {
    title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .map(|ch| match ch {
            '\u{ff01}'..='\u{ff5e}' => char::from_u32(ch as u32 - 0xfee0).unwrap(),
            _ => ch,
        })
        .flat_map(char::to_lowercase)
        .collect()
}

pub(super) fn matches_id(topic: &Topic, id: &str) -> bool {
    topic.id == id || topic.merged_ids.iter().any(|alias| alias == id)
}

fn append_unique(value: &mut String, extra: &str) {
    let extra = extra.trim();
    if extra.is_empty() || value.trim() == extra || value.split("\n\n").any(|part| part == extra) {
        return;
    }
    if !value.trim().is_empty() {
        value.push_str("\n\n");
    }
    value.push_str(extra);
}

fn priority(topic: &Topic) -> (bool, bool, bool, bool) {
    (
        topic.published.is_some(),
        topic.candidate.is_some(),
        !topic.excluded,
        topic.pinned,
    )
}

pub(super) fn deduplicate(root: &Path, values: &mut Vec<Topic>) -> CommandResult<bool> {
    let mut indices = BTreeMap::<String, Vec<usize>>::new();
    for (index, topic) in values.iter().enumerate() {
        let key = title_key(&topic.title);
        // Do not guess the identity of malformed legacy empty titles.
        if !key.is_empty() {
            indices.entry(key).or_default().push(index);
        }
    }
    let mut removed = BTreeSet::new();
    for group in indices.values().filter(|group| group.len() > 1) {
        let mut keep = group[0];
        for &index in &group[1..] {
            if priority(&values[index]) > priority(&values[keep]) {
                keep = index;
            }
        }
        let originals: Vec<_> = group.iter().map(|&index| values[index].clone()).collect();
        let snapshot = serde_json::to_vec(&originals).map_err(|e| e.to_string())?;
        let backup = root
            .join("topic-merges")
            .join(format!("{}.json", store::digest(snapshot)));
        // Persist every original, including externally edited Markdown, before changing live files.
        if !backup.exists() {
            write_json(&backup, &originals)?;
        }
        let mut canonical = values[keep].clone();
        let had_published = canonical.published.is_some();
        let had_candidate = canonical.candidate.is_some();
        let mut revisions = canonical.history.clone();
        for &index in group {
            if index == keep {
                continue;
            }
            let duplicate = &values[index];
            canonical.merged_ids.push(duplicate.id.clone());
            canonical.merged_ids.extend(duplicate.merged_ids.clone());
            canonical.excluded &= duplicate.excluded;
            canonical.pinned |= duplicate.pinned;
            // Excluded duplicates retain their settings in the backup without reactivating them.
            if !duplicate.excluded {
                append_unique(&mut canonical.purpose, &duplicate.purpose);
                append_unique(&mut canonical.notes, &duplicate.notes);
                canonical.force_refresh |= duplicate.force_refresh;
            }
            if canonical.published.is_none() {
                canonical.published = duplicate.published.clone();
            }
            if canonical.candidate.is_none() {
                canonical.candidate = duplicate.candidate.clone();
            }
            revisions.extend(duplicate.history.clone());
            revisions.extend(duplicate.published.clone());
            revisions.extend(duplicate.candidate.clone());
            removed.insert(index);
        }
        canonical.merged_ids.sort();
        canonical.merged_ids.dedup();
        canonical.merged_ids.retain(|id| id != &canonical.id);
        let mut seen = BTreeSet::new();
        // Compare complete revisions: external edits can share a revision ID with the saved snapshot.
        canonical.history = revisions
            .into_iter()
            .filter(|page| seen.insert(serde_json::to_string(page).unwrap_or_default()))
            .collect();
        if !had_published {
            if let Some(page) = &canonical.published {
                save_page(root, &canonical, page, false)?;
            }
        }
        if !had_candidate {
            if let Some(page) = &canonical.candidate {
                save_page(root, &canonical, page, true)?;
            }
        }
        values[keep] = canonical;
    }
    if removed.is_empty() {
        return Ok(false);
    }
    let mut index = 0;
    values.retain(|_| {
        let keep = !removed.contains(&index);
        index += 1;
        keep
    });
    // Old topic directories remain intact; aliases keep existing source links and actions working.
    save_topics(root, values)?;
    Ok(true)
}

pub(super) fn upsert(root: &Path, values: &mut Vec<Topic>, request: &Value) -> CommandResult<()> {
    let title = request["title"].as_str().unwrap_or_default().trim();
    let purpose = request["purpose"].as_str().unwrap_or_default().trim();
    let notes = request["notes"].as_str();
    if title.is_empty() || title.chars().count() > 200 || purpose.chars().count() > 8000 {
        return Err("Enter a topic title and a purpose of at most 8000 characters".into());
    }
    if notes.is_some_and(|notes| notes.chars().count() > 20000) {
        return Err("Notes are too long".into());
    }
    let id = request["id"].as_str().unwrap_or_default();
    let existing = if id.is_empty() {
        values
            .iter()
            .position(|topic| title_key(&topic.title) == title_key(title))
    } else {
        Some(
            values
                .iter()
                .position(|topic| matches_id(topic, id))
                .ok_or("Topic not found")?,
        )
    };
    let index = existing.unwrap_or_else(|| {
        values.push(Topic {
            id: uuid::Uuid::new_v4().to_string(),
            title: title.into(),
            ..Default::default()
        });
        values.len() - 1
    });
    let topic = &mut values[index];
    let before = (
        topic.title.clone(),
        topic.purpose.clone(),
        topic.notes.clone(),
        topic.excluded,
    );
    if id.is_empty() {
        // Repeated creation adds intent to the existing topic and never resets reviewed content.
        append_unique(&mut topic.purpose, purpose);
        if let Some(notes) = notes {
            append_unique(&mut topic.notes, notes);
        }
        topic.excluded = false;
    } else {
        topic.title = title.into();
        topic.purpose = purpose.into();
        if let Some(notes) = notes {
            topic.notes = notes.into();
        }
    }
    if let Some(pin) = request["pinned"].as_bool() {
        topic.pinned = pin;
    }
    if let Some(excluded) = request["excluded"].as_bool() {
        topic.excluded = excluded;
    }
    if before
        != (
            topic.title.clone(),
            topic.purpose.clone(),
            topic.notes.clone(),
            topic.excluded,
        )
    {
        topic.error.clear();
    }
    deduplicate(root, values)?;
    save_topics(root, values)
}

pub(super) fn reconcile_progress(manifest: &mut Manifest, topics: &[Topic]) -> bool {
    let before = json!([manifest.error, manifest.wiki_progress]);
    let active: Vec<_> = topics.iter().filter(|topic| !topic.excluded).collect();
    let failed = active
        .iter()
        .filter(|topic| !topic.error.is_empty())
        .count();
    let previous_failed = manifest
        .error
        .strip_prefix("Wiki processing failed for ")
        .and_then(|text| text.split_whitespace().next())
        .and_then(|count| count.parse::<usize>().ok());
    if previous_failed.is_some() {
        manifest.error = if failed == 0 {
            String::new()
        } else {
            format!("Wiki processing failed for {failed} topics; open Wiki to review and retry")
        };
    }
    if let Some(progress) = manifest
        .wiki_progress
        .as_mut()
        .filter(|progress| progress.stage == "complete")
    {
        progress.total = active.len();
        progress.completed = active.len() - failed;
        if let Some(previous_failed) = previous_failed {
            progress.failed = progress.failed.saturating_sub(previous_failed) + failed;
        }
    }
    before != json!([manifest.error, manifest.wiki_progress])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn topic(title: &str) -> Topic {
        Topic {
            id: uuid::Uuid::new_v4().to_string(),
            title: title.into(),
            purpose: "Track status".into(),
            ..Default::default()
        }
    }

    fn revision(text: &str, review: &str) -> Revision {
        Revision {
            id: uuid::Uuid::new_v4().to_string(),
            markdown: text.into(),
            content_hash: store::digest(text),
            citations: vec![SourceRef {
                id: "meeting".into(),
                quote: "Friday remains tentative".into(),
                revision: "r1".into(),
                ..Default::default()
            }],
            review: review.into(),
            reviewed_at: if review.is_empty() { "" } else { "review-time" }.into(),
            ..Default::default()
        }
    }

    #[test]
    fn legacy_duplicates_merge_once_preserving_manual_pages_reviews_and_old_links() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let mut published = topic("灵光记");
        published.published = Some(revision("# 灵光记\n\nApproved content", "approved"));
        published.last_fingerprint = "completed-inputs".into();
        published.last_attempt_fingerprint = "completed-inputs".into();
        save_page(
            &root,
            &published,
            published.published.as_ref().unwrap(),
            false,
        )
        .unwrap();
        let manual = "# 灵光记\n\nManually corrected content";
        fs::write(root.join(&published.id).join("published.md"), manual).unwrap();
        let mut candidate = topic(" 灵光记 ");
        candidate.candidate = Some(revision("# 灵光记\n\nNew proposal", ""));
        candidate.notes = "Keep this correction".into();
        candidate
            .history
            .push(revision("Rejected content", "rejected"));
        let mut excluded = topic("灵光记");
        excluded.excluded = true;
        excluded.purpose = "Do not reactivate this old purpose".into();
        excluded.error = "Obsolete duplicate error".into();
        save_page(
            &root,
            &candidate,
            candidate.candidate.as_ref().unwrap(),
            true,
        )
        .unwrap();
        save_topics(
            &root,
            &[candidate.clone(), excluded.clone(), published.clone()],
        )
        .unwrap();

        let merged = topics(&root).unwrap();
        assert_eq!(merged.len(), 1);
        let canonical = &merged[0];
        assert_eq!(canonical.id, published.id);
        assert_eq!(canonical.published.as_ref().unwrap().markdown, manual);
        assert_eq!(
            canonical.published.as_ref().unwrap().reviewed_at,
            "review-time"
        );
        assert_eq!(
            canonical.candidate.as_ref().unwrap().citations,
            candidate.candidate.as_ref().unwrap().citations
        );
        assert_eq!(canonical.notes, candidate.notes);
        assert_eq!(canonical.purpose, published.purpose);
        assert_eq!(canonical.last_fingerprint, published.last_fingerprint);
        assert!(canonical
            .history
            .iter()
            .any(|page| page.review == "rejected"));
        assert!(matches_id(canonical, &candidate.id));
        assert!(matches_id(canonical, &excluded.id));
        assert!(!canonical.excluded);
        assert!(canonical.error.is_empty());
        assert_eq!(
            fs::read_to_string(root.join(&published.id).join("published.md")).unwrap(),
            manual
        );
        assert_eq!(
            fs::read_to_string(root.join(&published.id).join("candidate.md")).unwrap(),
            candidate.candidate.as_ref().unwrap().markdown
        );
        assert!(root.join(&candidate.id).join("candidate.md").exists());
        let backups: Vec<_> = fs::read_dir(root.join("topic-merges"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert_eq!(backups.len(), 1);
        let backup: Vec<Topic> = read_json(&backups[0]).unwrap();
        assert_eq!(
            backup
                .iter()
                .find(|topic| topic.id == published.id)
                .unwrap()
                .published
                .as_ref()
                .unwrap()
                .markdown,
            manual
        );
        let saved = fs::read(root.join("topics.json")).unwrap();
        assert_eq!(topics(&root).unwrap().len(), 1);
        assert_eq!(saved, fs::read(root.join("topics.json")).unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn repeated_creation_reuses_identity_without_retrying_or_overwriting_a_page() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let mut original = topic("Project Alpha");
        original.published = Some(revision("Approved content", "approved"));
        original.notes = "Manual correction".into();
        original.error = "Paused failure".into();
        original.last_attempt_fingerprint = "last-attempt".into();
        let mut values = vec![original.clone()];
        for title in [
            "project alpha",
            " Project  Alpha ",
            "Ｐｒｏｊｅｃｔ Ａｌｐｈａ",
        ] {
            upsert(
                &root,
                &mut values,
                &json!({"title":title,"purpose":"Track status"}),
            )
            .unwrap();
        }
        assert_eq!(values.len(), 1);
        assert_eq!(
            serde_json::to_value(&values[0]).unwrap(),
            serde_json::to_value(&original).unwrap()
        );
        upsert(
            &root,
            &mut values,
            &json!({"title":"Project Alpha","purpose":"Track blockers","notes":"New correction"}),
        )
        .unwrap();
        assert_eq!(values.len(), 1);
        assert_eq!(values[0].id, original.id);
        assert_eq!(values[0].purpose, "Track status\n\nTrack blockers");
        assert_eq!(values[0].notes, "Manual correction\n\nNew correction");
        assert!(values[0].error.is_empty());
        assert_eq!(
            values[0].published.as_ref().unwrap().markdown,
            "Approved content"
        );
        upsert(
            &root,
            &mut values,
            &json!({"title":"Project Alpha rollout","purpose":"Track status"}),
        )
        .unwrap();
        assert_eq!(values.len(), 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rename_collision_merges_and_updates_through_the_previous_id() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let mut original = topic("灵光记");
        original.published = Some(revision("Approved", "approved"));
        let other = topic("Temporary title");
        let mut values = vec![original.clone(), other.clone()];
        upsert(
            &root,
            &mut values,
            &json!({"id":other.id,"title":"灵光记","purpose":"Track status"}),
        )
        .unwrap();
        assert_eq!(values.len(), 1);
        assert!(matches_id(&values[0], &other.id));
        upsert(&root, &mut values, &json!({"id":other.id,"title":"灵光记","purpose":"Track status","notes":"Edited through old link","pinned":true})).unwrap();
        assert_eq!(values[0].id, original.id);
        assert_eq!(values[0].notes, "Edited through old link");
        assert!(values[0].pinned);
        let before = serde_json::to_value(&values).unwrap();
        assert!(upsert(
            &root,
            &mut values,
            &json!({"id":"missing","title":"灵光记"})
        )
        .is_err());
        assert_eq!(before, serde_json::to_value(&values).unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unchanged_duplicates_keep_completed_inputs_and_excluded_topics_are_restored_once() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let config = Models::default();
        let mut manifest = Manifest::default();
        let mut original = topic("灵光记");
        original.last_fingerprint = fingerprint(&original, &manifest, &config);
        let mut duplicate = topic("灵光记");
        duplicate.excluded = true;
        duplicate.error = "Old duplicate failure".into();
        save_topics(&root, &[duplicate, original]).unwrap();
        let mut values = topics(&root).unwrap();
        assert!(!needs_compilation(&values[0], &manifest, &config));
        manifest.error =
            "Wiki processing failed for 1 topics; open Wiki to review and retry".into();
        manifest.wiki_progress = Some(WikiProgress {
            stage: "complete".into(),
            total: 2,
            completed: 1,
            failed: 1,
            ..Default::default()
        });
        assert!(reconcile_progress(&mut manifest, &values));
        assert!(manifest.error.is_empty());
        assert_eq!(manifest.wiki_progress.as_ref().unwrap().total, 1);
        assert_eq!(manifest.wiki_progress.as_ref().unwrap().failed, 0);
        assert!(!reconcile_progress(&mut manifest, &values));
        values[0].excluded = true;
        let id = values[0].id.clone();
        upsert(
            &root,
            &mut values,
            &json!({"title":"灵光记","purpose":"Track status"}),
        )
        .unwrap();
        assert_eq!(values.len(), 1);
        assert_eq!(values[0].id, id);
        assert!(!values[0].excluded);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn merged_topics_produce_one_source_backed_wiki_node() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let local = root.join("meetings");
        let mut manifest = Manifest::default();
        manifest.enabled = true;
        manifest.allow_ai = true;
        let mut doc = Document {
            id: "meeting".into(),
            kind: "meeting".into(),
            title: "Launch meeting".into(),
            transcript: "Friday remains tentative".into(),
            ai_context_enabled: true,
            ..Default::default()
        };
        doc.refresh_revision();
        manifest.entries.insert(
            doc.id.clone(),
            store::write_document(&local, &doc, None).unwrap(),
        );
        let mut original = topic("灵光记");
        let mut page = revision("# 灵光记\n\nFriday remains tentative", "approved");
        page.citations = vec![SourceRef {
            quote: doc.transcript.clone(),
            ..doc.reference()
        }];
        original.published = Some(page);
        let duplicate = topic("灵光记");
        save_topics(&root, &[original.clone(), duplicate]).unwrap();
        let merged = topics(&root).unwrap();
        let graph = graph::view(&root, &local, &manifest, &merged, &Models::default()).unwrap();
        let wiki_nodes: Vec<_> = graph["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|node| node["kind"] == "wiki")
            .collect();
        assert_eq!(wiki_nodes.len(), 1);
        assert_eq!(wiki_nodes[0]["wikiId"], original.id);
        assert!(graph["edges"]
            .as_array()
            .unwrap()
            .iter()
            .any(|edge| edge["kind"] == "evidence"));
        fs::remove_dir_all(root).unwrap();
    }
}
