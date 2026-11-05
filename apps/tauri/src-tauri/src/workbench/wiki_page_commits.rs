//! Recover page exports and their topic heads as one logical publication.
use super::*;

#[derive(Default, Deserialize, Serialize)]
struct Commit {
    topic: Topic,
    page: Revision,
    candidate: bool,
    previous_hash: Option<String>,
}

fn path(root: &Path, id: &str, candidate: bool) -> PathBuf {
    root.join("page-commits").join(format!(
        "{id}-{}.json",
        if candidate { "candidate" } else { "published" }
    ))
}

pub(super) fn prepare(
    root: &Path,
    topic: &Topic,
    page: &Revision,
    candidate: bool,
) -> CommandResult<()> {
    let target = root.join(&topic.id).join(if candidate {
        "candidate.md"
    } else {
        "published.md"
    });
    write_json(
        &path(root, &topic.id, candidate),
        &Commit {
            topic: topic.clone(),
            page: page.clone(),
            candidate,
            previous_hash: fs::read(target).ok().map(store::digest),
        },
    )
}

pub(super) fn clear_completed(root: &Path, topics: &[Topic]) -> CommandResult<()> {
    let pending = match fs::read_dir(root.join("page-commits")) {
        Ok(pending) => pending,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    for entry in pending {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let commit: Commit = read_json(&entry.path())?;
        let page = topics
            .iter()
            .find(|topic| topic.id == commit.topic.id)
            .and_then(|topic| {
                if commit.candidate {
                    topic.candidate.as_ref()
                } else {
                    topic.published.as_ref()
                }
            });
        if page.is_some_and(|page| json!(page) == json!(commit.page)) {
            fs::remove_file(entry.path()).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

pub(super) fn recover(root: &Path, topics: &mut [Topic]) -> CommandResult<bool> {
    let pending = match fs::read_dir(root.join("page-commits")) {
        Ok(pending) => pending,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };
    let mut changed = false;
    for entry in pending {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let commit: Commit = read_json(&entry.path())?;
        uuid::Uuid::parse_str(&commit.topic.id).map_err(|_| "Invalid pending Wiki page")?;
        let Some(topic) = topics.iter_mut().find(|topic| topic.id == commit.topic.id) else {
            // Deletions and their tombstones take precedence over interrupted exports.
            fs::remove_file(entry.path()).map_err(|error| error.to_string())?;
            continue;
        };
        let name = if commit.candidate {
            "candidate"
        } else {
            "published"
        };
        let dir = root.join(&topic.id);
        let actual = fs::read(dir.join(format!("{name}.md")))
            .ok()
            .map(store::digest);
        if actual.is_some()
            && actual.as_ref() != Some(&commit.page.content_hash)
            && actual != commit.previous_hash
        {
            // A real external edit made after interruption remains authoritative.
            write_json(
                &dir.join("recovered")
                    .join(format!("{}.json", commit.page.id)),
                &commit.page,
            )?;
            fs::remove_file(entry.path()).map_err(|error| error.to_string())?;
            continue;
        }
        fs::create_dir_all(dir.join("revisions")).map_err(|error| error.to_string())?;
        let archive = dir
            .join("revisions")
            .join(format!("{}.json", commit.page.id));
        if !archive.exists() {
            write_json(&archive, &commit.page)?;
        }
        crate::atomic_write(
            &dir.join(format!("{name}.md")),
            commit.page.markdown.as_bytes(),
        )?;
        write_json(&dir.join(format!("{name}.json")), &commit.page)?;
        let current = if commit.candidate {
            &mut topic.candidate
        } else {
            &mut topic.published
        };
        if current
            .as_ref()
            .is_none_or(|page| json!(page) != json!(commit.page))
        {
            if let Some(old) = current.take() {
                if old.id != commit.page.id && !topic.history.iter().any(|page| page.id == old.id) {
                    topic.history.push(old);
                }
            }
            for page in &commit.topic.history {
                if !topic.history.iter().any(|old| old.id == page.id) {
                    topic.history.push(page.clone());
                }
            }
            *current = Some(commit.page.clone());
            if !commit.candidate
                && commit.page.review == "auto_validated"
                && !commit.page.cache_key.is_empty()
            {
                topic.last_fingerprint = commit.page.cache_key.clone();
                topic.last_attempt_fingerprint = commit.page.cache_key.clone();
                topic.error.clear();
                topic.failure = None;
                topic.force_refresh = false;
            }
            changed = true;
        }
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (PathBuf, Topic, Revision) {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let old = Revision {
            id: "old".into(),
            markdown: "old text".into(),
            content_hash: store::digest("old text"),
            ..Default::default()
        };
        let topic = Topic {
            id: uuid::Uuid::new_v4().to_string(),
            published: Some(old),
            ..Default::default()
        };
        let page = Revision {
            id: "new".into(),
            markdown: "new text".into(),
            content_hash: store::digest("new text"),
            review: "auto_validated".into(),
            cache_key: "new-inputs".into(),
            ..Default::default()
        };
        save_page(&root, &topic, topic.published.as_ref().unwrap(), false).unwrap();
        save_topics(&root, &[topic.clone()]).unwrap();
        (root, topic, page)
    }
    #[test]
    fn interrupted_internal_publication_recovers_head_without_becoming_a_manual_edit() {
        let (root, topic, page) = fixture();
        save_page(&root, &topic, &page, false).unwrap();
        let restored = topics(&root).unwrap();
        assert_eq!(restored[0].published.as_ref().unwrap().id, "new");
        assert_eq!(
            restored[0].published.as_ref().unwrap().content_hash,
            store::digest("new text")
        );
        assert_eq!(restored[0].last_fingerprint, "new-inputs");
        assert_eq!(restored[0].history[0].id, "old");
        assert!(!path(&root, &topic.id, false).exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn a_real_external_edit_after_interruption_is_never_overwritten() {
        let (root, topic, page) = fixture();
        save_page(&root, &topic, &page, false).unwrap();
        fs::write(root.join(&topic.id).join("published.md"), "human edit").unwrap();
        let restored = topics(&root).unwrap();
        assert_eq!(
            restored[0].published.as_ref().unwrap().markdown,
            "human edit"
        );
        assert!(root.join(&topic.id).join("recovered/new.json").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
