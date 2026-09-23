use crate::{agent_workflow::AgentTurn, file_manager, ssh_scan, ssh_session, tools::ToolKind};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

struct AiSshCancellation {
    generation: u64,
    sender: oneshot::Sender<()>,
}

static AI_SSH_CANCELLATIONS: OnceLock<Mutex<HashMap<String, AiSshCancellation>>> = OnceLock::new();
static AI_SSH_CANCELLATION_GENERATION: OnceLock<Mutex<u64>> = OnceLock::new();

fn ai_ssh_cancellations() -> &'static Mutex<HashMap<String, AiSshCancellation>> {
    AI_SSH_CANCELLATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_ai_ssh_generation() -> u64 {
    let counter = AI_SSH_CANCELLATION_GENERATION.get_or_init(|| Mutex::new(0));
    match counter.lock() {
        Ok(mut generation) => {
            *generation = generation.wrapping_add(1);
            *generation
        }
        Err(_) => 0,
    }
}

const DISCOVER_SERVICES_COOLDOWN: Duration = Duration::from_secs(5);
const DISCOVER_SERVICES_CACHE_RETENTION: Duration = Duration::from_secs(60);

struct ServiceDiscoveryCacheEntry {
    completed_at: Instant,
    output: String,
}

static SERVICE_DISCOVERY_CACHE: OnceLock<Mutex<HashMap<String, ServiceDiscoveryCacheEntry>>> =
    OnceLock::new();

fn service_discovery_cache() -> &'static Mutex<HashMap<String, ServiceDiscoveryCacheEntry>> {
    SERVICE_DISCOVERY_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cached_service_discovery(session_id: &str) -> Option<String> {
    let now = Instant::now();
    let mut cache = service_discovery_cache().lock().ok()?;
    cache.retain(|_, entry| {
        now.duration_since(entry.completed_at) < DISCOVER_SERVICES_CACHE_RETENTION
    });
    let entry = cache.get(session_id)?;
    let age = now.duration_since(entry.completed_at);
    if age >= DISCOVER_SERVICES_COOLDOWN {
        return None;
    }
    let mut payload = match serde_json::from_str::<Value>(&entry.output) {
        Ok(payload) => payload,
        Err(_) => return Some(entry.output.clone()),
    };
    payload["cached"] = Value::Bool(true);
    payload["cacheAgeMs"] = serde_json::json!(age.as_millis());
    serde_json::to_string(&payload).ok()
}

fn remember_service_discovery(session_id: &str, output: String) {
    if let Ok(mut cache) = service_discovery_cache().lock() {
        cache.insert(
            session_id.to_string(),
            ServiceDiscoveryCacheEntry {
                completed_at: Instant::now(),
                output,
            },
        );
    }
}

struct AiSshCancellationGuard {
    session_id: String,
    generation: u64,
}

