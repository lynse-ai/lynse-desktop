use crate::CommandResult;
use serde::Deserialize;
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum MemoryRequest {
    List,
    Read {
        path: String,
    },
    Reload {
        path: String,
    },
    Save {
        path: String,
        markdown: String,
        revision: String,
    },
    Create {
        title: String,
    },
}

pub(super) fn safe_path(root: &Path, relative: &str) -> CommandResult<PathBuf> {
    let parts: Vec<_> = relative.split('/').collect();
    let valid = matches!(relative, "memory_summary.md" | "MEMORY.md")
        || (parts.len() == 2
            && matches!(parts[0], "notes" | "entries")
            && parts[1].ends_with(".md")
            && parts[1].len() <= 100
            && !parts[1].starts_with('.')
            && parts[1]
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')));
    if !valid {
        return Err("Invalid memory file path".into());
    }
    let mut path = root.to_path_buf();
    // Never follow a link into another account or outside the selected vault.
    if fs::symlink_metadata(root).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("Memory folder must not be a symbolic link".into());
    }
    for part in parts {
        path.push(part);
        if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err("Memory files must not be symbolic links".into());
        }
    }
    Ok(path)
}
