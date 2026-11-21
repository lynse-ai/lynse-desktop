//! Topic heads live in per-topic files (`topics/<id>.json`) so a save rewrites
//! only what changed, and collection member details park in sidecars
//! (`topics/<id>.collection.json`) so the common read path never loads them.
//! Immutable revision bodies stay in the per-topic `archive/` store. The
//! legacy single `topics.json` migrates once, atomically last, and its
//! renamed snapshot doubles as the recovery point.
use super::*;
use std::sync::{Arc, Mutex, OnceLock};

type Cached = (std::time::SystemTime, u64, Arc<Revision>);
static REVISIONS: OnceLock<Mutex<std::collections::BTreeMap<PathBuf, Cached>>> = OnceLock::new();
type CachedCollection = (std::time::SystemTime, u64, Arc<collections::Collection>);
static DETAILS: OnceLock<Mutex<std::collections::BTreeMap<PathBuf, CachedCollection>>> =
    OnceLock::new();

fn topics_dir(root: &Path) -> PathBuf {
    root.join("topics")
}

fn head_path(root: &Path, topic: &str) -> PathBuf {
    topics_dir(root).join(format!("{topic}.json"))
}

fn sidecar_path(root: &Path, topic: &str) -> PathBuf {
    topics_dir(root).join(format!("{topic}.collection.json"))
}

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
    // Entries hold full revision pages; a large cap let long histories pin
    // hundreds of MB. 256 recent pages is plenty for readers jumping topics.
    if cache.len() >= 256 {
        if let Some(key) = cache.keys().next().cloned() {
            cache.remove(&key);
        }
    }
    cache.insert(path, (modified, metadata.len(), Arc::new(page.clone())));
    Ok(page)
}

/// Split the collection out of a head value: member links park in the
/// sidecar, the head keeps a stub plus the content digest. Returns the
/// sidecar bytes when the detail store must be written (Some with empty
/// bytes means an emptied collection whose sidecar should be removed).
fn split_head_collection(topic: &Topic, head: &mut Value) -> CommandResult<Option<Vec<u8>>> {
    if !head.get("collection").is_some_and(|collection| collection.is_object()) {
        return Ok(None);
    }
    let links_empty = head
        .get("collection")
        .and_then(|collection| collection.get("links"))
        .and_then(Value::as_array)
        .is_none_or(|links| links.is_empty());
    if links_empty {
        if topic.collection_loaded {
            // Emptied in this session: the sidecar has nothing left to keep.
            head["collectionRef"] = json!("");
            return Ok(Some(Vec::new()));
        }
        // Stub read back from disk: the parked sidecar stays untouched.
        return Ok(None);
    }
    let bytes = serde_json::to_vec(&head["collection"]).map_err(|error| error.to_string())?;
    let key = store::digest(&bytes);
    head["collectionRef"] = json!(key);
    head["collection"]["links"] = json!([]);
    Ok(Some(bytes))
}

