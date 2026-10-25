//! Explicit legacy ownership migration. Unknown records never enter an account automatically.
use super::*;
fn legacy_path(app: &AppHandle) -> CommandResult<PathBuf> {
    Ok(crate::app_data_dir(app)?
        .join("local-inspirations")
        .join("index.json"))
}
fn eligible(app: &AppHandle, row: &Value) -> bool {
    if protected(row) {
        return false;
    }
    match row["workbenchScope"].as_str() {
        Some(owner) => crate::workbench::current_scope(app).as_deref() == Some(owner),
        None => true,
    }
}
#[tauri::command(async)]
pub fn inspiration_legacy_status(app: AppHandle) -> CommandResult<Value> {
    scope(&app)?;
    Ok(
        json!({"count":crate::read_array(&legacy_path(&app)?)?.iter().filter(|r|eligible(&app,r)).count()}),
    )
}
#[tauri::command(async)]
pub fn inspiration_claim_legacy(app: AppHandle, acknowledge: bool) -> CommandResult<Value> {
    if !acknowledge {
        return Err("ownership_confirmation_required".into());
    }
    let owner = scope(&app)?;
    if !inspiration_cloud::read_binding(&app)?.is_some_and(|b| b.private_v2) {
        return Err("private_storage_unavailable".into());
    }
    let path = legacy_path(&app)?;
    let mut rows = crate::read_array(&path)?;
    let mut migrated = Vec::new();
    for row in rows.iter().filter(|r| eligible(&app, r)) {
        if scope(&app)? != owner {
            return Err("account_changed".into());
        }
        let id = row["id"].as_str().ok_or("invalid_record")?;
        let uuid = id
            .strip_prefix("inspiration:")
            .ok_or("invalid_identifier")?;
        uuid::Uuid::parse_str(uuid).map_err(|_| "invalid_identifier")?;
        if stored(&app, id).is_ok() {
            return Err("legacy_record_conflict".into());
        }
        let roots = [
            crate::app_data_dir(&app)?.join("inspirations").join(uuid),
            crate::vault::content_dir(&app, crate::vault::ContentKind::Inspirations)?.join(uuid),
        ];
        let mut input = json!({"id":id,"text":row["text"],"tags":row["tags"],"protection":"plain","aiContextEnabled":false,"pendingImages":[],"pendingFiles":[]});
        for (field, pending) in [("images", "pendingImages"), ("files", "pendingFiles")] {
            for item in row[field].as_array().into_iter().flatten() {
                let file = item["file"].as_str().ok_or("invalid_attachment")?;
                if !crate::is_safe_asset_file_name(file) {
                    return Err("invalid_attachment".into());
                }
                let source = roots
                    .iter()
                    .map(|r| r.join(file))
                    .find(|p| p.is_file())
                    .ok_or("legacy_attachment_missing")?;
                let staged =
                    inspiration_stage_file(app.clone(), source.to_string_lossy().into_owned())?;
                input[pending].as_array_mut().ok_or("invalid_record")?.push(json!({"sourcePath":staged["path"],"width":item["width"],"height":item["height"]}));
            }
        }
        // Historical voice audio is copied as an ordinary file; it is not
        // transcribed or uploaded automatically by the migration itself.
        if let Some(file) = row["audio"]["file"].as_str() {
            if !crate::is_safe_asset_file_name(file) {
                return Err("invalid_attachment".into());
            }
            let source = roots
                .iter()
                .map(|r| r.join(file))
                .find(|p| p.is_file())
                .ok_or("legacy_attachment_missing")?;
            let staged =
                inspiration_stage_file(app.clone(), source.to_string_lossy().into_owned())?;
            input["pendingFiles"]
                .as_array_mut()
                .ok_or("invalid_record")?
                .push(json!({"sourcePath":staged["path"]}));
        }
        save(&app, input)?;
        let state = app.state::<PrivateState>();
        let _sync = state
            .sync
            .try_lock()
            .map_err(|_| "inspiration_operation_busy")?;
        let _guard = state.serial.lock().map_err(|_| "storage_unavailable")?;
        if scope(&app)? != owner {
            return Err("account_changed".into());
        }
        let mut imported = stored(&app, id)?;
        imported["legacyImported"] = json!(true);
        for field in ["createdAt", "updatedAt", "transcript", "transcriptStatus"] {
            if let Some(value) = row.get(field) {
                imported[field] = value.clone();
            }
        }
        put(&app, &imported)?;
        cloud::queue(&app, &imported)?;
        migrated.push(id.to_owned());
    }
    rows.retain(|r| !migrated.iter().any(|id| r["id"] == *id));
    crate::write_array(&path, &rows)?;
    Ok(json!({"migrated":migrated.len()}))
}
