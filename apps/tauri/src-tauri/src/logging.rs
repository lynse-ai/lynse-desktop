//! Date-based file logging. tauri-plugin-log stays the global logger — it
//! keeps stdout, the webview IPC commands, level filtering, and the default
//! `[date][time][target][LEVEL] message` line format. Only the file sink is
//! custom, wired through the plugin's `TargetKind::Dispatch` fern target,
//! because the plugin's built-in file target rotates by size only and has no
//! date-based option; every day must land in its own `lynse-YYYY-MM-DD.log`.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use chrono::{Duration as ChronoDuration, Local};

/// Daily files untouched for this many days (by modified time) are pruned at
/// startup, replacing the old size-based rotation's unbounded `KeepAll`.
const RETENTION_DAYS: i64 = 30;
/// Cadence for re-checking that the live file still exists. The storage
/// manager's "clear logs" unlinks it while this writer still holds the file
/// handle; without a re-check, logs would silently vanish into the unlinked
/// inode until the next midnight rollover.
const REOPEN_CHECK_INTERVAL: Duration = Duration::from_secs(60);

/// `Write` sink that appends to `lynse-YYYY-MM-DD.log` for the current local
/// date and swaps files when the date rolls over. File I/O failures are
/// swallowed (bytes reported as written) so the sink can never error out of
/// fern or panic the logger; stdout still carries every record regardless.
struct DailyLogFile {
    dir: PathBuf,
    /// Date key of the currently open file; `None` until the first open
    /// succeeds, which also makes every subsequent write retry the open.
    date: Option<String>,
    file: Option<fs::File>,
    last_reopen_check: Option<Instant>,
}

impl DailyLogFile {
    fn file_path(&self, date: &str) -> PathBuf {
        self.dir.join(format!("lynse-{date}.log"))
    }

    fn open(&mut self, date: &str) {
        let opened = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.file_path(date))
            .ok();
        self.date = opened.as_ref().map(|_| date.to_string());
        self.file = opened;
    }
}

impl Write for DailyLogFile {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let date = Local::now().format("%Y-%m-%d").to_string();
        let rollover = self.date.as_deref() != Some(date.as_str());
        let mut reopen = false;
        if !rollover {
            if let Some(last) = self.last_reopen_check {
                if last.elapsed() >= REOPEN_CHECK_INTERVAL {
                    self.last_reopen_check = Some(Instant::now());
                    reopen = !self.file_path(&date).exists();
                }
            }
        }
        if rollover || reopen {
            self.last_reopen_check = Some(Instant::now());
            self.open(&date);
        }
        match self.file.as_mut() {
            Some(file) => file.write(buf),
            None => Ok(buf.len()),
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        if let Some(file) = self.file.as_mut() {
            file.flush()?;
        }
        Ok(())
    }
}

/// Build the log plugin: stdout plus the daily-rolling file sink. The fern
/// dispatch carries no format of its own, so records inherit the plugin's
/// default format and the file lines look exactly like the old single-file
/// log; `Output::writer`'s `"\n"` terminator matches what the plugin's own
/// file targets do.
pub fn build_plugin(log_dir: &Path) -> tauri::plugin::TauriPlugin<tauri::Wry> {
    if let Err(error) = fs::create_dir_all(log_dir) {
        // No logger is installed yet at this point, so report on stderr; the
        // writer keeps failing silently afterwards and stdout still logs.
        eprintln!("Failed to create log dir {}: {error}", log_dir.display());
    }
    let writer = DailyLogFile {
        dir: log_dir.to_path_buf(),
        date: None,
        file: None,
        last_reopen_check: None,
    };
    tauri_plugin_log::Builder::new()
        .level(log::LevelFilter::Info)
        .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
        .targets([
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Dispatch(
                // fern wraps chained writers in its own Mutex, so the raw
                // sink needs no external lock.
                fern::Dispatch::new().chain(fern::Output::writer(Box::new(writer), "\n")),
            )),
        ])
        .build()
}

/// Delete `lynse*.log` files (current daily files plus archives left by the
/// old size-based rotation) whose last write predates the retention window.
/// Runs once at startup, before the plugin opens the live file, so a crash
/// history stays bounded without a background pruning task.
pub fn prune_old_logs(log_dir: &Path) {
    let cutoff: std::time::SystemTime = (Local::now() - ChronoDuration::days(RETENTION_DAYS)).into();
    let entries = match fs::read_dir(log_dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_lowercase();
        // Same matcher as `diagnostics_log_files` / `storage.rs`, so pruning
        // can never touch files those two would treat as app logs or miss
        // files it should prune.
        if !name.starts_with("lynse") || !name.ends_with(".log") {
            continue;
        }
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let stale = fs::metadata(&path)
            .and_then(|meta| meta.modified())
            .map(|modified| modified < cutoff)
            .unwrap_or(false);
        if stale {
            let _ = fs::remove_file(&path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn daily_file_names_and_recreates_after_storage_clear() {
        let dir = std::env::temp_dir().join(format!("lynse-logging-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let mut file = DailyLogFile {
            dir: dir.clone(),
            date: None,
            file: None,
            last_reopen_check: None,
        };
        file.write_all(b"first").unwrap();
        file.flush().unwrap();

        let date = Local::now().format("%Y-%m-%d").to_string();
        let path = file.file_path(&date);
        assert_eq!(
            path.file_name().unwrap().to_string_lossy(),
            format!("lynse-{date}.log")
        );

        // storage_clear("logs") deletes the live file under the open handle;
        // the next write past the re-open check interval must recreate it.
        fs::remove_file(&path).unwrap();
        file.last_reopen_check = Instant::now().checked_sub(REOPEN_CHECK_INTERVAL * 2);
        file.write_all(b" second").unwrap();
        file.flush().unwrap();
        assert!(path.exists(), "log file must be recreated after clear");
        assert_eq!(fs::read_to_string(&path).unwrap(), " second");
        let _ = fs::remove_dir_all(&dir);
    }
}
