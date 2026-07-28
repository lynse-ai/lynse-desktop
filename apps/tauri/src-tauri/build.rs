fn main() {
    println!("cargo:rerun-if-env-changed=LYNSE_FEISHU_APP_ID");
    println!("cargo:rerun-if-env-changed=LYNSE_FEISHU_APP_SECRET");
    tauri_build::build()
}
