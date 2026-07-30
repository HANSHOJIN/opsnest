#![cfg_attr(windows, windows_subsystem = "windows")]

mod ai;
mod app_commands;
mod ssh;
mod storage;
mod web;

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            app_commands::app_version,
            app_commands::open_external_url,
            app_commands::resolve_service_url,
            ai::chat_completion,
            ai::chat_completion_with_tools,
            web::search_web,
            ssh::test_ssh_connection,
            ssh::inspect_server,
            ssh::discover_server_services,
            ssh::diagnose_server,
            ssh::list_server_cron,
            ssh::save_server_cron,
            ssh::delete_server_cron,
            ssh::execute_ssh_command,
            ssh::open_ssh_terminal,
            ssh::write_ssh_terminal,
            ssh::resize_ssh_terminal,
            ssh::close_interactive_ssh_terminal,
            ssh::stop_ssh_command,
            ssh::close_ssh_shell,
            storage::load_local_data,
            storage::save_local_data,
            storage::append_runtime_log,
            storage::load_runtime_logs,
            storage::clear_runtime_logs,
            storage::append_conversation_log,
            storage::load_conversation_logs,
            storage::clear_conversation_logs,
            storage::save_server_credential,
            storage::load_server_credential,
            storage::delete_server_credential,
            storage::save_ai_credential,
            storage::load_ai_credential,
            storage::delete_ai_credential
        ])
        .run(tauri::generate_context!())
        .expect("error while running OpsNest");
}