impl Drop for AiSshCancellationGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = ai_ssh_cancellations().lock() {
            if active
                .get(&self.session_id)
                .is_some_and(|entry| entry.generation == self.generation)
            {
                active.remove(&self.session_id);
            }
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatRequest {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub api_mode: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    pub system: String,
    pub prompt: String,
    pub messages: Option<Vec<Value>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiToolChatRequest {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub api_mode: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    pub messages: Vec<Value>,
    pub tools: Vec<Value>,
    pub tool_choice: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSshRequest {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub api_mode: Option<String>,
    pub session_id: String,
    /// Stable OpsNest server id used when an AI tool needs to request a UI
    /// action for the same server. It is never used as an SSH credential.
    pub server_id: Option<String>,
    pub prompt: String,
    pub approved: bool,
    pub context: Option<String>,
    /// Model context window in tokens, discovered by the model connection test.
    pub context_length: Option<u64>,
    /// Kept outside model messages. This is read from the local system
    /// credential store only when the user configured optional sudo access.
    pub sudo_password: Option<String>,
    /// Set when the user has approved a previously proposed command. The
    /// backend executes this exact command once, then asks the model to
    /// interpret the real terminal result instead of starting a second plan.
    pub approved_command: Option<String>,
}

const FALLBACK_AI_CONTEXT_TOKENS: usize = 32_000;
const MIN_AI_CONTEXT_CHARS: usize = 12_000;
const MAX_AI_CONTEXT_CHARS: usize = 1_500_000;

fn ai_context_max_chars(context_length: Option<u64>) -> usize {
    let tokens = context_length
        .filter(|value| *value > 0)
        .map(|value| value.min(usize::MAX as u64) as usize)
        .unwrap_or(FALLBACK_AI_CONTEXT_TOKENS);
    tokens
        .saturating_mul(3)
        .clamp(MIN_AI_CONTEXT_CHARS, MAX_AI_CONTEXT_CHARS)
}

fn summarize_execution(executed: &[Value]) -> String {
    if executed.is_empty() {
        return "本轮没有执行命令。".to_string();
    }
    let failures = executed
        .iter()
        .filter(|item| {
            item.get("output")
                .and_then(Value::as_str)
                .map(|value| {
                    value.contains("[command_error]") || value.contains("__OPSNEST_COMMAND_ERROR__")
                })
                .unwrap_or(false)
                || item
                    .get("verification")
                    .and_then(Value::as_str)
                    .map(|value| {
                        value.contains("[verification_error]")
                            || value.contains("__OPSNEST_VERIFICATION_ERROR__")
                    })
                    .unwrap_or(false)
        })
        .count();
    let last_output = executed
        .last()
        .and_then(|item| item.get("output"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    let tail = last_output
        .chars()
        .rev()
        .take(360)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    if failures > 0 {
        format!(
            "已执行 {} 条命令，其中 {} 条失败。最近结果：{}",
            executed.len(),
            failures,
            tail
        )
    } else {
        format!(
            "已执行 {} 条命令，全部返回结果。最近结果：{}",
            executed.len(),
            tail
        )
    }
}

const MAX_LIST_ENTRIES: usize = 200;
const DEFAULT_READ_BYTES: usize = 32 * 1024;
const MAX_READ_BYTES: usize = 64 * 1024;
const DEFAULT_WORKSPACE_DOWNLOAD_BYTES: usize = 8 * 1024 * 1024;
const MAX_WORKSPACE_DOWNLOAD_BYTES: usize = 8 * 1024 * 1024;
const MAX_WORKSPACE_UPLOAD_BYTES: usize = 8 * 1024 * 1024;

/// Execute a read-only model tool without touching the interactive PTY. The
/// existing terminal session supplies the credentials locally; only the
/// bounded result is returned to the model.
async fn execute_read_only_tool(
    session_id: &str,
    kind: ToolKind,
    arguments: &Value,
) -> Result<(String, String), String> {
    let request = ssh_session::session_request(session_id)?;
    match kind {
        ToolKind::ListFiles => {
            let path = arguments
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or("/root")
                .trim();
            if path.is_empty() {
                return Err("list_files path must not be empty".to_string());
            }
            let entries = file_manager::list_remote_directory(request, path.to_string()).await?;
            let truncated = entries.len() > MAX_LIST_ENTRIES;
            let entries = entries
                .into_iter()
                .take(MAX_LIST_ENTRIES)
                .collect::<Vec<_>>();
            let output = serde_json::to_string(&serde_json::json!({
                "path": path,
                "entries": entries,
                "truncated": truncated,
                "limit": MAX_LIST_ENTRIES
            }))
            .map_err(|error| format!("failed to encode list_files result: {error}"))?;
            Ok((format!("list_files {path}"), output))
        }
        ToolKind::ReadFile => {
            let path = arguments
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| "read_file path is required".to_string())?
                .trim();
            if path.is_empty() {
                return Err("read_file path must not be empty".to_string());
            }
            let max_bytes = match arguments.get("max_bytes").and_then(Value::as_u64) {
                Some(value) if (1..=MAX_READ_BYTES as u64).contains(&value) => value as usize,
                Some(_) => {
                    return Err(format!(
                        "read_file max_bytes must be between 1 and {MAX_READ_BYTES}"
                    ));
                }
                None => DEFAULT_READ_BYTES,
            };
            let content = file_manager::read_remote_text(&request, path, max_bytes).await?;
            let output = serde_json::to_string(&serde_json::json!({
                "path": path,
                "content": content,
                "maxBytes": max_bytes
            }))
            .map_err(|error| format!("failed to encode read_file result: {error}"))?;
            Ok((format!("read_file {path}"), output))
        }
        ToolKind::DiscoverServices => {
            if let Some(output) = cached_service_discovery(session_id) {
                return Ok(("discover_services (cached)".to_string(), output));
            }
            let scan_request = ssh_scan::ScanRequest {
                host: request.host,
                port: request.port,
                username: request.username,
                auth_method: request.auth_method,
                password: request.password,
                sudo_password: request.sudo_password,
                private_key_path: request.private_key_path,
                passphrase: request.passphrase,
            };
            let services = ssh_scan::discover_linux_services(scan_request).await?;
            let truncated = services.len() > MAX_LIST_ENTRIES;
            let services = services
                .into_iter()
                .take(MAX_LIST_ENTRIES)
                .collect::<Vec<_>>();
            let output = serde_json::to_string(&serde_json::json!({
                "services": services,
                "truncated": truncated,
                "limit": MAX_LIST_ENTRIES,
                "cached": false
            }))
            .map_err(|error| format!("failed to encode discover_services result: {error}"))?;
            remember_service_discovery(session_id, output.clone());
            Ok(("discover_services".to_string(), output))
        }
        ToolKind::WorkspaceListFiles => {
            let path = arguments.get("path").and_then(Value::as_str);
            let (info, entries) = crate::workspace::list_workspace_files(session_id, path)?;
            let truncated = entries.len() > MAX_LIST_ENTRIES;
            let entries = entries
                .into_iter()
                .take(MAX_LIST_ENTRIES)
                .collect::<Vec<_>>();
            let output = serde_json::to_string(&serde_json::json!({
                "workspaceId": info.workspace_id,
                "root": info.root,
                "path": path.unwrap_or(""),
                "entries": entries,
                "truncated": truncated,
                "limit": MAX_LIST_ENTRIES
            }))
            .map_err(|error| format!("failed to encode workspace_list_files result: {error}"))?;
            Ok(("workspace_list_files".to_string(), output))
        }
        ToolKind::WorkspaceReadFile => {
            let path = arguments
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| "workspace_read_file path is required".to_string())?
                .trim();
            if path.is_empty() {
                return Err("workspace_read_file path must not be empty".to_string());
            }
            let max_bytes = match arguments.get("max_bytes").and_then(Value::as_u64) {
                Some(value) if (1..=MAX_READ_BYTES as u64).contains(&value) => value as usize,
                Some(_) => {
                    return Err(format!(
                        "workspace_read_file max_bytes must be between 1 and {MAX_READ_BYTES}"
                    ));
                }
                None => DEFAULT_READ_BYTES,
            };
            let content =
                crate::workspace::read_workspace_text(session_id.to_string(), path.to_string())?
                    .ok_or_else(|| "workspace file does not exist".to_string())?;
            if content.as_bytes().len() > max_bytes {
                return Err(format!(
                    "workspace file exceeds the {max_bytes}-byte read limit"
                ));
            }
            let output = serde_json::to_string(&serde_json::json!({
                "path": path,
                "content": content,
                "maxBytes": max_bytes
            }))
            .map_err(|error| format!("failed to encode workspace_read_file result: {error}"))?;
            Ok((format!("workspace_read_file {path}"), output))
        }
        ToolKind::WorkspaceWriteFile => {
            let path = arguments
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| "workspace_write_file path is required".to_string())?
                .trim();
            let content = arguments
                .get("content")
                .and_then(Value::as_str)
                .ok_or_else(|| "workspace_write_file content is required".to_string())?;
            if path.is_empty() {
                return Err("workspace_write_file path must not be empty".to_string());
            }
            crate::workspace::write_workspace_text(
                session_id.to_string(),
                path.to_string(),
                content.to_string(),
            )?;
            let output = serde_json::to_string(&serde_json::json!({
                "written": true,
                "path": path,
                "bytes": content.as_bytes().len(),
                "location": "local_workspace"
            }))
            .map_err(|error| format!("failed to encode workspace_write_file result: {error}"))?;
            Ok((format!("workspace_write_file {path}"), output))
        }
        ToolKind::WorkspaceDeleteFile => {
            let path = arguments
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| "workspace_delete_file path is required".to_string())?
                .trim();
            if path.is_empty() {
                return Err("workspace_delete_file path must not be empty".to_string());
            }
            crate::workspace::delete_workspace_file(session_id.to_string(), path.to_string())?;
            let output = serde_json::to_string(&serde_json::json!({
                "deleted": true,
                "path": path,
                "location": "local_workspace"
            }))
            .map_err(|error| format!("failed to encode workspace_delete_file result: {error}"))?;
            Ok((format!("workspace_delete_file {path}"), output))
        }
        ToolKind::DownloadToWorkspace => {
            let remote_path = arguments
                .get("remote_path")
                .and_then(Value::as_str)
                .ok_or_else(|| "download_to_workspace remote_path is required".to_string())?
                .trim();
            let path = arguments
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| "download_to_workspace path is required".to_string())?
                .trim();
            if remote_path.is_empty() || path.is_empty() {
                return Err("download_to_workspace paths must not be empty".to_string());
            }
            let max_bytes = match arguments.get("max_bytes").and_then(Value::as_u64) {
                Some(value) if (1..=MAX_WORKSPACE_DOWNLOAD_BYTES as u64).contains(&value) => {
                    value as usize
                }
                Some(_) => {
                    return Err(format!(
                        "download_to_workspace max_bytes must be between 1 and {MAX_WORKSPACE_DOWNLOAD_BYTES}"
                    ));
                }
                None => DEFAULT_WORKSPACE_DOWNLOAD_BYTES,
            };
            let data = file_manager::read_remote_bytes(&request, remote_path, max_bytes).await?;
            crate::workspace::write_workspace_bytes(session_id, path, &data)?;
            let output = serde_json::to_string(&serde_json::json!({
                "downloaded": true,
                "remotePath": remote_path,
                "path": path,
                "bytes": data.len(),
                "location": "local_workspace"
            }))
            .map_err(|error| format!("failed to encode download_to_workspace result: {error}"))?;
            Ok((
                format!("download_to_workspace {remote_path} -> {path}"),
                output,
            ))
        }
        ToolKind::UploadWorkspaceFile => {
            let path = arguments
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| "upload_workspace_file path is required".to_string())?
                .trim();
            let remote_path = arguments
                .get("remote_path")
                .and_then(Value::as_str)
                .ok_or_else(|| "upload_workspace_file remote_path is required".to_string())?
                .trim();
            if path.is_empty() || remote_path.is_empty() {
                return Err("upload_workspace_file paths must not be empty".to_string());
            }
            if !remote_path.starts_with('/') {
                return Err("upload_workspace_file remote_path must be an absolute path".to_string());
            }
            let overwrite = arguments
                .get("overwrite")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let data = crate::workspace::read_workspace_bytes(
                session_id,
                path,
                MAX_WORKSPACE_UPLOAD_BYTES,
            )?;
            let bytes = file_manager::upload_remote_bytes(&request, remote_path, &data, overwrite).await?;
            let output = serde_json::to_string(&serde_json::json!({
                "uploaded": true,
                "path": path,
                "remotePath": remote_path,
                "bytes": bytes,
                "overwrote": overwrite,
                "location": "remote_server"
            }))
            .map_err(|error| format!("failed to encode upload_workspace_file result: {error}"))?;
            Ok((format!("upload_workspace_file {path} -> {remote_path}"), output))
        }
        ToolKind::RunCommand => Err("run_command is not a read-only tool".to_string()),
        ToolKind::OpenFileManager | ToolKind::OpenFileEditor => {
            Err("OpsNest UI tools use the UI action executor".to_string())
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
enum OpenCodeGoProtocol {
    ChatCompletions,
    Responses,
    Messages,
}

impl OpenCodeGoProtocol {
    fn endpoint(self) -> &'static str {
        match self {
            Self::ChatCompletions => "chat/completions",
            Self::Responses => "responses",
            Self::Messages => "messages",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeGoModel {
    id: String,
    protocol: Option<OpenCodeGoProtocol>,
}

const OPENCODE_GO_BASE_URL: &str = "https://opencode.ai/zen/go/v1";

fn opencode_go_protocol(model: &str) -> Option<OpenCodeGoProtocol> {
    let model = model.trim();
    // Keep this allowlist aligned with OpenCode's per-model endpoint matrix:
    // https://opencode.ai/docs/go/
    const CHAT_COMPLETIONS_MODELS: &[&str] = &[
        "glm-5.3-flash",
        "glm-5.3",
        "glm-5.2",
        "glm-5.1",
        "kimi-k3",
        "kimi-k2.7-code",
        "kimi-k2.6",
        "longcat-2.0",
        "deepseek-v4.1-flash",
        "deepseek-v4-pro",
        "deepseek-v4-flash",
        "deepseek-v4-flash-vision-exp",
        "mimo-v2.6-flash",
        "mimo-v2.6-pro",
        "mimo-v2.5",
        "mimo-v2.5-pro",
        "hy4-preview",
        "hy3",
    ];
    const RESPONSES_MODELS: &[&str] = &[
        "grok-4.7",
        "grok-4.6",
        "gpt-5.6-luna",
        "muse-spark-1.3-contributor",
        "muse-spark-1.2-contributor",
    ];
    const MESSAGES_MODELS: &[&str] = &[
        "minimax-m3",
        "minimax-m2.7",
        "minimax-m2.5",
        "qwen3.8-max",
        "qwen3.8-flash",
        "qwen3.7-max",
        "qwen3.7-plus",
        "qwen3.6-plus",
    ];
    if CHAT_COMPLETIONS_MODELS.contains(&model) {
        Some(OpenCodeGoProtocol::ChatCompletions)
    } else if RESPONSES_MODELS.contains(&model) {
        Some(OpenCodeGoProtocol::Responses)
    } else if MESSAGES_MODELS.contains(&model) {
        Some(OpenCodeGoProtocol::Messages)
    } else {
        None
    }
}

fn opencode_go_session_header(session_id: Option<&str>) -> String {
    let value = session_id.unwrap_or("opsnest-session").trim();
    let clean = value
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | ':')
        })
        .take(128)
        .collect::<String>();
    if clean.is_empty() {
        "opsnest-session".to_string()
    } else {
        clean
    }
}

fn responses_tool(tool: &Value) -> Option<Value> {
    let function = tool.get("function").unwrap_or(tool);
    Some(serde_json::json!({
        "type": "function",
        "name": function.get("name")?.as_str()?,
        "description": function.get("description").cloned().unwrap_or(Value::String(String::new())),
        "parameters": function.get("parameters").cloned().unwrap_or_else(|| serde_json::json!({"type":"object","properties":{}})),
        "strict": function.get("strict").cloned().unwrap_or(Value::Bool(false)),
    }))
}

fn responses_input(messages: &[Value]) -> Vec<Value> {
    let mut input = Vec::new();
    for message in messages {
        let role = message.get("role").and_then(Value::as_str).unwrap_or("user");
        if role == "tool" {
            input.push(serde_json::json!({
                "type": "function_call_output",
                "call_id": message.get("tool_call_id").cloned().unwrap_or(Value::Null),
                "output": message.get("content").cloned().unwrap_or(Value::String(String::new())),
            }));
            continue;
        }
        let response_role = if role == "system" { "developer" } else { role };
        let content = message.get("content").cloned().unwrap_or(Value::Null);
        if !content.is_null() && content.as_str().map_or(true, |text| !text.is_empty()) {
            input.push(serde_json::json!({
                "type": "message",
                "role": response_role,
                "content": content,
            }));
        }
        if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
            for call in calls {
                let function = call.get("function").cloned().unwrap_or(Value::Null);
                input.push(serde_json::json!({
                    "type": "function_call",
                    "call_id": call.get("id").cloned().unwrap_or(Value::Null),
                    "name": function.get("name").cloned().unwrap_or(Value::Null),
                    "arguments": function.get("arguments").cloned().unwrap_or(Value::String("{}".to_string())),
                }));
            }
        }
    }
    input
}

