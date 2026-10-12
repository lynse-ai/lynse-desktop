#!/usr/bin/env python3
"""Reproduce updater relaunch with closed output pipes using the production sink."""
import json
from pathlib import Path
import signal
import subprocess
import tempfile
import time

SOURCE = Path(__file__).resolve().parents[3] / "apps/tauri/src-tauri/src/logging/safe_writer.rs"
RUST = r'''use std::{fs, io::Write, path::PathBuf, thread, time::Duration};
#[path = SOURCE_PATH]
mod safe_writer;
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dir = PathBuf::from(&args[2]);
    let old = args[1] == "old";
    let sink: fern::Output = if old {
        std::io::stdout().into()
    } else {
        fern::Output::writer(Box::new(safe_writer::BestEffortWriter(std::io::stdout())), "\n")
    };
    fern::Dispatch::new().level(log::LevelFilter::Info).chain(sink).apply().unwrap();
    std::panic::set_hook(Box::new(move |_| {
        if old { log::error!("panic diagnostic"); }
        else { let _ = writeln!(std::io::stderr().lock(), "panic diagnostic"); }
    }));
    fs::write(dir.join("ready"), "ready").unwrap();
    while !dir.join("go").exists() { thread::sleep(Duration::from_millis(10)); }
    log::info!("startup diagnostic after updater relaunch");
    log::logger().flush();
}
'''

def run(binary, mode):
    with tempfile.TemporaryDirectory(prefix="lynse-relaunch-") as folder:
        directory = Path(folder)
        child = subprocess.Popen([binary, mode, folder], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic() + 10
            while not (directory / "ready").exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            if not (directory / "ready").exists():
                raise RuntimeError("relaunch probe did not initialize")
            child.stdout.close()
            child.stderr.close()
            (directory / "go").write_text("go")
            return child.wait(timeout=10)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()

if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="lynse-logging-probe-") as folder:
        project = Path(folder)
        (project / "src").mkdir()
        (project / "Cargo.toml").write_text('''[package]
name = "lynse-logging-probe"
version = "0.1.0"
edition = "2021"
[dependencies]
fern = "=0.7.1"
log = "0.4"
''')
        (project / "src/main.rs").write_text(RUST.replace("SOURCE_PATH", json.dumps(str(SOURCE))))
        subprocess.run(["cargo", "build", "--offline", "--manifest-path", str(project / "Cargo.toml")], check=True)
        binary = str(project / "target/debug/lynse-logging-probe")
        baseline, fixed = run(binary, "old"), run(binary, "fixed")
        print(f"closed launch pipes: baseline={baseline}, fixed={fixed}")
        assert baseline == -signal.SIGABRT, "expected the original recursive-panic abort"
        assert fixed == 0, "the production best-effort sink must survive closed launch pipes"
