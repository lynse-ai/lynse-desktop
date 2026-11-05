//! Keep topic heads small while preserving immutable revision bodies and legacy reads.
use super::*;
use std::sync::{Arc, Mutex, OnceLock};

type Cached = (std::time::SystemTime, u64, Arc<Revision>);
static REVISIONS: OnceLock<Mutex<std::collections::BTreeMap<PathBuf, Cached>>> = OnceLock::new();

fn revision(root: &Path, topic: &str, value: &Value) -> CommandResult<Revision> {
    let Some(key) = value["archiveRef"].as_str() else {
        return serde_json::from_value(value.clone())
            .map_err(|_| "Wiki revision is unreadable; original preserved".into());
    };
    if key.len() != 64 || !key.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Invalid Wiki revision archive; original preserved".into());
    }
    let path = root.join(topic).join("archive").join(format!("{key}.json"));
    let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
    let modified = metadata.modified().map_err(|error| error.to_string())?;
    let cache = REVISIONS.get_or_init(Default::default);
    if let Some((_, _, page)) = cache
        .lock()
        .map_err(|_| "Wiki archive cache unavailable")?
        .get(&path)
        .filter(|(time, size, _)| *time == modified && *size == metadata.len())
    {
        return Ok((**page).clone());
    }
    let bytes = fs::read(&path).map_err(|error| error.to_string())?;
    if store::digest(&bytes) != key {
        return Err("Wiki revision archive changed; original preserved".into());
    }
    let page: Revision = serde_json::from_slice(&bytes)
        .map_err(|_| "Wiki revision archive is unreadable; original preserved")?;
    let mut cache = cache.lock().map_err(|_| "Wiki archive cache unavailable")?;
    if cache.len() >= 4096 {
        if let Some(key) = cache.keys().next().cloned() {
            cache.remove(&key);
        }
    }
    cache.insert(path, (modified, metadata.len(), Arc::new(page.clone())));
    Ok(page)
}

pub(super) fn load(root: &Path) -> CommandResult<Vec<Topic>> {
    let values: Vec<Value> = read_json(&root.join("topics.json"))?;
    let deleted = topic_store::deleted(root)?;
    values
        .into_iter()
        .filter(|value| !value["id"].as_str().is_some_and(|id| deleted.contains(id)))
        .map(|mut value| {
            let id = value["id"]
                .as_str()
                .ok_or("Invalid Wiki topic ID; original preserved")?
                .to_owned();
            uuid::Uuid::parse_str(&id).map_err(|_| "Invalid Wiki topic ID; original preserved")?;
            for name in ["published", "candidate"] {
                if !value[name].is_null() {
                    value[name] = json!(revision(root, &id, &value[name])?);
                }
            }
            if let Some(history) = value["history"].as_array_mut() {
                for page in history {
                    *page = json!(revision(root, &id, page)?);
                }
            }
            serde_json::from_value(value)
                .map_err(|_| "Wiki topic is unreadable; original preserved".into())
        })
        .collect()
}

fn save_revision(root: &Path, topic: &str, page: &Revision) -> CommandResult<Value> {
    let bytes = serde_json::to_vec(page).map_err(|error| error.to_string())?;
    let key = store::digest(&bytes);
    let path = root.join(topic).join("archive").join(format!("{key}.json"));
    if !path.exists() {
        fs::create_dir_all(path.parent().unwrap()).map_err(|error| error.to_string())?;
        crate::atomic_write(&path, &bytes)?;
    }
    Ok(json!({"id":page.id,"archiveRef":key}))
}

pub(super) fn save(root: &Path, topics: &[Topic]) -> CommandResult<()> {
    let mut heads = Vec::with_capacity(topics.len());
    for topic in topics {
        uuid::Uuid::parse_str(&topic.id)
            .map_err(|_| "Invalid Wiki topic ID; original preserved")?;
        let mut value = json!(topic);
        for (name, page) in [
            ("published", topic.published.as_ref()),
            ("candidate", topic.candidate.as_ref()),
        ] {
            if let Some(page) = page {
                value[name] = save_revision(root, &topic.id, page)?;
            }
        }
        value["history"] = json!(topic
            .history
            .iter()
            .map(|page| save_revision(root, &topic.id, page))
            .collect::<CommandResult<Vec<_>>>()?);
        heads.push(value);
    }
    write_json(&root.join("topics.json"), &heads)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn migrates_legacy_heads_without_losing_history_or_same_id_reference_updates() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let mut topic = Topic {
            id: uuid::Uuid::new_v4().to_string(),
            notes: "User correction".into(),
            published: Some(Revision {
                id: "published".into(),
                markdown: "content".repeat(1000),
                review: "approved".into(),
                ..Default::default()
            }),
            history: vec![Revision {
                id: "history".into(),
                markdown: "old text".repeat(1000),
                ..Default::default()
            }],
            ..Default::default()
        };
        write_json(&root.join("topics.json"), &vec![topic.clone()]).unwrap();
        let original = load(&root).unwrap();
        save(&root, &original).unwrap();
        let heads = fs::read_to_string(root.join("topics.json")).unwrap();
        assert!(heads.len() < 2000);
        assert_eq!(json!(load(&root).unwrap()), json!(original));
        topic.published.as_mut().unwrap().fingerprint = "rebound".into();
        save(&root, &[topic.clone()]).unwrap();
        assert_eq!(json!(load(&root).unwrap()[0]), json!(topic));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn refuses_damaged_or_outside_revision_references() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let id = uuid::Uuid::new_v4().to_string();
        write_json(
            &root.join("topics.json"),
            &json!([{"id":id,"published":{"archiveRef":"../../outside"}}]),
        )
        .unwrap();
        assert!(load(&root)
            .err()
            .unwrap()
            .contains("Invalid Wiki revision archive"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn interrupted_deletion_does_not_hydrate_a_removed_revision_archive() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let page = Revision {
            id: "page".into(),
            markdown: "Preserved history".into(),
            ..Default::default()
        };
        let removed = Topic {
            id: uuid::Uuid::new_v4().to_string(),
            published: Some(page.clone()),
            ..Default::default()
        };
        let retained = Topic {
            id: uuid::Uuid::new_v4().to_string(),
            published: Some(page),
            ..Default::default()
        };
        save(&root, &[removed.clone(), retained.clone()]).unwrap();
        write_json(
            &root.join("deleted-topics.json"),
            &std::collections::BTreeSet::from([removed.id.clone()]),
        )
        .unwrap();
        fs::remove_dir_all(root.join(&removed.id)).unwrap();
        let loaded = load(&root).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, retained.id);
        assert_eq!(
            loaded[0].published.as_ref().unwrap().markdown,
            "Preserved history"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
