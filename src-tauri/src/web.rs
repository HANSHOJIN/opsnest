use reqwest::header::{HeaderMap, HeaderValue, USER_AGENT};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchRequest {
    pub query: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

fn collect_topics(value: &Value, results: &mut Vec<WebSearchResult>) {
    let Some(topics) = value.as_array() else { return };
    for topic in topics {
        if let Some(text) = topic.get("Text").and_then(Value::as_str) {
            let first = text.split(" - ").next().unwrap_or(text).trim();
            results.push(WebSearchResult {
                title: first.to_string(),
                url: topic.get("FirstURL").and_then(Value::as_str).unwrap_or_default().to_string(),
                snippet: text.to_string(),
            });
        }
        if let Some(nested) = topic.get("Topics") { collect_topics(nested, results); }
        if results.len() >= 5 { return; }
    }
}

#[tauri::command]
pub async fn search_web(request: WebSearchRequest) -> Result<Vec<WebSearchResult>, String> {
    let query = request.query.trim();
    if query.is_empty() { return Err("搜索内容为空。".to_string()); }
    if query.len() > 500 { return Err("搜索内容过长。".to_string()); }

    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static("OpsNest/0.1 local agent"));
    let client = reqwest::Client::builder()
        .default_headers(headers)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| error.to_string())?;
    let url = format!("https://api.duckduckgo.com/?q={}&format=json&no_html=1&skip_disambig=1", urlencoding::encode(query));
    let payload: Value = client.get(url).send().await.map_err(|error| error.to_string())?.json().await.map_err(|error| error.to_string())?;
    let mut results = Vec::new();
    if let Some(abstract_text) = payload.get("AbstractText").and_then(Value::as_str).filter(|value| !value.trim().is_empty()) {
        results.push(WebSearchResult {
            title: payload.get("Heading").and_then(Value::as_str).unwrap_or("Reference").to_string(),
            url: payload.get("AbstractURL").and_then(Value::as_str).unwrap_or_default().to_string(),
            snippet: abstract_text.to_string(),
        });
    }
    if let Some(topics) = payload.get("RelatedTopics") { collect_topics(topics, &mut results); }
    Ok(results.into_iter().take(5).collect())
}
