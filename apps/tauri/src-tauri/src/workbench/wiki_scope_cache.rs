//! Adopt scoped legacy receipts only when their complete input hash still matches.
use super::*;

const MAX_LEGACY_SCOPE_FOLDERS: usize = 10;
const MAX_LEGACY_SCOPE_PROBES: usize = 16_384;

fn legacy_inputs(topic: &Topic, docs: &[Document], config: &Models) -> Value {
    legacy_inputs_with_keys(
        topic,
        docs.iter().map(|doc| input_key(doc, config)).collect(),
        config,
    )
}

fn legacy_inputs_with_keys(topic: &Topic, keys: Vec<String>, config: &Models) -> Value {
    json!([
        "wiki-auto-page-v1",
        topic.id,
        topic.title,
        topic.purpose,
        topic.notes,
        topic.source_ids,
        keys,
        Value::Null,
        config.text_revision
    ])
}

pub(super) fn legacy_version(
    topic: &Topic,
    docs: &[Document],
    policy: &store::WikiAutomation,
    config: &Models,
) -> String {
    let mut inputs = legacy_inputs(topic, docs, config);
    inputs[7] = json!(policy);
    store::digest(inputs.to_string())
}

struct LegacyScopes {
    known: Vec<store::WikiAutomation>,
    folders: Vec<String>,
    probes: usize,
    source_keys: BTreeMap<String, String>,
}

impl LegacyScopes {
    fn new(manifest: &Manifest, docs: &[Document], config: &Models) -> Self {
        let current = manifest.wiki_automation.clone();
        // Range extensions retain the relative order saved by older clients.
        let folders = current
            .as_ref()
            .map(|scope| scope.folder_ids.clone())
            .unwrap_or_default();
        Self {
            known: current.into_iter().collect(),
            folders,
            probes: MAX_LEGACY_SCOPE_PROBES,
            source_keys: docs
                .iter()
                .map(|doc| (doc.id.clone(), input_key(doc, config)))
                .collect(),
        }
    }

    fn matching(
        &mut self,
        topic: &Topic,
        docs: &[Document],
        config: &Models,
        expected: &str,
    ) -> Option<store::WikiAutomation> {
        let keys = docs
            .iter()
            .map(|doc| {
                self.source_keys
                    .get(&doc.id)
                    .cloned()
                    .unwrap_or_else(|| input_key(doc, config))
            })
            .collect();
        let mut inputs = legacy_inputs_with_keys(topic, keys, config);
        for policy in &self.known {
            inputs[7] = json!(policy);
            if store::digest(inputs.to_string()) == expected {
                return Some(policy.clone());
            }
        }
        // Older files did not retain range snapshots. Bound the search and adopt
        // only an exact hash match; unknown or changed inputs remain untouched.
        if self.folders.len() > MAX_LEGACY_SCOPE_FOLDERS || self.probes == 0 {
            return None;
        }
        for mask in 0..(1usize << self.folders.len()) {
            let folder_ids: Vec<_> = self
                .folders
                .iter()
                .enumerate()
                .filter(|(index, _)| mask & (1 << index) != 0)
                .map(|(_, id)| id.clone())
                .collect();
            for include_unfiled in [false, true] {
                if !docs.iter().all(|doc| {
                    if doc.folder_id.is_empty() {
                        include_unfiled
                    } else {
                        folder_ids.contains(&doc.folder_id)
                    }
                }) {
                    continue;
                }
                if self.probes == 0 {
                    return None;
                }
                self.probes -= 1;
                let policy = store::WikiAutomation {
                    folder_ids: folder_ids.clone(),
                    include_unfiled,
                };
                inputs[7] = json!(policy);
                if store::digest(inputs.to_string()) == expected {
                    self.known.push(policy.clone());
                    return Some(policy);
                }
            }
        }
        None
    }
}

pub(in crate::workbench::wiki) fn migrate(
    root: &Path,
    local: &Path,
    docs: &[Document],
    manifest: &Manifest,
    config: &Models,
) -> CommandResult<usize> {
    if manifest.wiki_automation.is_none() {
        return Ok(0);
    }
    let mut scopes = LegacyScopes::new(manifest, docs, config);
    let mut sources = PageSources::new(local, manifest);
    let mut values = topics(root)?;
    let mut changed = false;
    let mut retained = 0;
    for topic in &mut values {
        if topic.collection.is_some()
            || topic.excluded
            || topic.force_refresh
            || topic.automatic_key.is_empty()
        {
            continue;
        }
        let selected: Vec<_> = docs
            .iter()
            .filter(|doc| topic.source_ids.contains(&doc.id))
            .cloned()
            .collect();
        if selected.is_empty() {
            continue;
        }
        let version = page_version(topic, &selected, manifest, config);
        if topic.last_fingerprint == version || topic.last_attempt_fingerprint == version {
            continue;
        }
        if !topic.error.is_empty() {
            if !topic.last_attempt_fingerprint.is_empty()
                && scopes
                    .matching(topic, &selected, config, &topic.last_attempt_fingerprint)
                    .is_some()
            {
                topic.last_attempt_fingerprint = version;
                changed = true;
            }
            continue;
        }
        let Some(page) = topic.published.as_ref().filter(|page| {
            !topic.last_fingerprint.is_empty()
                && matches!(page.review.as_str(), "approved" | "auto_validated")
                && page.content_hash == store::digest(&page.markdown)
                && sources.valid_page(page)
        }) else {
            continue;
        };
        let Some(policy) = scopes.matching(topic, &selected, config, &topic.last_fingerprint)
        else {
            continue;
        };
        let fingerprint = page_fingerprint(topic, manifest, config, &page.citations);
        if page.fingerprint != fingerprint
            && page.fingerprint
                != page_fingerprint_with_legacy_scope(
                    topic,
                    manifest,
                    config,
                    &page.citations,
                    Some(&policy),
                )
        {
            continue;
        }
        let mut page = page.clone();
        page.fingerprint = fingerprint;
        page.cache_key = version.clone();
        write_json(&root.join(&topic.id).join("published.json"), &page)?;
        topic.published = Some(page);
        topic.last_fingerprint = version.clone();
        topic.last_attempt_fingerprint = version;
        changed = true;
        retained += 1;
    }
    if changed {
        save_topics(root, &values)?;
    }
    Ok(retained)
}