pub(crate) fn responses_request_body(model: &str, body: &Value) -> Value {
    let messages = body.get("messages").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut response = serde_json::json!({
        "model": model,
        "input": responses_input(&messages),
        "store": false,
    });
    if let Some(max_tokens) = body.get("max_tokens") {
        response["max_output_tokens"] = max_tokens.clone();
    }
    if let Some(tools) = body.get("tools").and_then(Value::as_array) {
        response["tools"] = Value::Array(tools.iter().filter_map(responses_tool).collect());
    }
    if let Some(choice) = body.get("tool_choice") {
        response["tool_choice"] = choice.clone();
    }
    response
}

pub(crate) fn normalize_responses_response(payload: &Value) -> Value {
    let mut text = String::new();
    let mut tool_calls = Vec::new();
    if let Some(output) = payload.get("output").and_then(Value::as_array) {
        for item in output {
            match item.get("type").and_then(Value::as_str).unwrap_or_default() {
                "message" => {
                    if let Some(contents) = item.get("content").and_then(Value::as_array) {
                        for content in contents {
                            if matches!(content.get("type").and_then(Value::as_str), Some("output_text" | "text")) {
                                if let Some(value) = content.get("text").and_then(Value::as_str) {
                                    if !text.is_empty() { text.push('\n'); }
                                    text.push_str(value);
                                }
                            }
                        }
                    }
                }
                "function_call" => tool_calls.push(serde_json::json!({
                    "id": item.get("call_id").or_else(|| item.get("id")).cloned().unwrap_or(Value::Null),
                    "type": "function",
                    "function": {
                        "name": item.get("name").cloned().unwrap_or(Value::Null),
                        "arguments": item.get("arguments").cloned().unwrap_or(Value::String("{}".to_string())),
                    }
                })),
                _ => {}
            }
        }
    }
    if text.is_empty() {
        text = payload
            .get("output_text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
    }
    serde_json::json!({"choices":[{"message":{"role":"assistant","content":text,"tool_calls":tool_calls}}]})
}

fn messages_tool(tool: &Value) -> Option<Value> {
    let function = tool.get("function").unwrap_or(tool);
    Some(serde_json::json!({
        "name": function.get("name")?.as_str()?,
        "description": function.get("description").cloned().unwrap_or(Value::String(String::new())),
        "input_schema": function.get("parameters").cloned().unwrap_or_else(|| serde_json::json!({"type":"object","properties":{}})),
    }))
}

fn messages_request_body(model: &str, body: &Value) -> Value {
    let messages = body.get("messages").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut system = Vec::new();
    let mut converted = Vec::new();
    for message in messages {
        let role = message.get("role").and_then(Value::as_str).unwrap_or("user");
        let content = message.get("content").cloned().unwrap_or(Value::Null);
        if role == "system" || role == "developer" {
            if let Some(text) = content.as_str().filter(|text| !text.is_empty()) { system.push(text.to_string()); }
            continue;
        }
        if role == "tool" {
            converted.push(serde_json::json!({"role":"user","content":[{
                "type":"tool_result",
                "tool_use_id":message.get("tool_call_id").cloned().unwrap_or(Value::Null),
                "content":content,
            }]}));
            continue;
        }
        let mut blocks = Vec::new();
        if let Some(text) = content.as_str().filter(|text| !text.is_empty()) {
            blocks.push(serde_json::json!({"type":"text","text":text}));
        } else if content.is_array() {
            blocks.extend(content.as_array().cloned().unwrap_or_default());
        }
        if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
            for call in calls {
                let function = call.get("function").cloned().unwrap_or(Value::Null);
                let arguments = function.get("arguments").and_then(Value::as_str)
                    .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                    .unwrap_or_else(|| serde_json::json!({}));
                blocks.push(serde_json::json!({
                    "type":"tool_use",
                    "id":call.get("id").cloned().unwrap_or(Value::Null),
                    "name":function.get("name").cloned().unwrap_or(Value::Null),
                    "input":arguments,
                }));
            }
        }
        converted.push(serde_json::json!({"role":if role == "assistant" {"assistant"} else {"user"},"content":blocks}));
    }
    let max_tokens = body.get("max_tokens").cloned().unwrap_or(Value::from(4096));
    let mut request = serde_json::json!({"model":model,"messages":converted,"max_tokens":max_tokens});
    if !system.is_empty() { request["system"] = Value::String(system.join("\n\n")); }
    if let Some(tools) = body.get("tools").and_then(Value::as_array) {
        request["tools"] = Value::Array(tools.iter().filter_map(messages_tool).collect());
    }
    if let Some(choice) = body.get("tool_choice") {
        let value = choice.as_str().unwrap_or_default();
        match value {
            "auto" => request["tool_choice"] = serde_json::json!({"type":"auto"}),
            "required" => request["tool_choice"] = serde_json::json!({"type":"any"}),
            "none" => { request.as_object_mut().map(|object| object.remove("tools")); }
            _ => {}
        }
    }
    request
}

