use crate::CommandResult;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

pub fn digest(value: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(value.as_ref()))
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceRef {
    pub kind: String,
    pub id: String,
    pub revision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub segment_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_ms: Option<u64>,
    #[serde(default)]
    pub quote: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub revision: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub folder_id: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub transcript: String,
    #[serde(default)]
    pub segments: Vec<Value>,
    #[serde(default)]
    pub outline: String,
    #[serde(default)]
    pub conclusions: Vec<Value>,
    #[serde(default)]
    pub todos: Vec<Value>,
    #[serde(default)]
    pub markers: Vec<Value>,
    #[serde(default = "yes")]
    pub ai_context_enabled: bool,
    #[serde(default)]
    pub playback_path: String,
    #[serde(default)]
    pub cloud_file_id: String,
}
fn yes() -> bool {
    true
}

impl Document {
    pub fn has_meeting_text(&self) -> bool {
        !self.transcript.trim().is_empty()
            || !self.outline.trim().is_empty()
            || self.conclusions.iter().any(|item| {
                item.get("conclusionText")
                    .and_then(Value::as_str)
                    .is_some_and(|text| !text.trim().is_empty())
            })
    }
    pub fn text(&self) -> String {
        let mut parts = vec![self.transcript.clone(), self.outline.clone()];
        for item in &self.conclusions {
            if let Some(text) = item.get("conclusionText").and_then(Value::as_str) {
                parts.push(text.into());
            }
        }
        for todo in &self.todos {
            let title = todo
                .get("title")
                .or_else(|| todo.get("todoContent"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            let done = todo
                .get("completed")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || todo.get("isCompleted").and_then(Value::as_u64) == Some(1);
            parts.push(format!("Task: {title} · completed: {done}"));
        }
        parts.join("\n\n")
    }
    pub fn refresh_revision(&mut self) {
        self.revision.clear();
        self.revision = digest(serde_json::to_vec(self).unwrap_or_default());
    }
    pub fn reference(&self) -> SourceRef {
        SourceRef {
            kind: self.kind.clone(),
            id: self.id.clone(),
            revision: self.revision.clone(),
            ..Default::default()
        }
    }
    pub fn markdown(&self) -> String {
        let metadata = json!({"id":self.id,"kind":self.kind,"revision":self.revision,"createdAt":self.created_at,
            "updatedAt":self.updated_at,"folderId":self.folder_id,"tags":self.tags,"cloudFileId":self.cloud_file_id,"sourceRef":self.reference(),"playbackPath":self.playback_path});
        let mut output = format!("---\nlynse: {}\n---\n\n# {}\n\n", metadata, self.title);
        if self.transcript.trim().is_empty() {
            output.push_str("_Awaiting transcription / 待转写_\n\n");
        } else {
            output.push_str("## Transcript / 转写\n\n");
            if self.segments.is_empty() {
                output.push_str(&self.transcript);
                output.push_str("\n\n");
            } else {
                for segment in &self.segments {
                    let text = segment
                        .get("text")
                        .or_else(|| segment.get("recognizedText"))
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let ms = segment.get("startMs").and_then(Value::as_u64);
                    let speaker = segment
                        .get("speakerName")
                        .or_else(|| segment.get("speaker"))
                        .map(|v| {
                            v.as_str()
                                .map(String::from)
                                .unwrap_or_else(|| v.to_string())
                        })
                        .unwrap_or_default();
                    if let Some(ms) = ms {
                        output.push_str(&format!(
                            "[{:02}:{:02}:{:02}] ",
                            ms / 3_600_000,
                            (ms / 60_000) % 60,
                            (ms / 1000) % 60
                        ));
                    }
                    if !speaker.is_empty() {
                        output.push_str(&format!("**{speaker}** "));
                    }
                    output.push_str(text);
                    output.push_str("\n\n");
                }
            }
        }
        if !self.outline.is_empty() {
            output.push_str(&format!("## Outline / 大纲\n\n{}\n\n", self.outline));
        }
        for (index, summary) in self.conclusions.iter().enumerate() {
            let title = summary
                .get("templateName")
                .and_then(Value::as_str)
                .unwrap_or("Summary / 纪要");
            output.push_str(&format!(
                "## {} {}\n\n{}\n\n",
                title,
                index + 1,
                summary
                    .get("conclusionText")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            ));
        }
        if !self.todos.is_empty() {
            output.push_str("## Tasks / 待办\n\n");
            for todo in &self.todos {
                let done = todo
                    .get("completed")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                    || todo.get("isCompleted").and_then(Value::as_u64) == Some(1);
                let title = todo
                    .get("title")
                    .or_else(|| todo.get("todoContent"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                output.push_str(&format!("- [{}] {}\n", if done { "x" } else { " " }, title));
            }
            output.push('\n');
        }
        if !self.markers.is_empty() {
            output.push_str("## Markers / 标记\n\n");
            for marker in &self.markers {
                output.push_str(&format!(
                    "- [{} ms] {}: {}\n",
                    marker["startMs"],
                    marker["kind"].as_str().unwrap_or("highlight"),
                    marker["note"].as_str().unwrap_or_default()
                ));
            }
        }
        output
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub revision: String,
    pub status: String,
    pub markdown_hash: String,
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub excluded: bool,
    #[serde(default)]
    pub synthesis_revision: String,
    #[serde(default)]
    pub remote_revision: String,
    #[serde(default)]
    pub failed_synthesis_revision: String,
    #[serde(default)]
    pub failed_download_revision: String,
    #[serde(default)]
    pub accepted_revision: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiProgress {
    pub stage: String,
    pub completed: usize,
    pub total: usize,
    pub current_title: String,
    pub topic_title: String,
    pub failed: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiAutomation {
    pub folder_ids: Vec<String>,
    #[serde(default)]
    pub include_unfiled: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub enabled: bool,
    pub allow_ai: bool,
    pub initial_complete: bool,
    #[serde(default)]
    pub sync_root: String,
    #[serde(default)]
    pub sync_round: String,
    #[serde(default)]
    pub completed_round: String,
    pub phase: String,
    pub updated_at: String,
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub wiki_progress: Option<WikiProgress>,
    #[serde(default)]
    pub wiki_attempted_fingerprint: String,
    #[serde(default)]
    pub wiki_automation: Option<WikiAutomation>,
    #[serde(default)]
    pub knowledge_policy: Option<Value>,
    #[serde(default)]
    pub knowledge_pending: Option<Value>,
    #[serde(default)]
    pub knowledge_uploads: std::collections::BTreeMap<String,Value>,
    #[serde(default)]
    pub knowledge_events: std::collections::BTreeMap<String,String>,
    #[serde(default)]
    pub entries: BTreeMap<String, Entry>,
    #[serde(default)]
    pub memories: Vec<Value>,
    #[serde(default)]
    pub artifacts: BTreeMap<String, Value>,
    #[serde(default)]
    pub excluded_sources: Vec<String>,
    #[serde(default)]
    pub aliases: BTreeMap<String, String>,
}
impl Default for Manifest {
    fn default() -> Self {
        Self {
            enabled: false,
            allow_ai: false,
            initial_complete: false,
            sync_root: String::new(),
            sync_round: String::new(),
            completed_round: String::new(),
            phase: "disabled".into(),
            updated_at: String::new(),
            error: String::new(),
            wiki_progress: None,
            wiki_attempted_fingerprint: String::new(),
            wiki_automation: None,
            knowledge_policy: None,
            knowledge_pending: None,
            knowledge_uploads: Default::default(),
            knowledge_events: Default::default(),
            entries: BTreeMap::new(),
            memories: vec![],
            artifacts: BTreeMap::new(),
            excluded_sources: vec![],
            aliases: BTreeMap::new(),
        }
    }
}

impl Manifest {
    pub(super) fn bootstrap_valid(&self, root: &str) -> bool {
        self.initial_complete
            && !self.sync_round.is_empty()
            && self.sync_round == self.completed_round
            && self.sync_root == root
    }
}

pub fn load(path: &Path) -> CommandResult<Manifest> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| "Workbench state is unreadable; original file was preserved".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Manifest::default()),
        Err(e) => Err(e.to_string()),
    }
}
pub fn save(path: &Path, state: &Manifest) -> CommandResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    crate::atomic_write(
        path,
        &serde_json::to_vec_pretty(state).map_err(|e| e.to_string())?,
    )
}
pub fn paths(root: &Path, id: &str) -> (PathBuf, PathBuf) {
    let name = digest(id);
    (
        root.join(format!("{name}.md")),
        root.join(format!("{name}.source.json")),
    )
}

pub fn write_document(
    root: &Path,
    document: &Document,
    previous: Option<&Entry>,
) -> CommandResult<Entry> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let (markdown_path, source_path) = paths(root, &document.id);
    let markdown = document.markdown();
    let old = fs::read(&markdown_path).ok();
    let new_hash = digest(markdown.as_bytes());
    if let Some(entry) = previous.filter(|entry| {
        entry.accepted_revision == document.revision && read_document(root, entry).is_ok()
    }) {
        return Ok(entry.clone());
    }
    let conflict = previous.is_some_and(|entry| {
        if !entry.accepted_revision.is_empty() && entry.accepted_revision != document.revision {
            return true;
        }

        old.as_ref().is_some_and(|bytes| {
            !entry.markdown_hash.is_empty()
                && digest(bytes) != entry.markdown_hash
                && digest(bytes) != new_hash
        })
    });
    let mut entry = Entry {
        id: document.id.clone(),
        kind: document.kind.clone(),
        title: document.title.clone(),
        revision: document.revision.clone(),
        status: if document.kind == "meeting" && !document.has_meeting_text() {
            "awaiting_transcription"
        } else {
            "synced"
        }
        .into(),
        markdown_hash: digest(markdown.as_bytes()),
        excluded: previous.is_some_and(|e| e.excluded),
        synthesis_revision: previous
            .map(|e| e.synthesis_revision.clone())
            .unwrap_or_default(),
        ..Default::default()
    };
    if let Some(old) = previous {
        entry.remote_revision = old.remote_revision.clone();
        if old.revision == document.revision {
            entry.failed_synthesis_revision = old.failed_synthesis_revision.clone();
        }
    }
    if conflict {
        crate::atomic_write(
            &markdown_path.with_extension("incoming.md"),
            markdown.as_bytes(),
        )?;
        crate::atomic_write(
            &source_path.with_extension("incoming.json"),
            &serde_json::to_vec_pretty(document).map_err(|e| e.to_string())?,
        )?;
        entry.status = "conflict".into();
        entry.markdown_hash = previous
            .map(|e| e.markdown_hash.clone())
            .unwrap_or_default();
    } else {
        // The structured source and readable document are one knowledge-base record.
        crate::atomic_write(
            &source_path,
            &serde_json::to_vec_pretty(document).map_err(|e| e.to_string())?,
        )?;
        crate::atomic_write(&markdown_path, markdown.as_bytes())?;
    }
    Ok(entry)
}
pub fn read_document(root: &Path, entry: &Entry) -> CommandResult<Document> {
    let (md, source) = paths(root, &entry.id);
    if digest(fs::read(md).map_err(|e| e.to_string())?) != entry.markdown_hash {
        return Err(
            "Local document was edited; resolve its sync conflict before AI processing".into(),
        );
    }
    let document: Document = serde_json::from_slice(&fs::read(source).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let mut check = document.clone();
    check.refresh_revision();
    if document.id != entry.id
        || document.revision != entry.revision
        || check.revision != entry.revision
    {
        return Err("Structured source changed; resync or resolve its conflict".into());
    }
    Ok(document)
}
pub fn eligible(entry: &Entry) -> bool {
    !entry.excluded && entry.status == "synced"
}

pub fn write_memory_views(root: &Path, state: &Manifest) -> CommandResult<()> {
    let daily = root.join("daily");
    fs::create_dir_all(&daily).map_err(|e| e.to_string())?;
    let current: Vec<Value> = state
        .memories
        .iter()
        .filter(|item| item["excluded"] != true && item["stale"] != true)
        .cloned()
        .collect();
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let render = |date: &str, items: &[Value]| -> String {
        let mut text = format!("# Lynse Memory · {date}\n\n");
        for item in items {
            text.push_str(&format!(
                "- **{}** {}\n  Source: `{}`\n",
                item["kind"].as_str().unwrap_or("observation"),
                item["text"].as_str().unwrap_or_default(),
                item["sourceId"].as_str().unwrap_or_default()
            ));
        }
        for item in items {
            if let Some(refs) = item["citations"].as_array() {
                for reference in refs {
                    let id = reference["id"].as_str().unwrap_or_default();
                    let document = root
                        .parent()
                        .and_then(|parent| parent.parent())
                        .unwrap_or(root)
                        .join("Meetings")
                        .join(root.file_name().unwrap_or_default())
                        .join(format!("{}.md", digest(id)));
                    text.push_str(&format!(
                        "\n  [Source {}](<{}>) · revision `{}`\n  > {}\n",
                        id,
                        document.display(),
                        reference["revision"].as_str().unwrap_or_default(),
                        reference["quote"].as_str().unwrap_or_default()
                    ));
                }
            }
        }
        text
    };
    for entry in fs::read_dir(&daily).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let mut old: Vec<Value> =
            serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
                .map_err(|_| "Memory snapshot is unreadable; original preserved")?;
        old.retain(|item| current.iter().any(|active| active["id"] == item["id"]));
        for item in &mut old {
            if let Some(active) = current.iter().find(|active| active["id"] == item["id"]) {
                *item = active.clone();
            }
        }
        crate::atomic_write(
            &path,
            &serde_json::to_vec_pretty(&old).map_err(|e| e.to_string())?,
        )?;
        crate::atomic_write(
            &path.with_extension("md"),
            render(
                path.file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or_default(),
                &old,
            )
            .as_bytes(),
        )?;
    }
    if state.initial_complete {
        crate::atomic_write(
            &daily.join(format!("{today}.json")),
            &serde_json::to_vec_pretty(&current).map_err(|e| e.to_string())?,
        )?;
        crate::atomic_write(
            &daily.join(format!("{today}.md")),
            render(&today, &current).as_bytes(),
        )?;
    }
    crate::atomic_write(&root.join("MEMORY.md"), render(&today, &current).as_bytes())
}

pub fn search(root: &Path, state: &Manifest, query: &str, limit: usize) -> Vec<Value> {
    search_impl(root, state, query, limit, true)
}
pub fn browse(root: &Path, state: &Manifest, query: &str, limit: usize) -> Vec<Value> {
    search_impl(root, state, query, limit, false)
}
pub(super) fn query_terms(query: &str) -> Vec<String> {
    let mut terms = Vec::new();
    for part in query.split(|ch: char| ch.is_whitespace() || ch.is_ascii_punctuation()) {
        if part.is_empty() {
            continue;
        }
        if part
            .chars()
            .any(|ch| ('\u{3400}'..='\u{9fff}').contains(&ch))
        {
            let chars: Vec<char> = part.chars().collect();
            if chars.len() <= 2 {
                terms.push(part.to_lowercase());
            } else {
                for pair in chars.windows(2) {
                    let term: String = pair.iter().collect();
                    if !matches!(
                        term.as_str(),
                        "我们" | "什么" | "怎么" | "一下" | "请问" | "上次" | "这次"
                    ) {
                        terms.push(term.to_lowercase());
                    }
                }
            }
        } else {
            terms.push(part.to_lowercase());
        }
    }
    terms
}
#[derive(Default, Deserialize, Serialize)]
struct IndexRecord {
    revision: String,
    terms: Vec<String>,
}
type SearchIndex = BTreeMap<String, IndexRecord>;
fn index_terms(text: &str) -> Vec<String> {
    let mut terms = std::collections::BTreeSet::new();
    for word in text.split(|ch: char| !ch.is_alphanumeric()) {
        if word.is_empty() {
            continue;
        }
        let chars: Vec<char> = word.chars().collect();
        if chars
            .iter()
            .any(|ch| ('\u{3400}'..='\u{9fff}').contains(ch))
        {
            for pair in chars.windows(2) {
                terms.insert(pair.iter().collect::<String>().to_lowercase());
            }
            if chars.len() == 1 {
                terms.insert(word.to_lowercase());
            }
        } else {
            terms.insert(word.to_lowercase());
        }
    }
    terms.into_iter().collect()
}
fn build_index(root: &Path, state: &Manifest, mut index: SearchIndex) -> SearchIndex {
    index.retain(|id, _| state.entries.contains_key(id));
    for entry in state
        .entries
        .values()
        .filter(|entry| matches!(entry.status.as_str(), "synced" | "awaiting_transcription"))
    {
        if index
            .get(&entry.id)
            .is_some_and(|item| item.revision == entry.revision)
        {
            continue;
        }
        if let Ok(document) = read_document(root, entry) {
            index.insert(
                entry.id.clone(),
                IndexRecord {
                    revision: entry.revision.clone(),
                    terms: index_terms(&format!(
                        "{} {} {} {}",
                        document.title,
                        document.folder_id,
                        document.tags.join(" "),
                        document.text()
                    )),
                },
            );
        }
    }
    index
}
fn load_index(root: &Path) -> SearchIndex {
    // This cache contains terms and source versions only; source text stays in the vault record.
    fs::read(root.join(".search-index.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}
pub fn rebuild_index(root: &Path, state: &Manifest) -> CommandResult<()> {
    let index = build_index(root, state, load_index(root));
    crate::atomic_write(
        &root.join(".search-index.json"),
        &serde_json::to_vec(&index).map_err(|e| e.to_string())?,
    )
}
pub fn evidence_excerpt(body: &str, query: &str, limit: usize) -> String {
    let lower = body.to_lowercase();
    let byte = query_terms(query)
        .iter()
        .filter_map(|term| lower.find(term))
        .min()
        .unwrap_or(0);
    let start = lower
        .get(..byte)
        .unwrap_or_default()
        .chars()
        .count()
        .saturating_sub(200);
    body.chars().skip(start).take(limit).collect()
}
fn search_impl(
    root: &Path,
    state: &Manifest,
    query: &str,
    limit: usize,
    ai_only: bool,
) -> Vec<Value> {
    let terms = query_terms(query);
    let index = build_index(root, state, load_index(root));
    let mut candidates: Vec<(usize, &Entry)> = state
        .entries
        .values()
        .filter(|entry| {
            if ai_only {
                eligible(entry)
            } else {
                matches!(entry.status.as_str(), "synced" | "awaiting_transcription")
            }
        })
        .filter_map(|entry| {
            let item = index.get(&entry.id)?;
            let score = terms
                .iter()
                .filter(|term| item.terms.iter().any(|token| token.contains(term.as_str())))
                .count();
            if !terms.is_empty() && score == 0 {
                return None;
            }
            Some((score, entry))
        })
        .collect();
    candidates.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.id.cmp(&a.1.id)));
    candidates.into_iter().filter_map(|(_,entry)|{
        let document=read_document(root,entry).ok()?;
        if ai_only && !document.ai_context_enabled{return None;}
        Some(json!({"id":document.id,"title":document.title,"kind":document.kind,"updatedAt":document.updated_at,"excerpt":evidence_excerpt(&document.text(),query,1800),"source":document.reference()}))
    }).take(limit.min(100)).collect()
}

pub fn memory_document(root: &Path, state: &Manifest, item: &Value) -> Option<Document> {
    if item["excluded"] == true || item["stale"] == true {
        return None;
    }
    let citations = item["citations"]
        .as_array()
        .filter(|refs| !refs.is_empty())?;
    for reference in citations {
        let entry = state.entries.get(reference["id"].as_str()?)?;
        if !eligible(entry) || reference["revision"] != entry.revision {
            return None;
        }
        let document = read_document(root, entry).ok()?;
        if !document.ai_context_enabled || !document.text().contains(reference["quote"].as_str()?) {
            return None;
        }
    }
    let mut document = Document {
        id: format!("memory:{}", item["id"].as_str()?),
        kind: "memory".into(),
        title: item["sourceTitle"].as_str().unwrap_or("Memory").into(),
        transcript: format!(
            "{} ({})\n{}\nEvidence: {}",
            if item["userEdited"] == true {
                "User correction"
            } else {
                "Derived memory"
            },
            item["kind"].as_str().unwrap_or("unresolved"),
            item["text"].as_str()?,
            serde_json::to_string(citations).ok()?
        ),
        ai_context_enabled: true,
        ..Default::default()
    };
    document.refresh_revision();
    Some(document)
}
pub fn matching_memories(
    root: &Path,
    state: &Manifest,
    query: &str,
    limit: usize,
) -> Vec<Document> {
    let terms = query_terms(query);
    let mut items: Vec<_> = state
        .memories
        .iter()
        .filter(|item| {
            terms.is_empty()
                || terms.iter().any(|term| {
                    item["text"]
                        .as_str()
                        .unwrap_or_default()
                        .to_lowercase()
                        .contains(term)
                })
        })
        .collect();
    items.sort_by_key(|item| std::cmp::Reverse(item["pinned"] == true));
    items
        .into_iter()
        .filter_map(|item| memory_document(root, state, item))
        .take(limit)
        .collect()
}

pub fn is_current_document(root: &Path, state: &Manifest, document: &Document) -> bool {
    if document.kind == "memory" {
        state
            .memories
            .iter()
            .filter_map(|item| memory_document(root, state, item))
            .any(|current| current.id == document.id && current.revision == document.revision)
    } else {
        state
            .entries
            .get(&document.id)
            .filter(|entry| eligible(entry) && entry.revision == document.revision)
            .and_then(|entry| read_document(root, entry).ok())
            .is_some_and(|current| {
                current.ai_context_enabled && current.revision == document.revision
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("lynse-workbench-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }
    #[test]
    fn index_rebuild_and_offline_search_survive_restart_and_local_edits() {
        let root = root();
        let mut state = Manifest::default();
        let mut document = Document {
            id: "old-meeting".into(),
            title: "1995 review".into(),
            transcript: "讨论火星项目的预算".into(),
            ai_context_enabled: true,
            ..Default::default()
        };
        document.refresh_revision();
        let entry = write_document(&root, &document, None).unwrap();
        state.entries.insert(document.id.clone(), entry);
        state.enabled = true;
        state.initial_complete = true;
        save(&root.join("state.json"), &state).unwrap();
        rebuild_index(&root, &state).unwrap();
        let recovered = load(&root.join("state.json")).unwrap();
        assert_eq!(search(&root, &recovered, "火星预算", 10).len(), 1);
        fs::write(paths(&root, &document.id).0, "hand edited secret").unwrap();
        assert!(search(&root, &recovered, "火星", 10).is_empty());
        assert!(fs::read_to_string(root.join(".search-index.json"))
            .unwrap()
            .contains("old-meeting"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn withdrawn_sources_are_removed_from_historical_snapshots() {
        let root = root();
        let mut state = Manifest {
            initial_complete: true,
            ..Default::default()
        };
        state.memories =
            vec![json!({"id":"secret","text":"PRIVATE_BODY","sourceId":"one","kind":"decision"})];
        write_memory_views(&root, &state).unwrap();
        let daily = root.join("daily");
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        fs::rename(
            daily.join(format!("{today}.json")),
            daily.join("2000-01-01.json"),
        )
        .unwrap();
        state.memories.clear();
        write_memory_views(&root, &state).unwrap();
        for file in fs::read_dir(daily).unwrap() {
            assert!(!fs::read_to_string(file.unwrap().path())
                .unwrap()
                .contains("PRIVATE_BODY"));
        }
        assert!(!fs::read_to_string(root.join("MEMORY.md"))
            .unwrap()
            .contains("PRIVATE_BODY"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn accepted_local_edits_are_not_overwritten_on_the_next_sync() {
        let root = root();
        let mut remote = Document {
            id: "one".into(),
            title: "Cloud".into(),
            transcript: "Remote text".into(),
            ..Default::default()
        };
        remote.refresh_revision();
        let first = write_document(&root, &remote, None).unwrap();
        let mut local = remote.clone();
        local.transcript = "User-authored text".into();
        local.refresh_revision();
        let mut accepted = write_document(&root, &local, None).unwrap();
        accepted.accepted_revision = remote.revision.clone();
        let same = write_document(&root, &remote, Some(&accepted)).unwrap();
        assert_eq!(same.revision, local.revision);
        remote.title = "New cloud title".into();
        remote.refresh_revision();
        assert_eq!(
            write_document(&root, &remote, Some(&accepted))
                .unwrap()
                .status,
            "conflict"
        );
        assert!(fs::read_to_string(paths(&root, "one").0)
            .unwrap()
            .contains("User-authored text"));
        assert_ne!(first.revision, local.revision);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn corrected_memory_requires_active_evidence_and_revision() {
        let root = root();
        let mut state = Manifest::default();
        let mut document = Document {
            id: "one".into(),
            transcript: "Friday was only proposed".into(),
            ai_context_enabled: true,
            ..Default::default()
        };
        document.refresh_revision();
        state.entries.insert(
            document.id.clone(),
            write_document(&root, &document, None).unwrap(),
        );
        let memory = json!({"id":"m1","text":"The deadline remains undecided","kind":"unresolved","userEdited":true,"citations":[{"id":"one","revision":document.revision,"quote":"Friday was only proposed"}]});
        assert!(memory_document(&root, &state, &memory)
            .unwrap()
            .transcript
            .contains("User correction"));
        state.entries.get_mut("one").unwrap().excluded = true;
        assert!(memory_document(&root, &state, &memory).is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sync_preserves_edits_and_retries_conflicts() {
        let root = root();
        let mut doc = Document {
            id: "meeting-1".into(),
            title: "First".into(),
            transcript: "Actual transcript".into(),
            kind: "meeting".into(),
            ai_context_enabled: true,
            ..Default::default()
        };
        doc.refresh_revision();
        let first = write_document(&root, &doc, None).unwrap();
        let (path, _) = paths(&root, &doc.id);
        fs::write(&path, "My edits").unwrap();
        doc.title = "Renamed".into();
        doc.refresh_revision();
        let next = write_document(&root, &doc, Some(&first)).unwrap();
        assert_eq!(next.status, "conflict");
        assert_eq!(fs::read_to_string(path).unwrap(), "My edits");
        assert!(read_document(&root, &next).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn search_never_returns_excluded_or_unshared_sources() {
        let root = root();
        let mut state = Manifest::default();
        for (id, shared) in [("allowed", true), ("private", false)] {
            let mut doc = Document {
                id: id.into(),
                kind: "meeting".into(),
                title: "Project Alpha".into(),
                transcript: "Decision text".into(),
                ai_context_enabled: shared,
                ..Default::default()
            };
            doc.refresh_revision();
            state
                .entries
                .insert(id.into(), write_document(&root, &doc, None).unwrap());
        }
        assert_eq!(search(&root, &state, "Alpha", 20).len(), 1);
        state.entries.get_mut("allowed").unwrap().excluded = true;
        assert!(search(&root, &state, "Alpha", 20).is_empty());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn every_summary_and_timeline_is_kept() {
        let doc = Document {
            title: "Meeting".into(),
            transcript: "Hello".into(),
            segments: vec![json!({"startMs":3_601_000,"text":"Hello","speakerName":"Sam"})],
            conclusions: vec![
                json!({"conclusionText":"One"}),
                json!({"conclusionText":"Two"}),
            ],
            ..Default::default()
        };
        let markdown = doc.markdown();
        assert!(markdown.contains("01:00:01"));
        assert!(markdown.contains("Sam"));
        assert!(markdown.contains("One"));
        assert!(markdown.contains("Two"));
    }
}