fn write_if_changed(path: &Path, bytes: &[u8]) -> CommandResult<()> {
    if fs::read(path).ok().as_deref() == Some(bytes) {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    crate::atomic_write(path, bytes)
}

/// One-time migration: legacy `topics.json` heads (inline revisions included)
/// become per-topic head files plus sidecars, revision pages compress into
/// the archive store, and the legacy file renames away last — its presence
/// marks an unfinished migration, so a crash re-runs the whole sweep.
fn migrate_legacy(root: &Path) -> CommandResult<()> {
    let legacy = root.join("topics.json");
    if !legacy.exists() {
        return Ok(());
    }
    let values: Vec<Value> = read_json(&legacy)?;
    for value in &values {
        let id = value["id"]
            .as_str()
            .ok_or("Invalid Wiki topic ID; original preserved")?
            .to_owned();
        let mut topic: Topic = serde_json::from_value(value.clone())
            .map_err(|error| error.to_string())?;
        let mut head = json!(&topic);
        for (name, page) in [
            ("published", topic.published.as_ref()),
            ("candidate", topic.candidate.as_ref()),
        ] {
            if let Some(page) = page {
                head[name] = save_revision(root, &id, page)?;
            }
        }
        head["history"] = json!(topic
            .history
            .iter()
            .map(|page| save_revision(root, &id, page))
            .collect::<CommandResult<Vec<_>>>()?);
        let sidecar = split_head_collection(&topic, &mut head)?;
        if let Some(bytes) = sidecar {
            if bytes.is_empty() {
                let _ = fs::remove_file(sidecar_path(root, &id));
            } else {
                write_if_changed(&sidecar_path(root, &id), &bytes)?;
            }
        }
        write_if_changed(&head_path(root, &id), &serde_json::to_vec(&head).map_err(|e| e.to_string())?);
    }
    write_index(
        root,
        &values
            .iter()
            .filter_map(|value| value["id"].as_str().map(str::to_owned))
            .collect::<Vec<_>>(),
    )?;
    let backup = root.join("topics.json.migrated");
    if backup.exists() {
        fs::remove_file(&backup).map_err(|error| error.to_string())?;
    }
    fs::rename(&legacy, &backup).map_err(|error| error.to_string())?;
    Ok(())
}

/// Topic order for the sharded store: the legacy array order is preserved in
/// a slim index so reads, merges and UI rows keep their sequence.
fn index_path(root: &Path) -> PathBuf {
    topics_dir(root).join("index.json")
}

fn write_index(root: &Path, ids: &[String]) -> CommandResult<()> {
    let bytes = serde_json::to_vec_pretty(ids).map_err(|error| error.to_string())?;
    write_if_changed(&index_path(root), &bytes)
}

fn read_index(root: &Path) -> Vec<String> {
    fs::read(index_path(root))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

pub(super) fn load(root: &Path) -> CommandResult<Vec<Topic>> {
    migrate_legacy(root)?;
    let dir = topics_dir(root);
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let deleted = topic_store::deleted(root)?;
    let mut files: Vec<PathBuf> = Vec::new();
    for entry in entries {
        let path = entry.map_err(|error| error.to_string())?.path();
        // Collection sidecars (`<id>.collection.json`) and the order index
        // are store bookkeeping, not heads.
        let is_sidecar = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .is_some_and(|stem| stem.ends_with(".collection") || stem == "index");
        if is_sidecar || path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        files.push(path);
    }
    let index = read_index(root);
    files.sort_by_key(|path| {
        path.file_stem()
            .and_then(|stem| stem.to_str())
            .and_then(|stem| index.iter().position(|id| id == stem))
            .unwrap_or(usize::MAX)
    });
    let mut topics = Vec::new();
    for path in files {
        let value: Value = serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
            .map_err(|error| error.to_string())?;
        let id = value["id"]
            .as_str()
            .ok_or("Invalid Wiki topic ID; original preserved")?
            .to_owned();
        if deleted.contains(&id) {
            continue;
        }
        uuid::Uuid::parse_str(&id).map_err(|_| "Invalid Wiki topic ID; original preserved")?;
        let mut value = value;
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
        topics.push(
            serde_json::from_value(value)
                .map_err(|error| error.to_string())?,
        );
    }
    Ok(topics)
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
    fs::create_dir_all(topics_dir(root)).map_err(|error| error.to_string())?;
    let mut kept: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut kept_order: Vec<String> = Vec::new();
    for topic in topics {
        uuid::Uuid::parse_str(&topic.id)
            .map_err(|_| "Invalid Wiki topic ID; original preserved")?;
        kept.insert(topic.id.clone());
        kept_order.push(topic.id.clone());
        let mut head = json!(topic);
        for (name, page) in [
            ("published", topic.published.as_ref()),
            ("candidate", topic.candidate.as_ref()),
        ] {
            if let Some(page) = page {
                head[name] = save_revision(root, &topic.id, page)?;
            }
        }
        head["history"] = json!(topic
            .history
            .iter()
            .map(|page| save_revision(root, &topic.id, page))
            .collect::<CommandResult<Vec<_>>>()?);
        let sidecar = split_head_collection(topic, &mut head)?;
        match sidecar {
            Some(bytes) if bytes.is_empty() => {
                let _ = fs::remove_file(sidecar_path(root, &topic.id));
            }
            Some(bytes) => write_if_changed(&sidecar_path(root, &topic.id), &bytes)?,
            None => {}
        }
        write_if_changed(
            &head_path(root, &topic.id),
            &serde_json::to_vec(&head).map_err(|e| e.to_string())?,
        )?;
    }
    write_index(root, &kept_order)?;
    // Sweep heads (and their sidecars) for topics that no longer exist —
    // tombstoned deletions leave no entry in the saved list.
    let entries = match fs::read_dir(topics_dir(root)) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };
    for entry in entries {
        let path = match entry {
            Ok(entry) => entry.path(),
            Err(_) => continue,
        };
        let Some(name) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        let is_collection_sidecar = path
            .extension()
            .and_then(|extension| extension.to_str())
            == Some("json")
            && name.ends_with(".collection");
        let id = name.strip_suffix(".collection").unwrap_or(name);
        // The order index is store bookkeeping, never an orphan head.
        if id == "index" || kept.contains(id) {
            continue;
        }
        let _ = fs::remove_file(&path);
        if is_collection_sidecar {
            continue;
        }
        let _ = fs::remove_file(sidecar_path(root, id));
    }
    Ok(())
}

/// Aggregate identity of every head file: the idle-skip cache and the UI
/// refresh revision replace the legacy single-file stat with this scan, so a
/// per-topic write still invalidates both.
pub(super) fn heads_signature(root: &Path) -> Option<String> {
    let entries = fs::read_dir(topics_dir(root)).ok()?;
    let mut rows: Vec<(String, u64, Option<String>)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let meta = entry.metadata().ok()?;
        rows.push((
            path.file_name()?.to_str()?.to_owned(),
            meta.len(),
            meta.modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|time| time.as_nanos().to_string()),
        ));
    }
    rows.sort();
    Some(store::digest(json!(rows).to_string()))
}