fn normalize_messages_response(payload: &Value) -> Value {
    let mut text = String::new();
    let mut tool_calls = Vec::new();
    if let Some(contents) = payload.get("content").and_then(Value::as_array) {
        for item in contents {
            match item.get("type").and_then(Value::as_str).unwrap_or_default() {
                "text" => if let Some(value) = item.get("text").and_then(Value::as_str) {
                    if !text.is_empty() { text.push('\n'); }
                    text.push_str(value);
                },
                "tool_use" => tool_calls.push(serde_json::json!({
                    "id":item.get("id").cloned().unwrap_or(Value::Null),
                    "type":"function",
                    "function":{
                        "name":item.get("name").cloned().unwrap_or(Value::Null),
                        "arguments":item.get("input").map(Value::to_string).unwrap_or_else(|| "{}".to_string()),
                    }
                })),
                _ => {}
            }
        }
    }
    serde_json::json!({"choices":[{"message":{"role":"assistant","content":text,"tool_calls":tool_calls}}]})
}

async fn post_chat(
    provider: &str,
    api_mode: Option<&str>,
    session_id: Option<&str>,
    base_url: &str,
    api_key: &str,
    model: &str,
    body: Value,
    timeout: Duration,
    mut cancel: Option<&mut oneshot::Receiver<()>>,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|error| error.to_string())?;
    let is_opencode_go = provider == "opencode-go";
    let protocol = if is_opencode_go {
        opencode_go_protocol(model)
            .ok_or_else(|| format!("OpenCode Go has no verified API route for model `{model}`. Refresh the model list or select a supported model."))?
    } else if provider == "openai" && api_mode == Some("responses") {
        OpenCodeGoProtocol::Responses
    } else {
        OpenCodeGoProtocol::ChatCompletions
    };
    let (url, request_body) = if is_opencode_go || matches!(protocol, OpenCodeGoProtocol::Responses) {
        let url = if is_opencode_go {
            format!("{OPENCODE_GO_BASE_URL}/{}", protocol.endpoint())
        } else {
            format!("{}/{}", base_url.trim().trim_end_matches('/'), protocol.endpoint())
        };
        let body = match protocol {
            OpenCodeGoProtocol::ChatCompletions => {
                let mut body = body;
                if let Some(object) = body.as_object_mut() {
                    object.remove("temperature");
                }
                body
            }
            OpenCodeGoProtocol::Responses => responses_request_body(model, &body),
            OpenCodeGoProtocol::Messages => messages_request_body(model, &body),
        };
        (url, body)
    } else {
        (format!("{}/chat/completions", base_url.trim().trim_end_matches('/')), body)
    };
    let mut call = client.post(url).json(&request_body);
    if is_opencode_go {
        call = call
            .bearer_auth(api_key.trim())
            .header(reqwest::header::USER_AGENT, format!("OpsNest/{}", env!("CARGO_PKG_VERSION")))
            .header("x-opencode-session", opencode_go_session_header(session_id));
        if matches!(protocol, OpenCodeGoProtocol::Messages) {
            call = call
                .header("x-api-key", api_key.trim())
                .header("anthropic-version", "2023-06-01");
        }
    } else if !api_key.trim().is_empty() {
        call = call.bearer_auth(api_key.trim());
    }
    let response = if let Some(cancel) = cancel.as_deref_mut() {
        tokio::select! {
            result = call.send() => result.map_err(|error| error.to_string())?,
            _ = cancel => return Err("AI-SSH request cancelled".into()),
        }
    } else {
        call.send().await.map_err(|error| error.to_string())?
    };
    let status = response.status();
    let raw = if let Some(cancel) = cancel.as_deref_mut() {
        tokio::select! {
            result = response.text() => result.map_err(|error| error.to_string())?,
            _ = cancel => return Err("AI-SSH request cancelled".into()),
        }
    } else {
        response.text().await.map_err(|error| error.to_string())?
    };
    if !status.is_success() {
        return Err(format!(
            "{} {}",
            status.as_u16(),
            raw.chars().take(600).collect::<String>()
        ));
    }
    if is_opencode_go || matches!(protocol, OpenCodeGoProtocol::Responses) {
        let payload: Value = serde_json::from_str(&raw)
            .map_err(|error| format!("Invalid OpenCode Go response: {error}"))?;
        let normalized = match protocol {
            OpenCodeGoProtocol::ChatCompletions => payload,
            OpenCodeGoProtocol::Responses => normalize_responses_response(&payload),
            OpenCodeGoProtocol::Messages => normalize_messages_response(&payload),
        };
        serde_json::to_string(&normalized).map_err(|error| error.to_string())
    } else {
        Ok(raw)
    }
}

#[tauri::command]
pub async fn fetch_opencode_go_models(api_key: String) -> Result<Vec<OpenCodeGoModel>, String> {
    if api_key.trim().is_empty() {
        return Err("OpenCode Go API Key is required".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("unable to create HTTP client: {error}"))?;
    let response = client
        .get(format!("{OPENCODE_GO_BASE_URL}/models"))
        .bearer_auth(api_key.trim())
        .header(reqwest::header::USER_AGENT, format!("OpsNest/{}", env!("CARGO_PKG_VERSION")))
        .header("x-opencode-session", "opsnest-model-catalog")
        .send()
        .await
        .map_err(|error| format!("OpenCode Go model list request failed: {error}"))?;
    let status = response.status();
    let raw = response.text().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(format!("OpenCode Go returned {}: {}", status.as_u16(), raw.chars().take(400).collect::<String>()));
    }
    let payload: Value = serde_json::from_str(&raw).map_err(|error| format!("invalid OpenCode Go model list: {error}"))?;
    let items = payload.get("data").and_then(Value::as_array).ok_or_else(|| "OpenCode Go response did not contain a model list".to_string())?;
    let mut models = items.iter().filter_map(|item| {
        let id = item.get("id")?.as_str()?.trim();
        (!id.is_empty()).then(|| OpenCodeGoModel { id: id.to_string(), protocol: opencode_go_protocol(id) })
    }).collect::<Vec<_>>();
    models.sort_by(|left, right| left.id.cmp(&right.id));
    models.dedup_by(|left, right| left.id == right.id);
    if models.is_empty() { return Err("OpenCode Go returned no models".to_string()); }
    Ok(models)
}

