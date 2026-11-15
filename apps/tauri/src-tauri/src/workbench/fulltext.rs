// Chunk-level full-text search over local meeting documents.
//
// The retrieval layer is a simplified port of Zleap-AI/SAG-Wiki (MIT license):
// segment-boundary chunks (~512 chars, 80 chars of whole-segment overlap),
// jieba tokenization, and an FTS5 contentless index ranked with bm25().
// Chunks carry their segment span so every hit maps back to a SourceRef
// timestamp without re-parsing the transcript.
//
// The database lives next to the legacy `.search-index.json` cache in
// `Meetings/<scope>/` so the whole index shares the vault lifecycle.

use super::store::Document;
use crate::CommandResult;
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    fs,
    path::Path,
    sync::OnceLock,
};

const CHUNK_CHARS: usize = 512;
const OVERLAP_CHARS: usize = 80;
const MAX_QUERY_TOKENS: usize = 64;
const MAX_HITS: usize = 200;

fn jieba() -> &'static jieba_rs::Jieba {
    static JIEBA: OnceLock<jieba_rs::Jieba> = OnceLock::new();
    JIEBA.get_or_init(jieba_rs::Jieba::new)
}

fn tokenize(text: &str) -> Vec<String> {
    jieba()
        .cut_for_search(text, true)
        .into_iter()
        .filter(|token| token.word.chars().any(|ch| ch.is_alphanumeric()))
        .map(|token| token.word.to_lowercase())
        .collect()
}

/// Build an FTS5 MATCH expression. Terms are OR-joined so partial queries
/// still recall; bm25 ranking pushes chunks that co-occur more terms to the
/// top. Single CJK characters use prefix matching because jieba rarely emits
/// one-character words for content terms.
fn match_expression(query: &str) -> Option<String> {
    let mut tokens = tokenize(query);
    tokens.truncate(MAX_QUERY_TOKENS);
    if tokens.is_empty() {
        return None;
    }
    let clauses = tokens
        .into_iter()
        .map(|token| {
            let escaped = token.replace('"', "\"\"");
            if token.chars().count() == 1 && !token.is_ascii() {
                format!("\"{escaped}\"*")
            } else {
                format!("\"{escaped}\"")
            }
        })
        .collect::<Vec<_>>()
        .join(" OR ");
    Some(clauses)
}

#[derive(Clone, Debug)]
pub(super) struct ChunkHit {
    pub chunk_id: i64,
    pub doc_id: String,
    pub revision: String,
    pub heading: String,
    pub quote: String,
    pub segment_id: Option<String>,
    pub start_ms: Option<u64>,
    pub end_ms: Option<u64>,
    pub score: f64,
}

impl ChunkHit {
    pub(super) fn evidence(&self) -> serde_json::Value {
        serde_json::json!({
            "chunkId": self.chunk_id,
            "quote": self.quote,
            "heading": self.heading,
            "segmentId": self.segment_id,
            "startMs": self.start_ms,
            "endMs": self.end_ms,
        })
    }
}

