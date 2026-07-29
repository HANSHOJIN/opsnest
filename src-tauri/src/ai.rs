use serde::{Deserialize, Serialize};
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

#[derive(Debug, Serialize)]
struct ChatMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[tauri::command]
pub async fn chat_completion(request: AiChatRequest) -> Result<String, String> {
    let base_url = request.base_url.trim().trim_end_matches('/');
    if base_url.is_empty() {
        return Err("AI base URL is empty".to_string());
    }
    if request.model.trim().is_empty() {
        return Err("AI model is empty".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|error| error.to_string())?;
    let url = format!("{base_url}/chat/completions");
    let body = serde_json::json!({
        "model": request.model.trim(),
        "temperature": 0.2,
        "messages": [
            ChatMessage { role: "system", content: &request.system },
            ChatMessage { role: "user", content: &request.prompt }
        ]
    });
    let mut call = client.post(url).json(&body);
    if !request.api_key.trim().is_empty() {
        call = call.bearer_auth(request.api_key.trim());
    }
    let response = call.send().await.map_err(|error| error.to_string())?;
    let status = response.status();
    let raw = response.text().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(format!(
            "{} {}",
            status.as_u16(),
            raw.chars().take(400).collect::<String>()
        ));
    }
    let payload: Value =
        serde_json::from_str(&raw).map_err(|error| format!("Invalid AI response: {error}"))?;
    payload
        .get("choices")
        .and_then(|choices| choices.get(0))
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .filter(|content| !content.trim().is_empty())
        .ok_or_else(|| "AI response did not contain choices[0].message.content".to_string())
}

/// Sends an OpenAI-compatible Chat Completions request with function tools and
/// returns the provider response unchanged. The Agent runtime owns tool
/// execution; this command only transports structured tool calls.
#[tauri::command]
pub async fn chat_completion_with_tools(request: AiToolChatRequest) -> Result<String, String> {
    let base_url = request.base_url.trim().trim_end_matches('/');
    if base_url.is_empty() {
        return Err("AI base URL is empty".to_string());
    }
    if request.model.trim().is_empty() {
        return Err("AI model is empty".to_string());
    }
    if request.messages.is_empty() {
        return Err("AI messages are empty".to_string());
    }
    if request.tools.is_empty() {
        return Err("AI tools are empty".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|error| error.to_string())?;
    let mut body = serde_json::json!({
        "model": request.model.trim(),
        "temperature": 0.2,
        "messages": request.messages,
        "tools": request.tools,
    });
    if let Some(tool_choice) = request.tool_choice {
        body["tool_choice"] = tool_choice;
    }
    let url = format!("{base_url}/chat/completions");
    let mut call = client.post(url).json(&body);
    if !request.api_key.trim().is_empty() {
        call = call.bearer_auth(request.api_key.trim());
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
    serde_json::from_str::<Value>(&raw)
        .map_err(|error| format!("Invalid AI tool response: {error}"))?;
    Ok(raw)
}
