#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ssh;

#[tauri::command]
fn app_version() -> &'static str { "0.1.0-alpha.1" }

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![app_version, ssh::test_ssh_connection])
        .run(tauri::generate_context!())
        .expect("error while running OpsNest");
}
