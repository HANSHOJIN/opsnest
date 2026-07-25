#![cfg_attr(windows, windows_subsystem = "windows")]

mod ssh;
mod storage;
mod ai;
mod web;

#[tauri::command]
fn app_version() -> &'static str { "0.1.0-alpha.6" }

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![app_version, ai::chat_completion, web::search_web, ssh::test_ssh_connection, ssh::inspect_server, ssh::diagnose_server, ssh::list_server_cron, ssh::save_server_cron, ssh::delete_server_cron, ssh::execute_ssh_command, ssh::stop_ssh_command, storage::load_local_data, storage::save_local_data, storage::append_runtime_log, storage::load_runtime_logs, storage::clear_runtime_logs, storage::append_conversation_log, storage::load_conversation_logs, storage::clear_conversation_logs, storage::save_server_credential, storage::load_server_credential, storage::delete_server_credential])
        .run(tauri::generate_context!())
        .expect("error while running OpsNest");
}
