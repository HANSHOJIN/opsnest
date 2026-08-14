use crate::ssh_session;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
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
    pub session_id: String,
    pub prompt: String,
    pub approved: bool,
    pub context: Option<String>,
    /// Kept outside model messages. This is read from the local system
    /// credential store only when the user configured optional sudo access.
    pub sudo_password: Option<String>,
    /// Set when the user has approved a previously proposed command. The
    /// backend executes this exact command once, then asks the model to
    /// interpret the real terminal result instead of starting a second plan.
    pub approved_command: Option<String>,
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
                    value.contains("[command_error]")
                        || value.contains("__OPSNEST_COMMAND_ERROR__")
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

async fn post_chat(
    base_url: &str,
    api_key: &str,
    body: Value,
    timeout: Duration,
    mut cancel: Option<&mut oneshot::Receiver<()>>,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|error| error.to_string())?;
    let mut call = client
        .post(format!(
            "{}/chat/completions",
            base_url.trim().trim_end_matches('/')
        ))
        .json(&body);
    if !api_key.trim().is_empty() {
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
    Ok(raw)
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
    let raw = post_chat(&request.base_url, &request.api_key, serde_json::json!({ "model": request.model.trim(), "temperature": 0.2, "messages": messages }), Duration::from_secs(90), None).await?;
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
        &request.base_url,
        &request.api_key,
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
    let board_context = ssh_session::session_context(&request.session_id, 12000);
    let conversation_history = ssh_session::conversation_history(&request.session_id, 12000);
    let _ = ssh_session::record_session_event(
        &request.session_id,
        "user_message",
        request.prompt.clone(),
    );
    let tools = serde_json::json!([{"type":"function","function":{"name":"run_command","description":"Plan one concrete command on the connected server. Include a verification command when the result can be checked safely.","parameters":{"type":"object","properties":{"command":{"type":"string"},"verify_command":{"type":"string"},"explain":{"type":"string"},"risk":{"type":"string","enum":["low","medium","high"]}},"required":["command","explain","risk"]}}}]);
    let context = request
        .context
        .unwrap_or_else(|| "当前服务器上下文未提供。".to_string());
    let system = format!("你是 OpsNest AI-SSH，负责当前服务器的真实终端协作。\n当前上下文：{context}\n解释意图时简洁自然；只有用户明确要求执行、检查或修改时才调用 run_command。普通聊天、感谢、确认和追问都交给模型自然回答，不使用固定关键词分流。没有工具结果时不得声称命令已经执行。命令执行后必须根据真实工具输出继续判断。回答长度规则：默认先给结论，控制在 3-6 行或不超过 5 个要点；成功执行后只报告结果、异常和必要的下一步，不复述原始终端输出，不写背景教程、长篇风险清单或多个备选方案。只有用户明确要求详细解释、教程或完整排障步骤时才展开。");
    let system = format!("{system}\n共享终端黑板（最近事件）：\n{board_context}\n");
    // The PTY output is already visible in the xterm surface. Keep replies
    // focused on interpretation and next steps instead of copying a full
    // directory listing or command transcript into the green AI channel.
    let system = format!(
        "{system}\nTerminal output is visible to the user in real time. Do not repeat raw command output, file listings, prompts, or banners unless the user explicitly asks for a quotation. If a read-only tool result already answers the request (for example ls, pwd, df, or system status), return no summary text; only report errors, anomalies, or an actionable conclusion."
    );
    let system = if request.sudo_password.as_deref().is_some_and(|value| !value.is_empty()) {
        format!(
            "{system}\nThis server has a locally configured sudo credential. When elevation is genuinely required, use a command beginning with `sudo `. The credential is supplied locally after approval; never request, print, or transmit it."
        )
    } else {
        system
    };
    let mut messages = vec![
        serde_json::json!({"role":"system","content":system}),
    ];
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
    if let Some(command) = approved_followup.as_deref() {
        let (output, terminal_marker) = match ssh_session::run_interactive_command_with_marker(
            &request.session_id,
            command,
            true,
            request.sudo_password.as_deref(),
        )
        .await
        {
            Ok(value) => (value.output, Some(value.terminal_marker)),
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
    for _round in 0..8 {
        let tool_choice = if approved_followup.is_some() { "none" } else { "auto" };
        let raw = match post_chat(&request.base_url, &request.api_key, serde_json::json!({"model":request.model.trim(),"temperature":0.1,"messages":messages,"tools":tools,"tool_choice":tool_choice}), Duration::from_secs(60), Some(&mut cancel_receiver)).await {
            Ok(raw) => raw,
            Err(error) if error == "AI-SSH request cancelled" => {
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
                return Ok(serde_json::json!({
                    "status": "error",
                    "content": format!("AI 请求失败，重试后仍未恢复：{error}"),
                    "executed": executed
                })
                .to_string());
            }
            Err(error) => return Err(format!("AI 请求失败，重试后仍未恢复：{error}")),
        };
        let payload: Value =
            serde_json::from_str(&raw).map_err(|error| format!("Invalid AI response: {error}"))?;
        let choice = payload
            .get("choices")
            .and_then(|items| items.get(0))
            .ok_or_else(|| "AI response did not contain choices".to_string())?;
        let message = choice.get("message").cloned().unwrap_or_default();
        if let Some(call) = message.get("tool_calls").and_then(|calls| calls.get(0)) {
            let arguments = call
                .get("function")
                .and_then(|function| function.get("arguments"))
                .and_then(Value::as_str)
                .and_then(|value| serde_json::from_str::<Value>(value).ok())
                .unwrap_or_default();
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
                return Err("AI requested an invalid command".into());
            }
            if !approved_for_this_turn && command_requires_approval(&command, &risk) {
                return Ok(serde_json::json!({"status":"approval_required","command":command,"verifyCommand":verify_command,"explain":explain,"risk":risk,"executed":executed}).to_string());
            }
            let execution =
                match ssh_session::run_interactive_command_with_marker(
                    &request.session_id,
                    &command,
                    true,
                    request.sudo_password.as_deref(),
                )
                    .await
                {
                    Ok(value) => value,
                    Err(error) => ssh_session::InteractiveCommandResult {
                        output: format!("__OPSNEST_COMMAND_ERROR__{error}"),
                        terminal_marker: String::new(),
                    },
                };
            let output = execution.output;
            let terminal_marker = execution.terminal_marker;
            if output.contains("[command_error]")
                || output.contains("__OPSNEST_COMMAND_ERROR__")
            {
                recovery_attempts = recovery_attempts.saturating_add(1);
                let _ = ssh_session::record_session_event(
                    &request.session_id,
                    "ai_recovery",
                    format!("命令执行失败，已把错误返回给模型继续恢复：{}", output),
                );
            }
            let (verification, verification_marker) = if verify_command.is_empty() || verify_command == command {
                (None, None)
            } else {
                let verification_execution =
                    match ssh_session::run_interactive_command_with_marker(
                        &request.session_id,
                        &verify_command,
                        true,
                        request.sudo_password.as_deref(),
                    )
                    .await
                    {
                        Ok(value) => value,
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
            let tool_call_id = call
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("opsnest-call")
                .to_string();
            messages.push(message);
            let tool_content = verification
                .as_ref()
                .map(|value| format!("{output}\n\n[verification]\n{value}"))
                .unwrap_or(output);
            messages.push(serde_json::json!({"role":"tool","tool_call_id":tool_call_id,"content":tool_content}));
            approved_for_this_turn = false;
            continue;
        }
        let content = message.get("content").and_then(Value::as_str).unwrap_or("");
        let _ = ssh_session::record_session_event(
            &request.session_id,
            "ai_message",
            content.to_string(),
        );
        let summary = summarize_execution(&executed);
        return Ok(serde_json::json!({"status":if executed.is_empty() { "answer" } else { "executed" },"content":content,"summary":summary,"recoveryAttempts":recovery_attempts,"executed":executed}).to_string());
    }
    if recovery_attempts > 0 {
        let summary = summarize_execution(&executed);
        return Ok(serde_json::json!({"status":"recovery_required","content":"本轮达到最大恢复步数，已停止继续执行。请查看摘要后决定是否继续。","summary":summary,"recoveryAttempts":recovery_attempts,"executed":executed}).to_string());
    }
    Ok(serde_json::json!({"status":"executed","content":"达到本轮 AI-SSH 最大步骤数，请确认后继续。","executed":executed}).to_string())
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
        "sudo ", "rm ", "mv ", "cp ", "chmod ", "chown ", "systemctl start",
        "systemctl stop", "systemctl restart", "systemctl enable", "systemctl disable",
        "systemctl mask", "systemctl unmask", "systemctl reload", "service start",
        "service stop", "service restart", "reboot", "shutdown", "docker rm", "docker stop",
        "docker restart", "apt install", "apt remove", "apt purge", "apt upgrade",
        "dnf install", "yum install", "apk add", "pacman -s", "mkfs", "dd ",
    ]
    .iter().any(|token| lowered.contains(token))
        || (declared_risk.eq_ignore_ascii_case("high") && !is_read_only_command(&lowered))
}

fn is_read_only_command(command: &str) -> bool {
    let read_only = [
        "which ", "command -v ", "type ", "ls", "stat ", "cat ", "head ", "tail ",
        "grep ", "egrep ", "fgrep ", "awk ", "sed -n", "find ", "ps", "top", "free",
        "df", "du ", "uname", "id", "whoami", "hostname", "uptime", "env", "printenv",
        "systemctl status", "systemctl is-active", "systemctl list-units", "service --status-all",
        "docker ps", "docker inspect", "docker version", "docker info", "ss ", "netstat ",
        "ip ", "curl -i", "curl -I", "wget --spider",
    ];
    command.split(|ch| ch == '&' || ch == '|' || ch == ';')
        .map(str::trim).filter(|part| !part.is_empty())
        .all(|part| read_only.iter().any(|prefix| part.starts_with(prefix)))
}
