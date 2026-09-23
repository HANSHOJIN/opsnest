import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeDebugLog } from "../services/debugLog";
import { providerPresets } from "../features/settings/model-config";

type ModelPreferences = {
  provider: keyof typeof providerPresets | "opencode-go";
  apiMode: "chat-completions" | "responses";
  baseUrl: string;
  apiKey: string;
  model: string;
  contextLength?: number;
};

type OpenCodeGoModel = { id: string; protocol: "chat-completions" | "responses" | "messages" | null };
const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";
const protocolLabel = (protocol: OpenCodeGoModel["protocol"]) => protocol ?? "暂不支持：未知 API 类型";

export function ModelSettingsPanel({ value, onChange }: { value: ModelPreferences; onChange: (next: ModelPreferences) => void }) {
  const [testing, setTesting] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [goModels, setGoModels] = useState<OpenCodeGoModel[]>([]);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const update = <K extends keyof ModelPreferences>(key: K, next: ModelPreferences[K]) => { setSaved(false); onChange({ ...value, [key]: next }); };
  const updateProvider = (provider: ModelPreferences["provider"]) => {
    setSaved(false);
    setModels([]);
    setGoModels([]);
    if (provider === "opencode-go") {
      onChange({ ...value, provider, apiKey: "", baseUrl: OPENCODE_GO_BASE_URL, model: "", apiMode: "chat-completions", contextLength: undefined });
      return;
    }
    const preset = providerPresets[provider];
    onChange({ ...value, provider, apiKey: "", baseUrl: preset.baseUrl, model: preset.model, apiMode: "chat-completions", contextLength: undefined });
  };
  const testConnection = async () => {
    const keyRequired = value.provider === "opencode-go" || providerPresets[value.provider].keyRequired;
    if (keyRequired && !value.apiKey.trim()) { setMessage("请先填写该服务要求的 API Key"); return; }
    setTesting(true);
    setMessage(null);
    void writeDebugLog("info", "model connection test requested", { endpoint: value.baseUrl, model: value.model });
    try {
      const raw = await invoke<string>("test_model_connection", { baseUrl: value.baseUrl, apiKey: value.apiKey, model: value.model, provider: value.provider, apiMode: value.provider === "openai" ? value.apiMode : undefined });
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
    const keyRequired = value.provider === "opencode-go" || providerPresets[value.provider].keyRequired;
    if (keyRequired && !value.apiKey.trim()) { setMessage("请先填写该服务要求的 API Key"); return; }
    setFetching(true);
    setMessage(null);
    void writeDebugLog("info", "model list fetch requested", { endpoint: value.baseUrl });
    try {
      if (value.provider === "opencode-go") {
        const catalog = await invoke<OpenCodeGoModel[]>("fetch_opencode_go_models", { apiKey: value.apiKey });
        setGoModels(catalog);
        const names = catalog.map((item) => item.id);
        setModels(names);
        const firstRoutable = catalog.find((item) => item.protocol)?.id;
        if (!value.model && firstRoutable) update("model", firstRoutable);
        void writeDebugLog("info", "OpenCode Go model list fetch completed", { count: names.length, routable: catalog.filter((item) => item.protocol).length });
        setMessage(`已拉取 ${names.length} 个模型；${catalog.filter((item) => item.protocol).length} 个模型的 API 类型已确认`);
      } else {
        const names = await invoke<string[]>("fetch_model_names", { baseUrl: value.baseUrl, apiKey: value.apiKey });
        setModels(names);
        const preferred = value.provider === "custom" ? "" : providerPresets[value.provider].model;
        const nextModel = names.includes(value.model)
          ? value.model
          : preferred && names.includes(preferred)
            ? preferred
            : value.provider === "custom" && value.model
              ? value.model
              : names[0];
        if (nextModel && nextModel !== value.model) update("model", nextModel);
        void writeDebugLog("info", "model list fetch completed", { endpoint: value.baseUrl, count: names.length });
        setMessage(`已拉取 ${names.length} 个模型`);
      }
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
        <label className="model-field"><span>模型服务</span><select value={value.provider} onChange={(event) => updateProvider(event.target.value as ModelPreferences["provider"])}><option value="custom">Custom endpoint</option><option value="openai">OpenAI</option><option value="deepseek">DeepSeek</option><option value="openrouter">OpenRouter</option><option value="ollama">Ollama</option><option value="opencode-go">OpenCode Go</option></select><small>选择后自动填入推荐 API 地址和默认模型；可按需修改。</small></label>
        <label className="model-field"><span>API 地址</span><input value={value.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} placeholder="https://api.example.com/v1" readOnly={value.provider === "opencode-go"} />{value.provider === "opencode-go" && <small>OpenCode Go 使用固定网关；系统会按模型自动选择 Chat Completions、Responses 或 Messages 接口。</small>}</label>
        {value.provider === "openai" && <label className="model-field"><span>API 模式</span><select value={value.apiMode} onChange={(event) => update("apiMode", event.target.value as ModelPreferences["apiMode"])}><option value="chat-completions">Chat Completions</option><option value="responses">Responses</option></select><small>按所选模型支持的 API 模式切换；默认使用 Chat Completions。</small></label>}
        <label className="model-field"><span>API Key{value.provider === "ollama" ? "（本地可留空）" : value.provider === "custom" ? "（按端点要求填写）" : ""}</span><input type="password" value={value.apiKey} onChange={(event) => update("apiKey", event.target.value)} placeholder={value.provider === "ollama" ? "本地 Ollama 可留空；云端请输入 API Key" : value.provider === "custom" ? "端点需要认证时填写" : "输入 API Key"} /></label>
        {value.provider === "opencode-go" && <p className="settings-intro">OpenCode Go 要求稳定的会话标识和客户端 User-Agent；OpsNest 会自动附加。连接测试会额外验证工具调用格式，只发起一次模型请求，不会执行服务器操作。</p>}
        {value.provider !== "opencode-go" && <p className="settings-intro">连接测试会验证模型是否能返回工具调用格式；仅发送一次模型请求，不会执行服务器操作。</p>}
        <label className="model-field"><span>模型名称（暂不支持添加多个模型）</span><div className="model-name-row"><input value={value.model} onChange={(event) => update("model", event.target.value)} placeholder={value.provider === "opencode-go" ? "先拉取模型，再选择" : "例如：gpt-4o-mini"} />{models.length > 0 && <select value={models.includes(value.model) ? value.model : ""} onChange={(event) => update("model", event.target.value)} aria-label="选择已拉取的模型"><option value="">选择模型</option>{models.map((name) => { const info = goModels.find((item) => item.id === name); return <option value={name} key={name} disabled={Boolean(info && !info.protocol)}>{info ? `${name} · ${protocolLabel(info.protocol)}` : name}</option>; })}</select>}</div></label>
        {models.length > 0 && <div className="model-picker"><button className="model-picker-trigger" type="button" onClick={() => setModelMenuOpen((open) => !open)} aria-expanded={modelMenuOpen}>{value.model || "选择模型"}<span>⌄</span></button>{modelMenuOpen && <div className="model-picker-menu" role="listbox">{models.map((name) => { const info = goModels.find((item) => item.id === name); const unsupported = Boolean(info && !info.protocol); return <button type="button" role="option" aria-selected={value.model === name} key={name} disabled={unsupported} onClick={() => { update("model", name); setModelMenuOpen(false); }}>{name}{info && <small>{protocolLabel(info.protocol)}</small>}</button>; })}</div>}</div>}
        {message && <p className={"model-test-message " + ((message.includes("Connection successful") || saved) ? "is-success" : "is-error")}>{message}</p>}
        <div className="model-actions"><button className="secondary" type="button" onClick={() => void fetchModels()} disabled={fetching}>{fetching ? "拉取中…" : "拉取模型名称"}</button><button className="secondary" type="button" onClick={() => void testConnection()} disabled={testing}>{testing ? "测试中…" : "测试连接与工具"}</button><button className="primary" type="button">保存模型</button></div>
      </section>
    </div>
  );
}
