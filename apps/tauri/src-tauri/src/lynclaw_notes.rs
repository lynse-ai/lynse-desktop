use crate::{now, CommandResult};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::{fs, time::Duration};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewLynclawNote {
    title: String,
    source_file_id: String,
    source_title: String,
    format: String,
    body: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LynclawNoteInfo {
    id: String,
    title: String,
    source_file_id: String,
    source_title: String,
    format: String,
    created_at: String,
}

#[derive(Serialize)]
pub struct LynclawNote {
    #[serde(flatten)]
    info: LynclawNoteInfo,
    body: String,
}

fn note_info(row: &Row<'_>) -> rusqlite::Result<LynclawNoteInfo> {
    Ok(LynclawNoteInfo {
        id: row.get(0)?,
        title: row.get(1)?,
        source_file_id: row.get(2)?,
        source_title: row.get(3)?,
        format: row.get(4)?,
        created_at: row.get(5)?,
    })
}

async fn with_notes<T, F>(app: AppHandle, scope: String, operation: F) -> CommandResult<T>
where
    T: Send + 'static,
    F: FnOnce(&Connection, &str) -> rusqlite::Result<T> + Send + 'static,
{
    if scope.trim().is_empty() {
        return Err("Note account is required".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let root = app.path().app_data_dir().map_err(|error| error.to_string())?;
        fs::create_dir_all(&root).map_err(|error| error.to_string())?;
        let conn = Connection::open(root.join("lynclaw-notes.sqlite3"))
            .map_err(|error| error.to_string())?;
        conn.busy_timeout(Duration::from_secs(5))
            .map_err(|error| error.to_string())?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS notes (
                id TEXT PRIMARY KEY, scope TEXT NOT NULL, title TEXT NOT NULL, source_file_id TEXT NOT NULL,
                source_title TEXT NOT NULL, format TEXT NOT NULL CHECK (format IN ('markdown', 'html')),
                created_at TEXT NOT NULL, body TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS notes_scope_created ON notes(scope, created_at DESC);",
        ).map_err(|error| error.to_string())?;
        operation(&conn, &scope).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn lynclaw_notes_list(
    app: AppHandle,
    scope: String,
) -> CommandResult<Vec<LynclawNoteInfo>> {
    with_notes(app, scope, |conn, scope| {
        let mut stmt = conn.prepare(
            "SELECT id, title, source_file_id, source_title, format, created_at
             FROM notes WHERE scope = ?1 ORDER BY created_at DESC, id DESC",
        )?;
        let rows = stmt.query_map([scope], note_info)?;
        rows.collect()
    })
    .await
}

#[tauri::command]
pub async fn lynclaw_note_create(
    app: AppHandle,
    scope: String,
    note: NewLynclawNote,
) -> CommandResult<LynclawNoteInfo> {
    if note.title.trim().is_empty()
        || note.body.trim().is_empty()
        || note.source_file_id.trim().is_empty()
    {
        return Err("Note title, summary and source recording are required".into());
    }
    let info = LynclawNoteInfo {
        id: Uuid::new_v4().to_string(),
        title: note.title,
        source_file_id: note.source_file_id,
        source_title: note.source_title,
        format: note.format,
        created_at: now(),
    };
    with_notes(app, scope, move |conn, scope| {
        conn.execute(
            "INSERT INTO notes (id, scope, title, source_file_id, source_title, format, created_at, body)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                info.id,
                scope,
                info.title,
                info.source_file_id,
                info.source_title,
                info.format,
                info.created_at,
                note.body
            ],
        )?;
        Ok(info)
    })
    .await
}

#[tauri::command]
pub async fn lynclaw_note_read(
    app: AppHandle,
    scope: String,
    id: String,
) -> CommandResult<Option<LynclawNote>> {
    with_notes(app, scope, move |conn, scope| {
        conn.query_row(
            "SELECT id, title, source_file_id, source_title, format, created_at, body
             FROM notes WHERE scope = ?1 AND id = ?2",
            params![scope, id],
            |row| {
                Ok(LynclawNote {
                    info: note_info(row)?,
                    body: row.get(6)?,
                })
            },
        )
        .optional()
    })
    .await
}

#[tauri::command]
pub async fn lynclaw_note_update(
    app: AppHandle,
    scope: String,
    id: String,
    body: String,
) -> CommandResult<()> {
    let updated = with_notes(app, scope, move |conn, scope| {
        conn.execute(
            "UPDATE notes SET body = ?3 WHERE scope = ?1 AND id = ?2 AND format = 'markdown'",
            params![scope, id, body],
        )
    })
    .await?;
    if updated == 0 {
        return Err("Note is unavailable".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn lynclaw_note_delete(app: AppHandle, scope: String, id: String) -> CommandResult<()> {
    with_notes(app, scope, move |conn, scope| {
        conn.execute(
            "DELETE FROM notes WHERE scope = ?1 AND id = ?2",
            params![scope, id],
        )?;
        Ok(())
    })
    .await
}
