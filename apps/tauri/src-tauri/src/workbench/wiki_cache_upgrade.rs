//! Adopt old completed work only after its exact prior input identity is proven.
use super::*;

fn rebound_rows(
    rows: &[CatalogTopic],
    source: &Document,
    docs: &[Document],
    manifest: &Manifest,
) -> CommandResult<Vec<CatalogTopic>> {
    let mut rows = rows.to_vec();
    for row in &mut rows {
        let value = content_cache::rebind(json!({"citations":row.citations}), docs, manifest)?;
        row.citations = serde_json::from_value(value["citations"].clone())
            .map_err(|_| "Invalid cached catalog citations")?;
        if !row
            .citations
            .iter()
            .any(|reference| reference.id == source.id)
        {
            return Err("Cached catalog omitted its source".into());
        }
        sync::validate_result(docs, manifest, &json!({"citations":row.citations}))?;
    }
    Ok(rows)
}

pub(super) fn refresh(
    root: &Path,
    catalog: &mut Catalog,
    docs: &[Document],
    manifest: &Manifest,
    config: &Models,
    legacy: &[Models],
) -> CommandResult<()> {
    let mut variants = vec![config.clone()];
    variants.extend_from_slice(legacy);
    let mut catalog_changed = false;
    for source in docs {
        // Source-wide hashes do not depend on chunk boundaries. Compute each
        // saved-model identity once instead of repeating it for every chunk.
        let legacy_input_keys: Vec<String> = variants
            .iter()
            .map(|old| legacy_input_key(source, old))
            .collect();
        let source_input_keys: Vec<String> =
            variants.iter().map(|old| input_key(source, old)).collect();
        for (index, text) in source_chunks(source, catalog).into_iter().enumerate() {
            let key = catalog_chunk_key(source, &text, config);
            let mut candidates = vec![key.clone()];
            for (variant_index, old) in variants.iter().enumerate() {
                // Keeping the original physical revision in this proof is
                // essential: old receipts did not retain the source title.
                candidates.push(format!("{}:{index}", legacy_input_keys[variant_index]));
                candidates.push(format!("{}:{index}", source_input_keys[variant_index]));
                candidates.push(catalog_chunk_key(source, &text, old));
            }
            for candidate in &candidates {
                if let Some(error) = catalog.failed.get(candidate).cloned() {
                    if candidate != &key {
                        catalog.failed.insert(key.clone(), error);
                        if let Some(mut detail) = catalog.details.get(candidate).cloned() {
                            detail.id = key.clone();
                            catalog.details.insert(key.clone(), detail);
                        }
                        catalog.failed.remove(candidate);
                        catalog.details.remove(candidate);
                        catalog_changed = true;
                    }
                    break;
                }
                let Some(rows) = catalog.chunks.get(candidate) else {
                    continue;
                };
                let Ok(rows) = rebound_rows(rows, source, docs, manifest) else {
                    continue;
                };
                if catalog
                    .chunks
                    .get(&key)
                    .is_none_or(|saved| json!(saved) != json!(rows))
                {
                    catalog.chunks.insert(key.clone(), rows);
                    catalog_changed = true;
                }
                break;
            }
            if catalog.chunks.contains_key(&key) && !catalog.failed.contains_key(&key) {
                for candidate in candidates {
                    catalog_changed |= catalog.details.remove(&candidate).is_some();
                    if candidate != key {
                        catalog_changed |= catalog.failed.remove(&candidate).is_some();
                    }
                }
            }
        }
    }
    if catalog_changed {
        write_json(&catalog_path(root), catalog)?;
    }
    // Hash each source once per model identity. Page lookup then combines
    // those hashes without rehashing full meeting transcripts for every topic.
    let source_keys: Vec<BTreeMap<String, String>> = variants
        .iter()
        .map(|variant| {
            docs.iter()
                .map(|doc| (doc.id.clone(), input_key(doc, variant)))
                .collect()
        })
        .collect();
    let legacy_source_keys: Vec<BTreeMap<String, String>> = variants
        .iter()
        .map(|variant| {
            docs.iter()
                .map(|doc| (doc.id.clone(), legacy_input_key(doc, variant)))
                .collect()
        })
        .collect();
    let mut values = topics(root)?;
    let mut changed = false;
    for topic in &mut values {
        if topic.collection.is_some()
            || topic.excluded
            || topic.force_refresh
            || topic.automatic_key.is_empty()
        {
            continue;
        }
        let selected_keys: Vec<_> = topic
            .source_ids
            .iter()
            .filter_map(|id| source_keys[0].get(id).cloned())
            .collect();
        if selected_keys.is_empty() {
            continue;
        }
        let version = page_version_keys(topic, selected_keys.clone(), &config.text_revision);
        if topic.last_fingerprint != version {
            let old_match = variants.iter().enumerate().any(|(index, old)| {
                let current = topic
                    .source_ids
                    .iter()
                    .filter_map(|id| source_keys[index].get(id).cloned())
                    .collect();
                let legacy = topic
                    .source_ids
                    .iter()
                    .filter_map(|id| legacy_source_keys[index].get(id).cloned())
                    .collect();
                topic.last_fingerprint
                    == legacy_page_version_keys(topic, legacy, &old.text_revision)
                    || topic.last_fingerprint
                        == page_version_keys(topic, current, &old.text_revision)
            });
            if !old_match {
                continue;
            }
        }
        let selected: Vec<_> = docs
            .iter()
            .filter(|source| topic.source_ids.contains(&source.id))
            .cloned()
            .collect();
        let Some(page) = topic.published.as_ref().filter(|page| {
            page.content_hash == store::digest(&page.markdown)
                && matches!(page.review.as_str(), "approved" | "auto_validated")
        }) else {
            continue;
        };
        let Ok(value) = content_cache::rebind(json!(page), &selected, manifest) else {
            continue;
        };
        let mut rebound: Revision =
            serde_json::from_value(value).map_err(|_| "Invalid cached Wiki page")?;
        if sync::validate_result(&selected, manifest, &json!({"citations":rebound.citations}))
            .is_err()
        {
            continue;
        }
        rebound.fingerprint = page_fingerprint(topic, manifest, config, &rebound.citations);
        rebound.cache_key = version.clone();
        if json!(page) != json!(rebound) || topic.last_fingerprint != version {
            save_page(root, topic, &rebound, false)?;
            topic.published = Some(rebound);
            topic.last_fingerprint = version.clone();
            // A failed newer attempt remains a failure until it is retried.
            if topic.error.is_empty() {
                topic.last_attempt_fingerprint = version;
            }
            changed = true;
        }
    }
    if changed {
        save_topics(root, &values)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_legacy_content_is_adopted_and_metadata_rebind_keeps_the_same_page() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let local = root.join("sources");
        let wiki = root.join("wiki");
        let mut source = Document {
            id: "source".into(),
            kind: "meeting".into(),
            title: "Meeting".into(),
            transcript: "The release is planned.".into(),
            ai_context_enabled: true,
            ..Default::default()
        };
        source.refresh_revision();
        let mut manifest = Manifest::default();
        manifest.entries.insert(
            source.id.clone(),
            store::write_document(&local, &source, None).unwrap(),
        );
        let old = Models {
            text_revision: "old-selection".into(),
            ..Default::default()
        };
        let new = Models {
            text_revision: "new-effective-identity".into(),
            ..Default::default()
        };
        let refs = vec![SourceRef {
            quote: "The release is planned.".into(),
            ..source.reference()
        }];
        let mut topic = Topic {
            id: uuid::Uuid::new_v4().to_string(),
            title: "Release".into(),
            automatic_key: "project:source:release".into(),
            source_ids: vec![source.id.clone()],
            ..Default::default()
        };
        topic.last_fingerprint = legacy_page_version(&topic, &[source.clone()], &old);
        topic.published = Some(Revision {
            id: "preserved".into(),
            markdown: "Saved page".into(),
            content_hash: store::digest("Saved page"),
            citations: refs.clone(),
            review: "auto_validated".into(),
            ..Default::default()
        });
        save_topics(&wiki, &[topic]).unwrap();
        let row = CatalogTopic {
            key: "release".into(),
            existing_id: None,
            title: "Release".into(),
            kind: "project".into(),
            overview: "Release plan".into(),
            citations: refs,
        };
        let mut catalog = Catalog::default();
        catalog
            .chunks
            .insert(format!("{}:0", legacy_input_key(&source, &old)), vec![row]);
        refresh(
            &wiki,
            &mut catalog,
            &[source.clone()],
            &manifest,
            &new,
            &[old],
        )
        .unwrap();
        assert_eq!(
            topics(&wiki).unwrap()[0].published.as_ref().unwrap().id,
            "preserved"
        );
        source.folder_id = "new-folder".into();
        source.refresh_revision();
        let previous = manifest.entries.get(&source.id).cloned();
        manifest.entries.insert(
            source.id.clone(),
            store::write_document(&local, &source, previous.as_ref()).unwrap(),
        );
        refresh(&wiki, &mut catalog, &[source.clone()], &manifest, &new, &[]).unwrap();
        let saved = topics(&wiki).unwrap();
        assert_eq!(saved[0].published.as_ref().unwrap().id, "preserved");
        assert_eq!(
            saved[0].published.as_ref().unwrap().citations[0].revision,
            source.revision
        );
        assert_eq!(
            saved[0].last_fingerprint,
            page_version(&saved[0], &[source], &manifest, &new)
        );
        fs::remove_dir_all(root).unwrap();
    }
}