pub async fn test_opencode_go_connection(api_key: &str, model: &str) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err("OpenCode Go API Key is required".to_string());
    }
    if opencode_go_protocol(model).is_none() {
        return Err(format!("OpenCode Go has no verified API route for model `{model}`."));
    }
    // Match live agent requests. Some thinking models reject `required`.
    let raw = post_chat(
        "opencode-go",
        None,
        Some("opsnest-model-test"),
        OPENCODE_GO_BASE_URL,
        api_key,
        model,
        serde_json::json!({
            "model": model,
            "messages": [{"role":"user","content":"Call the provided opsnest_connection_test tool with ok=true. Do not answer with prose."}],
            "max_tokens": 64,
            "tools": [{
                "type":"function",
                "function": {
                    "name":"opsnest_connection_test",
                    "description":"Return the supplied boolean unchanged. This is a no-op compatibility test; do not perform external actions.",
                    "parameters": {
                        "type":"object",
                        "properties":{"ok":{"type":"boolean"}},
                        "required":["ok"],
                        "additionalProperties":false
                    }
                }
            }],
            "tool_choice":"auto",
        }),
        Duration::from_secs(30),
        None,
    )
    .await?;
    let payload: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("OpenCode Go response was invalid: {error}"))?;
    let message = payload.get("choices").and_then(|choices| choices.get(0)).and_then(|choice| choice.get("message"));
    if message.is_none() {
        return Err("OpenCode Go response did not contain a completion".to_string());
    }
    if message.and_then(|item| item.get("tool_calls")).and_then(Value::as_array).map_or(true, Vec::is_empty) {
        return Err("Connection succeeded, but the selected model did not return the required tool-call format.".to_string());
    }
    Ok(serde_json::json!({
        "message": "Connection successful · tool-call verified · OpenCode Go",
        "contextLength": Value::Null,
    }).to_string())
}