fn db(root: &Path) -> CommandResult<Connection> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let path = root.join("fulltext.sqlite");
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;
    let schema = "PRAGMA journal_mode=DELETE;
        CREATE TABLE IF NOT EXISTS documents (doc_id TEXT PRIMARY KEY, revision TEXT NOT NULL, markdown_hash TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS chunks (chunk_id INTEGER PRIMARY KEY, doc_id TEXT NOT NULL, idx INTEGER NOT NULL, heading TEXT NOT NULL DEFAULT '', seg_from TEXT NOT NULL DEFAULT '', seg_to TEXT NOT NULL DEFAULT '', start_ms INTEGER, end_ms INTEGER, body TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(doc_id);
        CREATE TABLE IF NOT EXISTS chunk_sequence (id INTEGER PRIMARY KEY CHECK(id = 1), last_id INTEGER NOT NULL);
        CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(heading, body, content='', contentless_delete=1);";
    if let Err(error) = conn.execute_batch(schema) {
        if matches!(&error, rusqlite::Error::SqliteFailure(e, _) if matches!(e.code, rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase)) {
            drop(conn);
            fs::rename(
                &path,
                root.join(format!("fulltext.corrupt-{}.sqlite", uuid::Uuid::new_v4())),
            )
            .map_err(|e| e.to_string())?;
            return db(root);
        }
        return Err(error.to_string());
    }
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    Ok(conn)
}

struct Segment {
    id: String,
    start_ms: Option<u64>,
    end_ms: Option<u64>,
    text: String,
}

#[derive(Eq, Ord, PartialEq, PartialOrd)]
struct Chunk {
    heading: String,
    seg_from: String,
    seg_to: String,
    start_ms: Option<u64>,
    end_ms: Option<u64>,
    body: String,
}

fn parse_segments(document: &Document) -> Vec<Segment> {
    document
        .segments
        .iter()
        .enumerate()
        .filter_map(|(index, segment)| {
            let text = segment
                .get("text")
                .or_else(|| segment.get("recognizedText"))
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if text.trim().is_empty() {
                return None;
            }
            let id = segment
                .get("id")
                .and_then(|v| v.as_str())
                .map(String::from)
                .unwrap_or_else(|| format!("seg:{index}"));
            Some(Segment {
                id,
                start_ms: segment.get("startMs").and_then(|v| v.as_u64()),
                end_ms: segment.get("endMs").and_then(|v| v.as_u64()),
                text: text.to_string(),
            })
        })
        .collect()
}

fn build_chunk(heading: &str, spans: &[(usize, usize)], segments: &[Segment]) -> Chunk {
    let body = spans
        .iter()
        .map(|&(from, to)| {
            segments[from..to]
                .iter()
                .map(|seg| seg.text.as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .collect::<Vec<_>>()
        .join("\n");
    let first = spans.first().map(|&(from, _)| from);
    let last = spans.last().map(|&(_, to)| to.saturating_sub(1));
    let (seg_from, start_ms) = first
        .and_then(|i| segments.get(i))
        .map(|seg| (seg.id.clone(), seg.start_ms))
        .unwrap_or_default();
    let (seg_to, end_ms) = last
        .and_then(|i| segments.get(i))
        .map(|seg| (seg.id.clone(), seg.end_ms))
        .unwrap_or_default();
    Chunk {
        heading: heading.to_string(),
        seg_from,
        seg_to,
        start_ms,
        end_ms,
        body,
    }
}

/// Accumulate whole segments into ~512-char chunks; a closed chunk carries
/// its trailing whole segments (up to 80 chars) into the next one as overlap.
/// Segments are never split, so a lone oversized segment becomes one chunk.
fn chunk_segments(segments: &[Segment]) -> Vec<Chunk> {
    let mut out: Vec<Chunk> = Vec::new();
    // Spans of consecutive segment indices; a span never crosses a segment.
    let mut cur: Vec<(usize, usize)> = Vec::new();
    let mut cur_chars = 0usize;
    for (index, segment) in segments.iter().enumerate() {
        let len = segment.text.chars().count();
        if cur_chars > 0 && cur_chars + len > CHUNK_CHARS {
            out.push(build_chunk("Transcript / 转写", &cur, segments));
            // Overlap: whole trailing segments within the overlap budget.
            let mut carry: Vec<(usize, usize)> = Vec::new();
            let mut carry_chars = 0usize;
            for span in cur.iter().rev() {
                let chars: usize = segments[span.0..span.1]
                    .iter()
                    .map(|seg| seg.text.chars().count())
                    .sum();
                if carry_chars + chars > OVERLAP_CHARS {
                    break;
                }
                carry.insert(0, *span);
                carry_chars += chars;
            }
            cur = carry;
            cur_chars = carry_chars;
        }
        cur.push((index, index + 1));
        cur_chars += len;
    }
    if !cur.is_empty() {
        out.push(build_chunk("Transcript / 转写", &cur, segments));
    }
    out
}

/// Fallback for documents that carry a transcript without segment records.
/// Splits on a fixed char window; the 80-char overlap keeps words that
/// straddle a boundary intact inside at least one chunk.
fn chunk_plain_text(text: &str) -> Vec<Chunk> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut start = 0usize;
    while start < chars.len() {
        let end = (start + CHUNK_CHARS).min(chars.len());
        out.push(Chunk {
            heading: "Transcript / 转写".into(),
            seg_from: String::new(),
            seg_to: String::new(),
            start_ms: None,
            end_ms: None,
            body: chars[start..end].iter().collect(),
        });
        if end >= chars.len() {
            break;
        }
        start = end.saturating_sub(OVERLAP_CHARS).max(start + 1);
    }
    out
}

fn meta_chunks(document: &Document) -> Vec<Chunk> {
    let mut out = Vec::new();
    let heading_line = if document.tags.is_empty() {
        document.title.clone()
    } else {
        format!("{} {}", document.title, document.tags.join(" "))
    };
    if !heading_line.trim().is_empty() {
        out.push(Chunk {
            heading: "Title".into(),
            seg_from: String::new(),
            seg_to: String::new(),
            start_ms: None,
            end_ms: None,
            body: heading_line,
        });
    }
    if !document.outline.trim().is_empty() {
        out.push(Chunk {
            heading: "Outline / 大纲".into(),
            seg_from: String::new(),
            seg_to: String::new(),
            start_ms: None,
            end_ms: None,
            body: document.outline.clone(),
        });
    }
    for (index, summary) in document.conclusions.iter().enumerate() {
        let text = summary
            .get("conclusionText")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        if text.trim().is_empty() {
            continue;
        }
        let name = summary
            .get("templateName")
            .and_then(|v| v.as_str())
            .unwrap_or("Summary / 纪要");
        out.push(Chunk {
            heading: format!("{name} {}", index + 1),
            seg_from: String::new(),
            seg_to: String::new(),
            start_ms: None,
            end_ms: None,
            body: text.to_string(),
        });
    }
    if !document.todos.is_empty() {
        let body = document
            .todos
            .iter()
            .filter_map(|todo| {
                todo.get("title")
                    .or_else(|| todo.get("todoContent"))
                    .and_then(|v| v.as_str())
                    .map(String::from)
            })
            .collect::<Vec<_>>()
            .join("\n");
        if !body.trim().is_empty() {
            out.push(Chunk {
                heading: "Tasks / 待办".into(),
                seg_from: String::new(),
                seg_to: String::new(),
                start_ms: None,
                end_ms: None,
                body,
            });
        }
    }
    out
}

fn build_chunks(document: &Document) -> Vec<Chunk> {
    let mut chunks = meta_chunks(document);
    let segments = parse_segments(document);
    if !segments.is_empty() {
        chunks.extend(chunk_segments(&segments));
    } else if !document.transcript.trim().is_empty() {
        chunks.extend(chunk_plain_text(&document.transcript));
    }
    chunks
}

/// Reconcile one committed document, keeping the locators of identical chunks.
pub(super) fn index_document(root: &Path, document: &Document, markdown_hash: &str) -> CommandResult<()> {
    let chunks = build_chunks(document);
    let mut conn = db(root)?;
    let conn = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let mut existing = std::collections::BTreeMap::<_, std::collections::VecDeque<_>>::new();
    {
        let mut statement = conn
            .prepare(
                "SELECT chunk_id, idx, heading, seg_from, seg_to, start_ms, end_ms, body
             FROM chunks WHERE doc_id=?1 ORDER BY idx",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([&document.id], |row| {
                Ok((
                    (row.get::<_, i64>(0)?, row.get::<_, i64>(1)?),
                    Chunk {
                        heading: row.get(2)?,
                        seg_from: row.get(3)?,
                        seg_to: row.get(4)?,
                        start_ms: row
                            .get::<_, Option<i64>>(5)?
                            .and_then(|value| u64::try_from(value).ok()),
                        end_ms: row
                            .get::<_, Option<i64>>(6)?
                            .and_then(|value| u64::try_from(value).ok()),
                        body: row.get(7)?,
                    },
                ))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (locator, chunk) = row.map_err(|error| error.to_string())?;
            existing.entry(chunk).or_default().push_back(locator);
        }
    }
    conn.execute(
        "INSERT OR IGNORE INTO chunk_sequence SELECT 1, COALESCE(MAX(chunk_id), 0) FROM chunks",
        [],
    )
    .map_err(|error| error.to_string())?;
    conn.execute("UPDATE chunk_sequence SET last_id=MAX(last_id, (SELECT COALESCE(MAX(chunk_id), 0) FROM chunks))", [])
        .map_err(|error| error.to_string())?;
    for (index, chunk) in (0_i64..).zip(&chunks) {
        if let Some((id, previous)) = existing.get_mut(chunk).and_then(|rows| rows.pop_front()) {
            if previous != index {
                conn.execute(
                    "UPDATE chunks SET idx=?1 WHERE chunk_id=?2",
                    params![index, id],
                )
                .map_err(|error| error.to_string())?;
            }
            continue;
        }
        let chunk_id: i64 = conn
            .query_row(
                "UPDATE chunk_sequence SET last_id=last_id+1 WHERE id=1 RETURNING last_id",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        conn.execute(
            "INSERT INTO chunks (doc_id, idx, heading, seg_from, seg_to, start_ms, end_ms, body, chunk_id) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![
                document.id,
                index,
                chunk.heading,
                chunk.seg_from,
                chunk.seg_to,
                chunk.start_ms.map(|ms| ms as i64),
                chunk.end_ms.map(|ms| ms as i64),
                chunk.body,
                chunk_id,
            ],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO chunk_fts (rowid, heading, body) VALUES (?1, ?2, ?3)",
            params![
                chunk_id,
                tokenize(&chunk.heading).join(" "),
                tokenize(&chunk.body).join(" "),
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    for (id, _) in existing.into_values().flatten() {
        conn.execute("DELETE FROM chunk_fts WHERE rowid=?1", [id])
            .map_err(|error| error.to_string())?;
        conn.execute("DELETE FROM chunks WHERE chunk_id=?1", [id])
            .map_err(|error| error.to_string())?;
    }
    conn.execute(
        "INSERT OR REPLACE INTO documents VALUES (?1,?2,?3,?4)",
        params![
            document.id,
            document.revision,
            markdown_hash,
            document.updated_at
        ],
    )
    .map_err(|error| error.to_string())?;
    conn.commit().map_err(|error| error.to_string())
}

pub(super) fn remove_document(root: &Path, doc_id: &str) {
    let Ok(conn) = db(root) else { return };
    let Ok(conn) = conn.unchecked_transaction() else {
        return;
    };
    let ids: Vec<i64> = conn
        .prepare("SELECT chunk_id FROM chunks WHERE doc_id=?1")
        .and_then(|mut stmt| {
            stmt.query_map(params![doc_id], |row| row.get(0))?
                .collect::<Result<Vec<_>, _>>()
        })
        .unwrap_or_default();
    for id in ids {
        if conn
            .execute("DELETE FROM chunk_fts WHERE rowid=?1", [id])
            .is_err()
        {
            return;
        }
    }
    if conn
        .execute("DELETE FROM chunks WHERE doc_id=?1", [doc_id])
        .is_ok()
        && conn
            .execute("DELETE FROM documents WHERE doc_id=?1", [doc_id])
            .is_ok()
    {
        let _ = conn.commit();
    }
}

pub(super) fn chunk(root: &Path, chunk_id: i64) -> CommandResult<Option<ChunkHit>> {
    let conn = db(root)?;
    let mut stmt = conn
        .prepare(
            "SELECT c.chunk_id, c.doc_id, c.heading, c.body, c.seg_from, c.start_ms, c.end_ms, d.revision
             FROM chunks c JOIN documents d USING (doc_id) WHERE c.chunk_id=?1",
        )
        .map_err(|e| e.to_string())?;
    let hit = stmt
        .query_row(params![chunk_id], |row| {
            Ok(ChunkHit {
                chunk_id: row.get(0)?,
                doc_id: row.get(1)?,
                revision: row.get(7)?,
                heading: row.get(2)?,
                quote: row.get(3)?,
                segment_id: row.get::<_, Option<String>>(4)?,
                start_ms: row.get::<_, Option<i64>>(5)?.map(|ms| ms.max(0) as u64),
                end_ms: row.get::<_, Option<i64>>(6)?.map(|ms| ms.max(0) as u64),
                score: 0.0,
            })
        })
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(hit)
}

pub(super) fn passages(root: &Path) -> CommandResult<Vec<ChunkHit>> {
    let conn = db(root)?;
    let mut statement = conn
        .prepare(
            "SELECT c.chunk_id, c.doc_id, d.revision, c.heading, c.body
         FROM chunks c JOIN documents d USING (doc_id) ORDER BY c.doc_id, c.idx",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(ChunkHit {
                chunk_id: row.get(0)?,
                doc_id: row.get(1)?,
                revision: row.get(2)?,
                heading: row.get(3)?,
                quote: row.get(4)?,
                segment_id: None,
                start_ms: None,
                end_ms: None,
                score: 0.0,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<_, _>>()
        .map_err(|error| error.to_string())
}

/// BM25-ranked chunk hits. Smaller bm25 scores match better.
pub(super) fn search(root: &Path, query: &str, limit: usize) -> CommandResult<Vec<ChunkHit>> {
    let Some(expression) = match_expression(query) else {
        return Ok(vec![]);
    };
    let conn = db(root)?;
    let mut stmt = conn
        .prepare(
            "SELECT c.chunk_id, c.doc_id, c.heading, c.body, c.seg_from, c.start_ms, c.end_ms, bm25(chunk_fts, 2.0, 1.0) AS score, d.revision
             FROM chunk_fts
             JOIN chunks c ON c.chunk_id = chunk_fts.rowid
             JOIN documents d ON d.doc_id = c.doc_id
             WHERE chunk_fts MATCH ?1
             ORDER BY score ASC
             LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![expression, limit.min(MAX_HITS) as i64], |row| {
            let seg_from: String = row.get(4)?;
            Ok(ChunkHit {
                chunk_id: row.get(0)?,
                doc_id: row.get(1)?,
                revision: row.get(8)?,
                heading: row.get(2)?,
                quote: row.get(3)?,
                segment_id: if seg_from.is_empty() {
                    None
                } else {
                    Some(seg_from)
                },
                start_ms: row.get::<_, Option<i64>>(5)?.map(|ms| ms.max(0) as u64),
                end_ms: row.get::<_, Option<i64>>(6)?.map(|ms| ms.max(0) as u64),
                score: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document(segments: &[(u64, &str)], transcript: &str) -> Document {
        Document {
            id: "doc".into(),
            kind: "meeting".into(),
            title: "Weekly sync".into(),
            revision: "rev".into(),
            transcript: transcript.into(),
            segments: segments
                .iter()
                .map(|(ms, text)| serde_json::json!({"id": format!("s{ms}"), "startMs": ms, "endMs": ms + 1000, "text": text}))
                .collect(),
            ..Default::default()
        }
    }

    #[test]
    fn chunks_follow_segment_boundaries_with_overlap() {
        let segments: Vec<(u64, String)> = (0..40)
            .map(|i| (i * 1000, format!("第{i}句话关于项目预算的讨论内容超出预期。")))
            .collect();
        let doc = Document {
            id: "doc".into(),
            segments: segments
                .iter()
                .map(|(ms, text)| serde_json::json!({"id": format!("s{ms}"), "startMs": ms, "endMs": ms + 1000, "text": text}))
                .collect(),
            ..Default::default()
        };
        let chunks = chunk_segments(&parse_segments(&doc));
        assert!(chunks.len() > 1, "long transcript must split");
        for chunk in &chunks {
            assert!(chunk.start_ms.is_some() && chunk.end_ms.is_some());
            assert!(chunk.body.contains("第"));
        }
        // Overlap: some text repeats between adjacent chunks, and chunk
        // boundaries never split a segment (every body line is a full segment).
        let first = &chunks[0];
        assert_eq!(first.start_ms, Some(0));
        assert_eq!(first.seg_from, "s0");
        let last = chunks.last().unwrap();
        assert!(last.end_ms.unwrap() > first.end_ms.unwrap());
    }

    #[test]
    fn single_oversized_segment_stays_whole() {
        let doc = document(
            &[(0, &"很长的句子".repeat(300))],
            &"很长的句子".repeat(300),
        );
        let chunks = chunk_segments(&parse_segments(&doc));
        assert_eq!(chunks.len(), 1);
        assert!(chunks[0].body.chars().count() > CHUNK_CHARS);
    }

    #[test]
    fn meta_chunks_cover_title_outline_summary_tasks() {
        let mut doc = document(&[], "");
        doc.outline = "讨论预算".into();
        doc.conclusions = vec![serde_json::json!({"templateName": "纪要", "conclusionText": "结论文本"})];
        doc.todos = vec![serde_json::json!({"title": "跟进预算"})];
        let chunks = meta_chunks(&doc);
        let headings: Vec<_> = chunks.iter().map(|c| c.heading.as_str()).collect();
        assert_eq!(headings, vec!["Title", "Outline / 大纲", "纪要 1", "Tasks / 待办"]);
        assert!(chunks.iter().all(|c| c.start_ms.is_none()));
    }

    #[test]
    fn plain_transcript_chunks_when_segments_missing() {
        let text = "内容".repeat(600);
        let doc = document(&[], &text);
        let chunks = chunk_plain_text(&doc.transcript);
        assert!(chunks.len() >= 2);
        assert!(chunks.iter().all(|c| c.start_ms.is_none()));
    }

    #[test]
    fn jieba_query_matches_chunk_body_via_bm25() {
        let dir = std::env::temp_dir().join(format!("lynse-fulltext-{}", uuid::Uuid::new_v4()));
        let doc_a = document(
            &[(0, "今天讨论了第三季度的项目预算分配问题。"), (5000, "会议还确认了客户的交付时间表。")],
            "今天讨论了第三季度的项目预算分配问题。\n会议还确认了客户的交付时间表。",
        );
        let mut doc_b = document(&[(0, "周会记录了团队的组织安排。")], "周会记录了团队的组织安排。");
        doc_b.id = "doc-b".into();
        index_document(&dir, &doc_a, "hash-a").unwrap();
        index_document(&dir, &doc_b, "hash-b").unwrap();

        let hits = search(&dir, "项目预算", 10).unwrap();
        assert!(!hits.is_empty(), "jieba tokenized query must hit");
        assert_eq!(hits[0].doc_id, "doc");
        assert_eq!(hits[0].segment_id.as_deref(), Some("s0"));
        assert_eq!(hits[0].start_ms, Some(0));
        assert!(hits[0].quote.contains("预算"));

        // Incremental rebuild replaces the chunks of the updated document only.
        let mut updated = doc_a.clone();
        updated.revision = "rev2".into();
        updated.segments = vec![serde_json::json!({"id": "s0", "startMs": 0, "endMs": 4000, "text": "话题改为新产品发布计划。"})];
        index_document(&dir, &updated, "hash-a2").unwrap();
        let hits = search(&dir, "项目预算", 10).unwrap();
        assert!(hits.is_empty() || hits.iter().all(|hit| hit.doc_id != "doc"));
        let hits = search(&dir, "新产品发布", 10).unwrap();
        assert!(hits.iter().any(|hit| hit.doc_id == "doc"));

        remove_document(&dir, "doc");
        let hits = search(&dir, "新产品发布", 10).unwrap();
        assert!(hits.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_database_is_renamed_and_rebuilt() {
        let dir = std::env::temp_dir().join(format!("lynse-fulltext-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("fulltext.sqlite"), b"not a database at all").unwrap();
        let doc = document(&[(0, "预算讨论")], "预算讨论");
        index_document(&dir, &doc, "hash").unwrap();
        let hits = search(&dir, "预算", 10).unwrap();
        assert!(!hits.is_empty());
        let leftovers = std::fs::read_dir(&dir).unwrap().count();
        assert!(leftovers >= 2, "corrupt file must be kept aside");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn indexing_preserves_unchanged_locators_and_retires_removed_chunks() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let mut source = document(&[], "Uniquealpha passage.");
        index_document(&dir, &source, "one").unwrap();
        let first = search(&dir, "Uniquealpha", 5).unwrap().remove(0);
        source.folder_id = "Folder".into();
        source.refresh_revision();
        index_document(&dir, &source, "two").unwrap();
        let same = search(&dir, "Uniquealpha", 5).unwrap().remove(0);
        assert_eq!(first.chunk_id, same.chunk_id);
        assert_eq!(same.revision, source.revision);
        source.transcript = "Uniquebeta passage.".into();
        source.refresh_revision();
        index_document(&dir, &source, "three").unwrap();
        assert!(chunk(&dir, first.chunk_id).unwrap().is_none());
        let changed = search(&dir, "Uniquebeta", 5).unwrap().remove(0);
        remove_document(&dir, &source.id);
        assert!(chunk(&dir, changed.chunk_id).unwrap().is_none());
        index_document(&dir, &source, "three").unwrap();
        assert!(search(&dir, "Uniquebeta", 5).unwrap()[0].chunk_id > changed.chunk_id);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn match_expression_escapes_and_prefixes() {
        let expression = match_expression("预算 会").unwrap();
        assert!(expression.contains("\"预算\""));
        assert!(expression.contains("\"会\"*"));
        assert!(expression.contains(" OR "));
        assert!(match_expression("，。！").is_none());
    }
}
