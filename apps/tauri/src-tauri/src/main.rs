#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // The wiki synthesis pipeline polls a deeply nested async chain
    // (reqwest -> hyper -> tower retry -> redirect -> task_local -> timeout
    // -> direct synthesis). On tokio's 2 MiB default worker stack that chain
    // overflows during a compile pass and aborts the whole app, so the pass
    // never reaches its completion checkpoint and restarts on every launch.
    // std::thread reads RUST_MIN_STACK when tokio leaves thread_stack_size
    // unset; set it before Tauri creates its runtime. Respect an explicit
    // caller override.
    if std::env::var_os("RUST_MIN_STACK").is_none() {
        std::env::set_var("RUST_MIN_STACK", "8388608");
    }
    lynse_tauri::run();
}