#[tauri::command]
pub async fn chat_completion(request: AiChatRequest) -> Result<String, String> {
    if request.base_url.trim().is_empty() || request.model.trim().is_empty() {
        return Err("AI base URL and model are required".into());
    }
    let mut messages = request.messages.unwrap_or_default();
    messages.retain(|message| {
        message.get("role").and_then(Value::as_str).is_some()
            && message.get("content").and_then(Value::as_str).is_some()
    });
    messages.insert(
        0,
        serde_json::json!({ "role": "system", "content": request.system }),
    );
    messages.push(serde_json::json!({ "role": "user", "content": request.prompt }));
    let raw = post_chat(
        &request.provider,
        request.api_mode.as_deref(),
        request.session_id.as_deref(),
        &request.base_url,
        &request.api_key,
        &request.model,
        serde_json::json!({ "model": request.model.trim(), "temperature": 0.2, "messages": messages }),
        Duration::from_secs(90),
        None,
    ).await?;
    let payload: Value =
        serde_json::from_str(&raw).map_err(|error| format!("Invalid AI response: {error}"))?;
    payload
        .get("choices")
        .and_then(|items| items.get(0))
        .and_then(|item| item.get("message"))
        .and_then(|item| item.get("content"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "AI response did not contain message content".into())
}

#[tauri::command]
pub async fn chat_completion_with_tools(request: AiToolChatRequest) -> Result<String, String> {
    if request.base_url.trim().is_empty()
        || request.model.trim().is_empty()
        || request.messages.is_empty()
        || request.tools.is_empty()
    {
        return Err("AI tool request is incomplete".into());
    }
    let mut messages = request.messages;
    if let Some(system) = messages
        .iter_mut()
        .find(|message| message.get("role").and_then(Value::as_str) == Some("system"))
    {
        let content = system
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default();
        system["content"] = Value::String(format!(
            "{content}\n\n统一交互规则：所有用户输入都必须交给模型结合当前服务器和对话上下文判断，不得使用固定的寒暄词表或本地关键词分流。普通聊天、感谢、确认、追问和结果讨论直接自然回答；只有明确的读取、检查、修改或执行请求才调用工具。没有工具结果时不得声称操作已完成。"
        ));
    }
    let mut body = serde_json::json!({ "model": request.model.trim(), "temperature": 0.2, "messages": messages, "tools": request.tools });
    if let Some(choice) = request.tool_choice {
        body["tool_choice"] = choice;
    }
    let raw = post_chat(
        &request.provider,
        request.api_mode.as_deref(),
        request.session_id.as_deref(),
        &request.base_url,
        &request.api_key,
        &request.model,
        body,
        Duration::from_secs(120),
        None,
    )
    .await?;
    serde_json::from_str::<Value>(&raw)
        .map_err(|error| format!("Invalid AI tool response: {error}"))?;
    Ok(raw)
}

#[tauri::command]
pub async fn ai_ssh_chat(request: AiSshRequest) -> Result<String, String> {
    if request.base_url.trim().is_empty()
        || request.model.trim().is_empty()
        || request.session_id.trim().is_empty()
        || request.prompt.trim().is_empty()
    {
        return Err("AI-SSH request is incomplete".into());
    }
    let (cancel_sender, mut cancel_receiver) = oneshot::channel();
    let cancellation_generation = next_ai_ssh_generation();
    if let Ok(mut active) = ai_ssh_cancellations().lock() {
        if let Some(previous) = active.insert(
            request.session_id.clone(),
            AiSshCancellation {
                generation: cancellation_generation,
                sender: cancel_sender,
            },
        ) {
            let _ = previous.sender.send(());
        }
    }
    let session_id = request.session_id.clone();
    let _cancellation_guard = AiSshCancellationGuard {
        session_id: session_id.clone(),
        generation: cancellation_generation,
    };
    let mut workflow = AgentTurn::start(cancellation_generation);
    record_agent_phase(&request.session_id, &workflow);
    let context_max_chars = ai_context_max_chars(request.context_length);
    let board_context = ssh_session::session_context(&request.session_id, context_max_chars);
    let conversation_history =
        ssh_session::conversation_history(&request.session_id, context_max_chars);
    let _ = ssh_session::record_session_event(
        &request.session_id,
        "user_message",
        request.prompt.clone(),
    );
    let tool_registry = crate::tools::default_registry();
    let tool_schemas = tool_registry.schemas();
    let context = request
        .context
        .unwrap_or_else(|| "当前服务器上下文未提供。".to_string());
    let system = format!("你是 OpsNest AI-SSH，负责当前服务器的真实终端协作。\n当前上下文：{context}\n当前会话同时绑定了一个 OpsNest 本地 workspace（工作区）。它位于用户电脑上，与远程服务器文件系统分离；需要保存、备份、编辑、读取或暂存本地文件时，使用 workspace_list_files、workspace_read_file、workspace_write_file、workspace_delete_file 或 download_to_workspace。用户说“保存到 workspace/工作区/本地”时，必须使用这些本地工具，不要通过 run_command 在远程创建同名工作目录；但用户明确指定远程路径，或任务确实需要在远程服务器准备工作目录时，仍可使用远程工具。\n解释意图时简洁自然；只有用户明确要求执行、检查或修改时才调用 run_command。普通聊天、感谢、确认和追问都交给模型自然回答，不使用固定关键词分流。用户明确要求打开 OpsNest 文件管理器或查看刚才修改的远程文件时，调用对应的 opsnest_open_file_manager 或 opsnest_open_file_editor；这些工具只改变 OpsNest 界面，不读取或修改远程文件。没有工具结果时不得声称命令已经执行。命令执行后必须根据真实工具输出继续判断。回答长度规则：默认先给结论，控制在 3-6 行或不超过 5 个要点；成功执行后只报告结果、异常和必要的下一步，不复述原始终端输出，不写背景教程、长篇风险清单或多个备选方案。只有用户明确要求详细解释、教程或完整排障步骤时才展开。");
    let system = format!("{system}\n每轮最多请求一个工具；如果需要多个工具，等待上一个结果返回后再逐个请求。");
    let system = format!("{system}\n需要把本地 workspace 中生成的脚本交给远程服务器执行时，先使用 upload_workspace_file 上传，再使用 run_command 调用远程路径；workspace_write_file 只写本机，不会自动出现在服务器上。不要在没有对应工具结果时声称上传或执行成功。若工具返回超时，不要原样重复同一条命令；应缩小扫描范围、使用 -l/--include 或 Docker CLI 查询，避免递归读取大型日志目录。\n共享终端黑板（最近事件）：\n{board_context}\n");
    // The PTY output is already visible in the xterm surface. Keep replies
    // focused on interpretation and next steps instead of copying a full
    // directory listing or command transcript into the green AI channel.
    let system = format!(
        "{system}\nTerminal output is visible to the user in real time. Do not repeat raw command output, file listings, prompts, or banners unless the user explicitly asks for a quotation. If a read-only tool result already answers the request (for example ls, pwd, df, or system status), return no summary text; only report errors, anomalies, or an actionable conclusion."
    );
    let system = if request
        .sudo_password
        .as_deref()
        .is_some_and(|value| !value.is_empty())
    {
        format!(
            "{system}\nThis server has a locally configured sudo credential. When elevation is genuinely required, use a command beginning with `sudo `. The credential is supplied locally after approval; never request, print, or transmit it."
        )
    } else {
        system
    };
    let mut messages = vec![serde_json::json!({"role":"system","content":system})];
    for (role, content) in conversation_history {
        messages.push(serde_json::json!({"role": role, "content": content}));
    }
    messages.push(serde_json::json!({"role":"user","content":request.prompt}));
    let approved_followup = request
        .approved_command
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let mut approved_for_this_turn = request.approved;
    let mut executed = Vec::new();
    let mut ui_actions = Vec::new();
    if let Some(command) = approved_followup.as_deref() {
        if is_interactive_agent_command(command) {
            return Ok(serde_json::json!({
                "status": "error",
                "content": "该命令会接管交互式终端，不能作为 AI 工具执行。请直接在 SSH 终端中输入并操作。",
                "executed": executed
            })
            .to_string());
        }
        workflow.tool_requested(true);
        workflow.approval_granted();
        record_agent_phase(&request.session_id, &workflow);
        let (output, terminal_marker) =
            match ssh_session::run_interactive_command_with_marker_cancel(
                &request.session_id,
                command,
                true,
                request.sudo_password.as_deref(),
                &mut cancel_receiver,
            )
            .await
            {
                Ok(value) => (value.output, Some(value.terminal_marker)),
                Err(error) if error == "AI-SSH command cancelled" => {
                    workflow.cancel();
                    record_agent_phase(&request.session_id, &workflow);
                    return Ok(serde_json::json!({
                        "status": "cancelled",
                        "content": "",
                        "executed": executed
                    })
                    .to_string());
                }
                Err(error) => (format!("__OPSNEST_COMMAND_ERROR__{error}"), None),
            };
        let _ = ssh_session::record_session_event(
            &request.session_id,
            "ai_tool_result",
            format!("命令：{}\n输出：{}", command, output),
        );
        executed.push(serde_json::json!({
            "command": command,
            "output": output,
            "terminalMarker": terminal_marker
        }));
        workflow.tool_completed();
        record_agent_phase(&request.session_id, &workflow);
        messages.push(serde_json::json!({
            "role":"user",
            "content": format!(
                "用户已确认执行命令 `{}`。命令已经在真实终端执行，下面是原始输出：\n{}\n请根据这个结果继续回复用户，不要再次执行同一命令。",
                command,
                executed.last().and_then(|item| item.get("output")).and_then(Value::as_str).unwrap_or_default()
            )
        }));
    }
    let mut recovery_attempts = 0u8;
    for round in 0..8 {
        if round > 0 {
            workflow.begin_step();
            record_agent_phase(&request.session_id, &workflow);
        }
        let tool_choice = if approved_followup.is_some() {
            "none"
        } else {
            "auto"
        };
        let raw = match post_chat(
            &request.provider,
            request.api_mode.as_deref(),
            Some(&request.session_id),
            &request.base_url,
            &request.api_key,
            &request.model,
            serde_json::json!({"model":request.model.trim(),"temperature":0.1,"messages":messages,"tools":tool_schemas,"tool_choice":tool_choice}),
            Duration::from_secs(60),
            Some(&mut cancel_receiver),
        ).await {
            Ok(raw) => raw,
            Err(error) if error == "AI-SSH request cancelled" => {
                workflow.cancel();
                record_agent_phase(&request.session_id, &workflow);
                return Ok(serde_json::json!({
                    "status": "cancelled",
                    "content": "",
                    "executed": executed
                })
                .to_string());
            }
            Err(error) if recovery_attempts < 1 => {
                recovery_attempts += 1;
                let _ = ssh_session::record_session_event(&request.session_id, "ai_recovery", format!("AI 请求失败，正在重试（第 {} 次）：{}", recovery_attempts, error));
                tokio::time::sleep(Duration::from_millis(500 * u64::from(recovery_attempts))).await;
                continue;
            }
            Err(error) if !executed.is_empty() => {
                workflow.fail();
                record_agent_phase(&request.session_id, &workflow);
                return Ok(serde_json::json!({
                    "status": "error",
                    "content": format!("AI 请求失败，重试后仍未恢复：{error}"),
                    "executed": executed,
                    "uiActions": ui_actions
                })
                .to_string());
            }
            Err(error) => return Err(format!("AI 请求失败，重试后仍未恢复：{error}")),
        };
        let payload: Value = match serde_json::from_str(&raw) {
            Ok(payload) => payload,
            Err(error) => {
                workflow.fail();
                record_agent_phase(&request.session_id, &workflow);
                return Err(format!("Invalid AI response: {error}"));
            }
        };
        let choice = match payload.get("choices").and_then(|items| items.get(0)) {
            Some(choice) => choice,
            None => {
                workflow.fail();
                record_agent_phase(&request.session_id, &workflow);
                return Err("AI response did not contain choices".to_string());
            }
        };
        let message = choice.get("message").cloned().unwrap_or_default();
        if let Some(call) = message.get("tool_calls").and_then(|calls| calls.get(0)) {
            let tool_name = call
                .get("function")
                .and_then(|function| function.get("name"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            let tool_kind = tool_registry
                .get(tool_name)
                .map(|tool| tool.kind)
                .ok_or_else(|| format!("AI requested an unknown tool: {tool_name}"))?;
            let arguments = call
                .get("function")
                .and_then(|function| function.get("arguments"))
                .and_then(Value::as_str)
                .and_then(|value| serde_json::from_str::<Value>(value).ok())
                .unwrap_or_default();
            if matches!(
                tool_kind,
                ToolKind::OpenFileManager | ToolKind::OpenFileEditor
            ) {
                workflow.tool_requested(false);
                record_agent_phase(&request.session_id, &workflow);
                let tool_call_id = call
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("opsnest-call")
                    .to_string();
                let (display, output, action) = match execute_opsnest_ui_tool(
                    tool_kind,
                    &arguments,
                    request.server_id.as_deref(),
                ) {
                    Ok(result) => result,
                    Err(error) => (
                        tool_name.to_string(),
                        format!("__OPSNEST_UI_ERROR__{error}"),
                        Value::Null,
                    ),
                };
                if !action.is_null() {
                    ui_actions.push(action);
                }
                let _ = ssh_session::record_session_event(
                    &request.session_id,
                    "ai_tool_result",
                    format!("工具：{}\n结果：{}", display, output),
                );
                workflow.tool_completed();
                record_agent_phase(&request.session_id, &workflow);
                messages.push(message.clone());
                messages.push(serde_json::json!({
                    "role":"tool",
                    "tool_call_id":tool_call_id,
                    "content":output
                }));
                messages.extend(deferred_tool_results(&message));
                approved_for_this_turn = false;
                continue;
            }
            if tool_kind != ToolKind::RunCommand {
                workflow.tool_requested(false);
                record_agent_phase(&request.session_id, &workflow);
                let tool_call_id = call
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("opsnest-call")
                    .to_string();
                let (display, output) = match execute_read_only_tool(
                    &request.session_id,
                    tool_kind,
                    &arguments,
                )
                .await
                {
                    Ok(result) => result,
                    Err(error) => {
                        let display = match tool_kind {
                            ToolKind::ListFiles => "list_files".to_string(),
                            ToolKind::ReadFile => "read_file".to_string(),
                            ToolKind::DiscoverServices => "discover_services".to_string(),
                            ToolKind::OpenFileManager => "opsnest_open_file_manager".to_string(),
                            ToolKind::OpenFileEditor => "opsnest_open_file_editor".to_string(),
                            ToolKind::WorkspaceListFiles => "workspace_list_files".to_string(),
                            ToolKind::WorkspaceReadFile => "workspace_read_file".to_string(),
                            ToolKind::WorkspaceWriteFile => "workspace_write_file".to_string(),
                            ToolKind::WorkspaceDeleteFile => "workspace_delete_file".to_string(),
                            ToolKind::DownloadToWorkspace => "download_to_workspace".to_string(),
                            ToolKind::UploadWorkspaceFile => "upload_workspace_file".to_string(),
                            ToolKind::RunCommand => "run_command".to_string(),
                        };
                        (display, format!("__OPSNEST_READONLY_ERROR__{error}"))
                    }
                };
                let _ = ssh_session::record_session_event(
                    &request.session_id,
                    "ai_tool_result",
                    format!("工具：{}\n结果：{}", display, output),
                );
                executed.push(serde_json::json!({
                    "tool": tool_name,
                    "command": display,
                    "output": output
                }));
                workflow.tool_completed();
                record_agent_phase(&request.session_id, &workflow);
                messages.push(message.clone());
                messages.push(serde_json::json!({
                    "role":"tool",
                    "tool_call_id":tool_call_id,
                    "content":executed.last().and_then(|item| item.get("output")).and_then(Value::as_str).unwrap_or_default()
                }));
                messages.extend(deferred_tool_results(&message));
                approved_for_this_turn = false;
                continue;
            }
            let command = arguments
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();
            let verify_command = arguments
                .get("verify_command")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();
            let explain = arguments
                .get("explain")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let risk = arguments
                .get("risk")
                .and_then(Value::as_str)
                .unwrap_or("medium")
                .to_string();
            if command.is_empty() {
                workflow.fail();
                record_agent_phase(&request.session_id, &workflow);
                return Err("AI requested an invalid command".into());
            }
            if is_interactive_agent_command(&command) {
                workflow.fail();
                record_agent_phase(&request.session_id, &workflow);
                return Ok(serde_json::json!({
                    "status": "error",
                    "content": "该命令会接管交互式终端，不能作为 AI 工具执行。请直接在 SSH 终端中输入并操作。",
                    "executed": executed,
                    "uiActions": ui_actions
                })
                .to_string());
            }
            let requires_approval =
                !approved_for_this_turn && command_requires_approval(&command, &risk);
            workflow.tool_requested(requires_approval);
            record_agent_phase(&request.session_id, &workflow);
            if requires_approval {
                return Ok(serde_json::json!({"status":"approval_required","command":command,"verifyCommand":verify_command,"explain":explain,"risk":risk,"executed":executed}).to_string());
            }
            let execution = match ssh_session::run_interactive_command_with_marker_cancel(
                &request.session_id,
                &command,
                true,
                request.sudo_password.as_deref(),
                &mut cancel_receiver,
            )
            .await
            {
                Ok(value) => value,
                Err(error) if error == "AI-SSH command cancelled" => {
                    workflow.cancel();
                    record_agent_phase(&request.session_id, &workflow);
                    return Ok(serde_json::json!({
                        "status": "cancelled",
                        "content": "",
                        "executed": executed
                    })
                    .to_string());
                }
                Err(error) => ssh_session::InteractiveCommandResult {
                    output: format!("__OPSNEST_COMMAND_ERROR__{error}"),
                    terminal_marker: String::new(),
                },
            };
            let output = execution.output;
            let terminal_marker = execution.terminal_marker;
            if output.contains("[command_error]") || output.contains("__OPSNEST_COMMAND_ERROR__") {
                recovery_attempts = recovery_attempts.saturating_add(1);
                let _ = ssh_session::record_session_event(
                    &request.session_id,
                    "ai_recovery",
                    format!("命令执行失败，已把错误返回给模型继续恢复：{}", output),
                );
            }
            let (verification, verification_marker) =
                if verify_command.is_empty() || verify_command == command {
                    (None, None)
                } else {
                    let verification_execution =
                        match ssh_session::run_interactive_command_with_marker_cancel(
                            &request.session_id,
                            &verify_command,
                            true,
                            request.sudo_password.as_deref(),
                            &mut cancel_receiver,
                        )
                        .await
                        {
                            Ok(value) => value,
                            Err(error) if error == "AI-SSH command cancelled" => {
                                workflow.cancel();
                                record_agent_phase(&request.session_id, &workflow);
                                return Ok(serde_json::json!({
                                    "status": "cancelled",
                                    "content": "",
                                    "executed": executed
                                })
                                .to_string());
                            }
                            Err(error) => ssh_session::InteractiveCommandResult {
                                output: format!("__OPSNEST_VERIFICATION_ERROR__{error}"),
                                terminal_marker: String::new(),
                            },
                        };
                    (
                        Some(verification_execution.output),
                        Some(verification_execution.terminal_marker),
                    )
                };
            let _ = ssh_session::record_session_event(
                &request.session_id,
                "ai_tool_result",
                format!(
                    "命令：{}\n输出：{}{}",
                    command,
                    output,
                    verification
                        .as_ref()
                        .map(|value| format!("\n验证：{value}"))
                        .unwrap_or_default()
                ),
            );
            executed.push(serde_json::json!({
                "command": command,
                "output": output,
                "verification": verification,
                "terminalMarker": terminal_marker,
                "verificationTerminalMarker": verification_marker
            }));
            workflow.tool_completed();
            record_agent_phase(&request.session_id, &workflow);
            let tool_call_id = call
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("opsnest-call")
                .to_string();
            messages.push(message.clone());
            let tool_content = verification
                .as_ref()
                .map(|value| format!("{output}\n\n[verification]\n{value}"))
                .unwrap_or(output);
            messages.push(serde_json::json!({"role":"tool","tool_call_id":tool_call_id,"content":tool_content}));
            messages.extend(deferred_tool_results(&message));
            approved_for_this_turn = false;
            continue;
        }
        let content = message.get("content").and_then(Value::as_str).unwrap_or("");
        let _ = ssh_session::record_session_event(
            &request.session_id,
            "ai_message",
            content.to_string(),
        );
        workflow.finalize();
        record_agent_phase(&request.session_id, &workflow);
        let summary = summarize_execution(&executed);
        workflow.complete();
        record_agent_phase(&request.session_id, &workflow);
        return Ok(serde_json::json!({"status":if executed.is_empty() { "answer" } else { "executed" },"content":content,"summary":summary,"recoveryAttempts":recovery_attempts,"executed":executed,"uiActions":ui_actions}).to_string());
    }
    if recovery_attempts > 0 {
        workflow.fail();
        record_agent_phase(&request.session_id, &workflow);
        let summary = summarize_execution(&executed);
        return Ok(serde_json::json!({"status":"recovery_required","content":"本轮达到最大恢复步数，已停止继续执行。请查看摘要后决定是否继续。","summary":summary,"recoveryAttempts":recovery_attempts,"executed":executed,"uiActions":ui_actions}).to_string());
    }
    workflow.fail();
    record_agent_phase(&request.session_id, &workflow);
    Ok(serde_json::json!({"status":"executed","content":"达到本轮 AI-SSH 最大步骤数，请确认后继续。","executed":executed,"uiActions":ui_actions}).to_string())
}

fn record_agent_phase(session_id: &str, turn: &AgentTurn) {
    let _ = ssh_session::record_session_event(
        session_id,
        "agent_phase",
        turn.event_payload().to_string(),
    );
}

fn deferred_tool_results(message: &Value) -> Vec<Value> {
    message
        .get("tool_calls")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .skip(1)
        .filter_map(|call| {
            let call_id = call.get("id").and_then(Value::as_str)?.trim();
            if call_id.is_empty() {
                return None;
            }
            Some(serde_json::json!({
                "role": "tool",
                "tool_call_id": call_id,
                "content": "This tool call was not executed in this pass. OpsNest processes one server operation at a time; request this action again after reviewing the previous tool result."
            }))
        })
        .collect()
}

fn is_interactive_agent_command(command: &str) -> bool {
    let words = command
        .split_whitespace()
        .map(|word| word.to_ascii_lowercase())
        .collect::<Vec<_>>();
    let Some(first) = words.first().map(String::as_str) else {
        return false;
    };
    let first_base = first.rsplit('/').next().unwrap_or(first);
    // 1Panel's CLI owns a confirmation prompt for destructive operations. Do
    // not run it through the model tool channel, which has no safe way to
    // relay a later y/n byte; ask the user to run it directly in the PTY.
    if first_base == "1pctl"
        && words.iter().any(|word| {
            matches!(word.as_str(), "uninstall" | "remove" | "delete" | "purge" | "install" | "upgrade")
        })
    {
        return true;
    }
    let interactive_programs = [
        "bash", "sh", "zsh", "fish", "vim", "nvim", "nano", "top", "htop", "tmux",
        "screen", "mysql", "psql", "sftp", "ftp",
    ];
    if interactive_programs.contains(&first)
        && !words.iter().any(|word| word == "-c" || word == "--command")
    {
        return true;
    }
    if first != "sudo" && first != "doas" {
        return false;
    }
    let mut index = 1;
    let mut interactive_option = false;
    let mut command_name: Option<&str> = None;
    while index < words.len() {
        let word = words[index].as_str();
        if word == "--" {
            command_name = words.get(index + 1).map(String::as_str);
            break;
        }
        if matches!(word, "-i" | "--login" | "-s" | "--shell") {
            interactive_option = true;
            index += 1;
            continue;
        }
        if word == "-n" || word == "--non-interactive" {
            return false;
        }
        if word.starts_with('-') {
            if matches!(word, "-u" | "-g" | "-r" | "-R" | "-C") {
                index += 2;
            } else {
                index += 1;
            }
            continue;
        }
        command_name = Some(word);
        break;
    }
    if !interactive_option {
        return matches!(command_name, Some("su" | "bash" | "sh" | "zsh" | "fish"));
    }
    command_name.is_none()
        || matches!(command_name, Some("su" | "bash" | "sh" | "zsh" | "fish"))
}

#[tauri::command]
pub fn cancel_ai_ssh_chat(session_id: String) -> Result<(), String> {
    let sender = ai_ssh_cancellations()
        .lock()
        .map_err(|_| "AI-SSH cancellation state is unavailable".to_string())?
        .remove(&session_id);
    if let Some(sender) = sender {
        let _ = sender.sender.send(());
    }
    Ok(())
}

fn command_requires_approval(command: &str, declared_risk: &str) -> bool {
    let lowered = command.to_ascii_lowercase();
    // The model's risk label is advisory. Read-only inspection should remain
    // one-click/automatic even when the model conservatively labels it high.
    [
        "sudo ",
        "rm ",
        "mv ",
        "cp ",
        "chmod ",
        "chown ",
        "systemctl start",
        "systemctl stop",
        "systemctl restart",
        "systemctl enable",
        "systemctl disable",
        "systemctl mask",
        "systemctl unmask",
        "systemctl reload",
        "service start",
        "service stop",
        "service restart",
        "reboot",
        "shutdown",
        "docker rm",
        "docker stop",
        "docker restart",
        "apt install",
        "apt remove",
        "apt purge",
        "apt upgrade",
        "dnf install",
        "yum install",
        "apk add",
        "pacman -s",
        "mkfs",
        "dd ",
    ]
    .iter()
    .any(|token| lowered.contains(token))
        || (declared_risk.eq_ignore_ascii_case("high") && !is_read_only_command(&lowered))
}

fn is_read_only_command(command: &str) -> bool {
    let read_only = [
        "which ",
        "command -v ",
        "type ",
        "ls",
        "stat ",
        "cat ",
        "head ",
        "tail ",
        "grep ",
        "egrep ",
        "fgrep ",
        "awk ",
        "sed -n",
        "find ",
        "ps",
        "top",
        "free",
        "df",
        "du ",
        "uname",
        "id",
        "whoami",
        "hostname",
        "uptime",
        "env",
        "printenv",
        "systemctl status",
        "systemctl is-active",
        "systemctl list-units",
        "service --status-all",
        "docker ps",
        "docker inspect",
        "docker version",
        "docker info",
        "ss ",
        "netstat ",
        "ip ",
        "curl -i",
        "curl -I",
        "wget --spider",
    ];
    command
        .split(|ch| ch == '&' || ch == '|' || ch == ';')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .all(|part| read_only.iter().any(|prefix| part.starts_with(prefix)))
}

fn execute_opsnest_ui_tool(
    kind: ToolKind,
    arguments: &Value,
    server_id: Option<&str>,
) -> Result<(String, String, Value), String> {
    let server_id = server_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "当前 AI-SSH 会话没有可定位的 OpsNest 服务器".to_string())?;
    match kind {
        ToolKind::OpenFileManager => {
            let action = serde_json::json!({
                "type": "open_file_manager",
                "serverId": server_id,
            });
            Ok((
                "opsnest_open_file_manager".to_string(),
                serde_json::to_string(&serde_json::json!({
                    "accepted": true,
                    "action": action,
                }))
                .map_err(|error| error.to_string())?,
                action,
            ))
        }
        ToolKind::OpenFileEditor => {
            let path = arguments
                .get("path")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "opsnest_open_file_editor path is required".to_string())?;
            if path.contains('\0') {
                return Err("opsnest_open_file_editor path is invalid".to_string());
            }
            let placement = match arguments
                .get("placement")
                .and_then(Value::as_str)
                .unwrap_or("right")
            {
                "bottom" => "bottom",
                _ => "right",
            };
            let name = path
                .rsplit(['/', '\\'])
                .next()
                .filter(|value| !value.is_empty())
                .unwrap_or(path);
            let action = serde_json::json!({
                "type": "open_file_editor",
                "serverId": server_id,
                "path": path,
                "name": name,
                "placement": placement,
            });
            Ok((
                "opsnest_open_file_editor".to_string(),
                serde_json::to_string(&serde_json::json!({
                    "accepted": true,
                    "action": action,
                }))
                .map_err(|error| error.to_string())?,
                action,
            ))
        }
        _ => Err("requested tool is not an OpsNest UI tool".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::{cached_service_discovery, is_interactive_agent_command, remember_service_discovery};

    #[test]
    fn service_discovery_cache_marks_recent_result() {
        let session_id = format!(
            "tool-cache-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock should be after unix epoch")
                .as_nanos()
        );
        remember_service_discovery(
            &session_id,
            r#"{"services":[],"truncated":false,"limit":200,"cached":false}"#.to_string(),
        );
        let cached = cached_service_discovery(&session_id).expect("recent result should be cached");
        let payload: serde_json::Value =
            serde_json::from_str(&cached).expect("cached result should remain JSON");
        assert_eq!(payload["cached"], serde_json::Value::Bool(true));
        assert!(payload["cacheAgeMs"].is_number());
    }

    #[test]
    fn one_panel_uninstall_stays_on_native_terminal_path() {
        assert!(is_interactive_agent_command("1pctl uninstall"));
        assert!(is_interactive_agent_command("/usr/local/bin/1pctl remove"));
        assert!(!is_interactive_agent_command("1pctl status"));
    }
}
