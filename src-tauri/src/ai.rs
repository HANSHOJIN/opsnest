use crate::ssh_session;
use serde::Deserialize;
use serde_json::Value;
use std::time::Duration;

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
}

async fn post_chat(
    base_url: &str,
    api_key: &str,
    body: Value,
    timeout: Duration,
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
    let response = call.send().await.map_err(|error| error.to_string())?;
    let status = response.status();
    let raw = response.text().await.map_err(|error| error.to_string())?;
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
    let raw = post_chat(&request.base_url, &request.api_key, serde_json::json!({ "model": request.model.trim(), "temperature": 0.2, "messages": messages }), Duration::from_secs(90)).await?;
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
    let board_context = ssh_session::session_context(&request.session_id, 12000);
    let _ = ssh_session::record_session_event(
        &request.session_id,
        "user_message",
        request.prompt.clone(),
    );
    let tools = serde_json::json!([{"type":"function","function":{"name":"run_command","description":"Plan one concrete command on the connected server. Include a verification command when the result can be checked safely.","parameters":{"type":"object","properties":{"command":{"type":"string"},"verify_command":{"type":"string"},"explain":{"type":"string"},"risk":{"type":"string","enum":["low","medium","high"]}},"required":["command","explain","risk"]}}}]);
    let context = request
        .context
        .unwrap_or_else(|| "当前服务器上下文未提供。".to_string());
    let system = format!("你是 OpsNest AI-SSH，负责当前服务器的真实终端协作。\n当前上下文：{context}\n解释意图时简洁自然；只有用户明确要求执行、检查或修改时才调用 run_command。普通聊天、感谢、确认和追问都交给模型自然回答，不使用固定关键词分流。没有工具结果时不得声称命令已经执行。命令执行后必须根据真实工具输出继续判断。");
    let system = format!("{system}\n共享终端黑板（最近事件）：\n{board_context}\n");
    let mut messages = vec![
        serde_json::json!({"role":"system","content":system}),
        serde_json::json!({"role":"user","content":request.prompt}),
    ];
    let mut approved_for_this_turn = request.approved;
    let mut executed = Vec::new();
    for _round in 0..8 {
        let raw = post_chat(&request.base_url, &request.api_key, serde_json::json!({"model":request.model.trim(),"temperature":0.1,"messages":messages,"tools":tools,"tool_choice":"auto"}), Duration::from_secs(120)).await?;
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
            if !approved_for_this_turn {
                return Ok(serde_json::json!({"status":"approval_required","command":command,"verifyCommand":verify_command,"explain":explain,"risk":risk,"executed":executed}).to_string());
            }
            let output =
                match ssh_session::run_interactive_command(&request.session_id, &command, true)
                    .await
                {
                    Ok(value) => value,
                    Err(error) => format!("[command_error] {error}"),
                };
            let verification = if verify_command.is_empty() {
                None
            } else {
                Some(
                    match ssh_session::run_interactive_command(
                        &request.session_id,
                        &verify_command,
                        true,
                    )
                    .await
                    {
                        Ok(value) => value,
                        Err(error) => format!("[verification_error] {error}"),
                    },
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
            executed.push(
                serde_json::json!({"command":command,"output":output,"verification":verification}),
            );
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
        return Ok(serde_json::json!({"status":if executed.is_empty() { "answer" } else { "executed" },"content":content,"executed":executed}).to_string());
    }
    Ok(serde_json::json!({"status":"executed","content":"达到本轮 AI-SSH 最大步骤数，请确认后继续。","executed":executed}).to_string())
}
