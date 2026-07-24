#![cfg_attr(windows, windows_subsystem = "windows")]

mod ssh;
mod storage;

#[tauri::command]
fn app_version() -> &'static str { "0.1.0-alpha.1" }

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![app_version, ssh::test_ssh_connection, ssh::inspect_server, ssh::execute_ssh_command, storage::load_local_data, storage::save_local_data])
        .run(tauri::generate_context!())
        .expect("error while running OpsNest");
}