/// Full collection detail for one topic. Heads carry a stub; the sidecar
/// holds the member links, digest-verified and cached on (mtime, size).
pub(super) fn collection_detail(root: &Path, topic: &Topic) -> Option<collections::Collection> {
    let Some(collection) = topic.collection.as_ref() else {
        return None;
    };
    if topic.collection_ref.is_empty() {
        return Some(collection.clone());
    }
    let path = sidecar_path(root, &topic.id);
    let metadata = fs::metadata(&path).ok()?;
    let modified = metadata.modified().ok()?;
    let cache = DETAILS.get_or_init(Default::default);
    if let Some((_, _, detail)) = cache
        .lock()
        .ok()?
        .get(&path)
        .filter(|(time, size, _)| *time == modified && *size == metadata.len())
    {
        return Some((**detail).clone());
    }
    let bytes = fs::read(&path).ok()?;
    if store::digest(&bytes) != topic.collection_ref {
        return None;
    }
    let mut detail: collections::Collection = serde_json::from_slice(&bytes).ok()?;
    detail.links = std::mem::take(&mut detail.links);
    let detail = detail;
    let mut cache = cache.lock().ok()?;
    if cache.len() >= 32 {
        if let Some(key) = cache.keys().next().cloned() {
            cache.remove(&key);
        }
    }
    cache.insert(path, (modified, metadata.len(), Arc::new(detail.clone())));
    Some(detail)
}

/// Load parked collection details into the in-memory topics for lanes that
/// mutate or read member links. Stubs stay stubs everywhere else.
pub(super) fn hydrate_collections(root: &Path, topics: &mut [Topic]) -> CommandResult<()> {
    for topic in topics.iter_mut() {
        if topic.collection.is_none()
            || topic.collection_loaded
            || topic.collection_ref.is_empty()
        {
            continue;
        }
        if let Some(detail) = collection_detail(root, topic) {
            topic.collection = Some(detail);
            topic.collection_loaded = true;
        }
    }
    Ok(())
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
        assert!(!root.join("topics.json").exists());
        assert!(root.join("topics.json.migrated").exists());
        let heads_len = fs::read_to_string(head_path(&root, &topic.id)).unwrap().len();
        assert!(heads_len < 2000);
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
        fs::create_dir_all(topics_dir(&root)).unwrap();
        crate::atomic_write(
            &head_path(&root, &id),
            &json!({"id":id,"published":{"archiveRef":"../../outside"}})
                .to_string()
                .into_bytes(),
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
    #[test]
    fn collection_details_park_in_sidecars_and_survive_the_round_trip() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let topic = Topic {
            id: uuid::Uuid::new_v4().to_string(),
            collection: Some(collections::Collection {
                hierarchy: false,
                links: vec![collections::TopicLink {
                    target_id: "member".into(),
                    state: "included".into(),
                    ..Default::default()
                }],
                ..Default::default()
            }),
            ..Default::default()
        };
        save(&root, &[topic.clone()]).unwrap();
        let head = fs::read_to_string(head_path(&root, &topic.id)).unwrap();
        assert!(!head.contains("member"), "links must park in the sidecar");
        let sidecar = fs::read_to_string(sidecar_path(&root, &topic.id)).unwrap();
        assert!(sidecar.contains("member"));
        // Load returns the stub; the detail hydrates on demand and round-trips.
        let loaded = load(&root).unwrap();
        assert!(loaded[0].collection.as_ref().unwrap().links.is_empty());
        assert!(!loaded[0].collection_ref.is_empty());
        assert!(!loaded[0].collection_loaded);
        let detail = collection_detail(&root, &loaded[0]).unwrap();
        assert_eq!(detail.links.len(), 1);
        assert_eq!(detail.links[0].target_id, "member");
        // An emptied hydrated collection removes the sidecar.
        let mut emptied = loaded[0].clone();
        emptied.collection_loaded = true;
        emptied.collection.as_mut().unwrap().links.clear();
        save(&root, &[emptied]).unwrap();
        assert!(!sidecar_path(&root, &topic.id).exists());
        let reloaded = load(&root).unwrap();
        assert!(reloaded[0].collection_ref.is_empty());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn tombstoned_head_files_are_swept_on_save() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let topic = Topic {
            id: uuid::Uuid::new_v4().to_string(),
            ..Default::default()
        };
        save(&root, &[topic.clone()]).unwrap();
        assert!(head_path(&root, &topic.id).exists());
        save(&root, &[]).unwrap();
        assert!(!head_path(&root, &topic.id).exists());
        fs::remove_dir_all(root).unwrap();
    }
}
