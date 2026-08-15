import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeDebugLog } from "../services/debugLog";

type ModelPreferences = {
  provider: "custom" | "openai" | "deepseek" | "ollama";
  baseUrl: string;
  apiKey: string;
  model: string;
  contextLength?: number;
};

export function ModelSettingsPanel({ value, onChange }: { value: ModelPreferences; onChange: (next: ModelPreferences) => void }) {
  const [testing, setTesting] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const update = <K extends keyof ModelPreferences>(key: K, next: ModelPreferences[K]) => { setSaved(false); onChange({ ...value, [key]: next }); };
  const testConnection = async () => {
    setTesting(true);
    setMessage(null);
    void writeDebugLog("info", "model connection test requested", { endpoint: value.baseUrl, model: value.model });
    try {
      const raw = await invoke<string>("test_model_connection", { baseUrl: value.baseUrl, apiKey: value.apiKey, model: value.model });
      let result: { message?: string; contextLength?: number | null } | null = null;
      try { result = JSON.parse(raw) as { message?: string; contextLength?: number | null }; } catch { /* legacy backend response */ }
      const messageText = result?.message ?? raw;
      const contextLength = result?.contextLength;
      if (typeof contextLength === "number" && Number.isFinite(contextLength) && contextLength > 0) {
        onChange({ ...value, contextLength: Math.floor(contextLength) });
        setMessage(`${messageText} · 上下文约 ${Math.round(contextLength / 1000)}K tokens`);
      } else {
        setMessage(`${messageText} · 未返回上下文长度，将使用回退值`);
      }
      void writeDebugLog("info", "model connection test completed", { endpoint: value.baseUrl, model: value.model, contextLength: contextLength ?? null });
    } catch (error) {
      setMessage(String(error));
      void writeDebugLog("error", "model connection test failed", { endpoint: value.baseUrl, model: value.model, error: String(error) });
    } finally {
      setTesting(false);
    }
  };
  const fetchModels = async () => {
    setFetching(true);
    setMessage(null);
    void writeDebugLog("info", "model list fetch requested", { endpoint: value.baseUrl });
    try {
      const names = await invoke<string[]>("fetch_model_names", { baseUrl: value.baseUrl, apiKey: value.apiKey });
      setModels(names);
      if (!value.model && names[0]) update("model", names[0]);
      void writeDebugLog("info", "model list fetch completed", { endpoint: value.baseUrl, count: names.length });
      setMessage(`已拉取 ${names.length} 个模型`);
    } catch (error) {
      setMessage(String(error));
      void writeDebugLog("error", "model list fetch failed", { endpoint: value.baseUrl, error: String(error) });
    } finally {
      setFetching(false);
    }
  };

  return (
    <div className="settings-page">
      <div className="settings-page-header"><div><div className="settings-eyebrow">设置</div><h1>AI 模型</h1></div></div>
      <section className="settings-section settings-card model-settings-card" onClick={(event) => { if ((event.target as HTMLElement).classList.contains("primary")) { setSaved(true); setMessage("模型设置已保存"); } }}>
        <div className="settings-card-title"><strong>添加一个 AI 模型</strong></div>
        <p className="settings-intro">模型只负责理解你的描述和服务器状态，SSH 操作仍由本地安全流程控制。</p>
        <label className="model-field"><span>模型服务</span><select value={value.provider} onChange={(event) => update("provider", event.target.value as ModelPreferences["provider"])}><option value="custom">Custom endpoint</option><option value="openai">OpenAI</option><option value="deepseek">DeepSeek</option><option value="ollama">Ollama</option></select></label>
        <label className="model-field"><span>API 地址</span><input value={value.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} placeholder="https://api.example.com/v1" /></label>
        <label className="model-field"><span>API Key</span><input type="password" value={value.apiKey} onChange={(event) => update("apiKey", event.target.value)} placeholder="输入 API Key" /></label>
        <label className="model-field"><span>模型名称（暂不支持添加多个模型）</span><div className="model-name-row"><input value={value.model} onChange={(event) => update("model", event.target.value)} placeholder="例如：gpt-4o-mini" />{models.length > 0 && <select value={models.includes(value.model) ? value.model : ""} onChange={(event) => update("model", event.target.value)} aria-label="选择已拉取的模型"><option value="">选择模型</option>{models.map((name) => <option value={name} key={name}>{name}</option>)}</select>}</div></label>
        {models.length > 0 && <div className="model-picker"><button className="model-picker-trigger" type="button" onClick={() => setModelMenuOpen((open) => !open)} aria-expanded={modelMenuOpen}>{value.model || "选择模型"}<span>⌄</span></button>{modelMenuOpen && <div className="model-picker-menu" role="listbox">{models.map((name) => <button type="button" role="option" aria-selected={value.model === name} key={name} onClick={() => { update("model", name); setModelMenuOpen(false); }}>{name}</button>)}</div>}</div>}
        {message && <p className={"model-test-message " + ((message.includes("Connection successful") || saved) ? "is-success" : "is-error")}>{message}</p>}
        <div className="model-actions"><button className="secondary" type="button" onClick={() => void fetchModels()} disabled={fetching}>{fetching ? "拉取中…" : "拉取模型名称"}</button><button className="secondary" type="button" onClick={() => void testConnection()} disabled={testing}>{testing ? "测试中…" : "测试连接"}</button><button className="primary" type="button">保存模型</button></div>
      </section>
    </div>
  );
}
