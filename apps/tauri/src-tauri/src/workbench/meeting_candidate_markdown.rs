//! Rebuild the Markdown projection while preserving external edits.
use super::*;

struct DayView {
    pub event_date: String,
    pub rows: Vec<Value>,
}

fn day_views(conn: &Connection) -> CommandResult<Vec<DayView>> {
    let mut statement = conn
        .prepare(
            "SELECT event_date, id, kind, status, text, citations FROM candidate_entries
             WHERE status IN ('candidate','confirmed') AND superseded_by=''
             ORDER BY event_date DESC, event_time_ms IS NULL, event_time_ms ASC, created_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                json!({
                    "id": row.get::<_, String>(1)?,
                    "kind": row.get::<_, String>(2)?,
                    "status": row.get::<_, String>(3)?,
                    "text": row.get::<_, String>(4)?,
                    "citations": serde_json::from_str::<Value>(&row.get::<_, String>(5)?)
                        .unwrap_or_else(|_| json!([])),
                }),
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut views: Vec<DayView> = Vec::new();
    for (event_date, row) in rows {
        match views.last_mut() {
            Some(view) if view.event_date == event_date => view.rows.push(row),
            _ => views.push(DayView {
                event_date,
                rows: vec![row],
            }),
        }
    }
    Ok(views)
}

fn render_entry(row: &Value) -> String {
    let kind_label = match row["kind"].as_str() {
        Some("decision") => "决定",
        Some("proposal") => "提议",
        Some("unresolved") => "未决",
        _ => "事实",
    };
    let mut line = format!(
        "- 【{kind_label}】{}",
        row["text"].as_str().unwrap_or_default()
    );
    if let Some(refs) = row["citations"].as_array() {
        let evidence: Vec<String> = refs
            .iter()
            .take(3)
            .map(|reference| {
                let time = reference
                    .get("startMs")
                    .and_then(Value::as_i64)
                    .map(|ms| {
                        let seconds = (ms / 1000).max(0);
                        format!(" · {:02}:{:02}", seconds / 60, seconds % 60)
                    })
                    .unwrap_or_default();
                format!(
                    "「{}」{}",
                    reference
                        .get("quote")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    time
                )
            })
            .collect();
        if !evidence.is_empty() {
            line.push_str(&format!("  证据:{}", evidence.join("；")));
        }
    }
    line.push_str("  <!--candidate:");
    line.push_str(row["id"].as_str().unwrap_or_default());
    line.push_str("-->");
    line
}

pub(super) fn mark_render_pending(conn: &Connection) -> CommandResult<()> {
    config_set(conn, "render_pending", "1")
}

pub(super) fn render_pending(conn: &Connection) -> CommandResult<bool> {
    Ok(config_get(conn, "render_pending")?.as_deref() == Some("1"))
}

pub(super) fn render_markdown(conn: &Connection, memory_root: &Path) -> CommandResult<()> {
    let relative = "entries/meeting-candidates.md";
    let target = memory::safe_path(memory_root, relative)?;
    let incoming = memory::safe_path(memory_root, "entries/meeting-candidates.incoming.md")?;
    let views = day_views(conn)?;
    let mut document =
        String::from("# 会议候选记忆\n\n待确认条目由桌面逐篇提炼；确认后才会进入发布与召回。\n");
    for view in &views {
        let day = if view.event_date.is_empty() {
            "未知日期"
        } else {
            &view.event_date
        };
        document.push_str(&format!("\n## {day}\n\n"));
        let confirmed = view
            .rows
            .iter()
            .filter(|row| row["status"] == "confirmed")
            .count();
        for row in &view.rows {
            if row["status"] == "confirmed" {
                document.push_str(&render_entry(row));
                document.push_str("（已确认）\n");
            } else {
                document.push_str(&render_entry(row));
                document.push('\n');
            }
        }
        if confirmed > 0 {
            document.push_str(&format!("\n本日已确认 {confirmed} 条。\n"));
        }
    }
    let receipt_hash: Option<String> = conn
        .query_row(
            "SELECT hash FROM render_receipts WHERE path=?1",
            params![relative],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let existing = match fs::read(&target) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.to_string()),
    };
    let bytes = document.as_bytes();
    let externally_edited = match (&existing, &receipt_hash) {
        (Some(current), _) if current == bytes => false,
        (Some(current), Some(hash)) => store::digest(current) != *hash,
        (Some(_), None) => true,
        (None, _) => false,
    };
    let write_target = if externally_edited {
        &incoming
    } else {
        &target
    };
    if externally_edited {
        log::warn!(
            "[meeting-candidates] externally edited export preserved; fresh render staged at {}",
            incoming.display()
        );
    }
    let already_written = if externally_edited {
        fs::read(write_target).is_ok_and(|previous| previous == bytes)
    } else {
        existing.as_deref() == Some(bytes)
    };
    if !already_written {
        crate::atomic_write(write_target, bytes)?;
    }
    if !externally_edited {
        conn.execute(
            "INSERT INTO render_receipts (path, hash, updated_at) VALUES (?1,?2,?3)
             ON CONFLICT(path) DO UPDATE SET hash=excluded.hash, updated_at=excluded.updated_at",
            params![relative, store::digest(bytes), crate::now()],
        )
        .map_err(|e| e.to_string())?;
    }
    config_set(conn, "render_pending", "0")
}
