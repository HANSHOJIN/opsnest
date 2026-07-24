import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import "./styles.css";

type AuthMethod = "password" | "privateKey";
type ServerStatus = "connected" | "saved";
type View = "hosts" | "settings";
type AiProvider = "openai" | "deepseek" | "openrouter" | "ollama" | "custom";

type ServerProfile = {
  osName: string;
  hostname: string;
  cpuCores: string;
  memory: string;
  disk: string;
  dockerInstalled: boolean;
  dockerContainers: string;
};

type Server = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  system: string;
  status: ServerStatus;
  profile?: ServerProfile;
  aiSummary?: string;
};

type ServerForm = {
  name: string;
  host: string;
  port: string;
  username: string;
  authMethod: AuthMethod;
  password: string;
  privateKeyPath: string;
  passphrase: string;
};

type SshRequest = {
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  password: string | null;
  privateKeyPath: string | null;
  passphrase: string | null;
};

type AiConfig = {
  provider: AiProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
};

type PersistedData = {
  servers?: Server[];
  aiConfig?: Partial<AiConfig> | null;
};

const STORAGE_KEY = "opsnest.servers";
const AI_STORAGE_KEY = "opsnest.ai-model";
const initialForm: ServerForm = { name: "", host: "", port: "22", username: "root", authMethod: "password", password: "", privateKeyPath: "", passphrase: "" };
const defaultAiConfig: AiConfig = { provider: "deepseek", apiKey: "", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" };
const providerPresets: Record<AiProvider, { label: string; baseUrl: string; model: string; keyRequired: boolean }> = {
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", keyRequired: true },
  deepseek: { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", keyRequired: true },
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini", keyRequired: true },
  ollama: { label: "Ollama（本地）", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:7b", keyRequired: false },
  custom: { label: "自定义接口", baseUrl: "", model: "", keyRequired: true },
};

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

async function listModels(config: AiConfig) {
  const response = await fetch(`${normalizeBaseUrl(config.baseUrl)}/models`, {
    headers: config.apiKey.trim() ? { Authorization: `Bearer ${config.apiKey.trim()}` } : {},
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`${response.status} ${detail.slice(0, 180)}`);
  }
  const payload = await response.json() as { data?: Array<{ id?: string }> };
  return (payload.data ?? []).map((item) => item.id).filter((item): item is string => Boolean(item));
}

async function askModel(config: AiConfig, prompt: string) {
  const response = await fetch(`${normalizeBaseUrl(config.baseUrl)}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(config.apiKey.trim() ? { Authorization: `Bearer ${config.apiKey.trim()}` } : {}) },
    body: JSON.stringify({ model: config.model.trim(), temperature: 0.2, messages: [
      { role: "system", content: "你是 OpsNest 的服务器助手。请用简洁、易懂的中文解释服务器状态，不要编造没有提供的信息。当前只能分析和建议，不要假设已经执行了任何操作。" },
      { role: "user", content: prompt },
    ] }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`${response.status} ${detail.slice(0, 220)}`);
  }
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return payload.choices?.[0]?.message?.content?.trim() || "模型没有返回可显示的内容。";
}

function App() {
  const [view, setView] = useState<View>("hosts");
  const [servers, setServers] = useState<Server[]>([]);
  const [server, setServer] = useState<Server | null>(null);
  const [form, setForm] = useState<ServerForm>(initialForm);
  const [aiConfig, setAiConfig] = useState<AiConfig>(defaultAiConfig);
  const [isWizardOpen, setWizardOpen] = useState(false);
  const [isConnecting, setConnecting] = useState(false);
  const [isScanning, setScanning] = useState(false);
  const [isAnalyzing, setAnalyzing] = useState(false);
  const [isTestingModel, setTestingModel] = useState(false);
  const [modelStatus, setModelStatus] = useState("");
  const [error, setError] = useState("");
  const activeCredentials = useRef<Record<string, SshRequest>>({});

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const stored = await invoke<PersistedData>("load_local_data");
        const legacyServers = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as Server[];
        const legacyAi = JSON.parse(localStorage.getItem(AI_STORAGE_KEY) ?? "null") as Partial<AiConfig> | null;
        const saved = stored.servers?.length ? stored.servers : legacyServers;
        const savedAi = stored.aiConfig ?? legacyAi;
        if (cancelled) return;
        const restored = saved.map((item) => ({ ...item, status: "saved" as ServerStatus }));
        setServers(restored);
        if (restored[0]) setServer(restored[0]);
        if (savedAi) setAiConfig({ ...defaultAiConfig, ...savedAi });
        if ((!stored.servers?.length && legacyServers.length) || (!stored.aiConfig && legacyAi)) {
          await invoke("save_local_data", { data: { servers: legacyServers, aiConfig: savedAi } });
        }
      } catch {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as Server[];
        const savedAi = JSON.parse(localStorage.getItem(AI_STORAGE_KEY) ?? "null") as Partial<AiConfig> | null;
        if (cancelled) return;
        const restored = saved.map((item) => ({ ...item, status: "saved" as ServerStatus }));
        setServers(restored);
        if (restored[0]) setServer(restored[0]);
        if (savedAi) setAiConfig({ ...defaultAiConfig, ...savedAi });
      }
    };
    void load();
    return () => { cancelled = true; };
  }, []);

  const persistData = (nextServers: Server[], nextAiConfig: AiConfig = aiConfig) => {
    const data = { servers: nextServers.map(({ status: _status, ...item }) => item), aiConfig: nextAiConfig };
    void invoke("save_local_data", { data }).catch(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data.servers));
      localStorage.setItem(AI_STORAGE_KEY, JSON.stringify(nextAiConfig));
    });
  };
  const persistServers = (next: Server[]) => {
    setServers(next);
    persistData(next);
  };
  const update = <K extends keyof ServerForm>(key: K, value: ServerForm[K]) => { setForm((current) => ({ ...current, [key]: value })); setError(""); };
  const updateAi = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => { setAiConfig((current) => ({ ...current, [key]: value })); setModelStatus(""); setError(""); };
  const openWizard = () => { setForm(initialForm); setError(""); setWizardOpen(true); };
  const requestForForm = (): SshRequest => ({ host: form.host.trim(), port: Number(form.port), username: form.username.trim(), authMethod: form.authMethod, password: form.authMethod === "password" ? form.password : null, privateKeyPath: form.authMethod === "privateKey" ? form.privateKeyPath.trim() : null, passphrase: form.passphrase || null });

  const connect = async () => {
    if (!form.host.trim()) return setError("请输入服务器地址。");
    if (!form.username.trim()) return setError("请输入用户名。");
    if (!/^[1-9]\d{0,4}$/.test(form.port) || Number(form.port) > 65535) return setError("端口号需要是 1 到 65535 之间的数字。");
    if (form.authMethod === "password" && !form.password) return setError("请输入密码。");
    if (form.authMethod === "privateKey" && !form.privateKeyPath.trim()) return setError("请输入私钥文件路径。");
    setConnecting(true); setError("");
    try {
      const request = requestForForm();
      const result = await invoke<{ system: string }>("test_ssh_connection", { request });
      const nextServer: Server = { id: `${form.host.trim()}:${Number(form.port)}`, name: form.name.trim() || form.host.trim(), host: form.host.trim(), port: Number(form.port), username: form.username.trim(), system: result.system, status: "connected" };
      activeCredentials.current[nextServer.id] = request;
      const next = [nextServer, ...servers.filter((item) => item.id !== nextServer.id)];
      persistServers(next); setServer(nextServer); setWizardOpen(false); setView("hosts");
    } catch (connectionError) { setError(connectionError instanceof Error ? connectionError.message : typeof connectionError === "string" ? connectionError : "连接失败，请检查地址、端口和登录方式。"); }
    finally { setConnecting(false); }
  };

  const scanServer = async () => {
    if (!server || server.status !== "connected") { setError("请重新连接服务器后再进行扫描。"); return; }
    const request = activeCredentials.current[server.id];
    if (!request) { setError("当前会话没有保存登录凭据，请重新连接服务器。"); return; }
    setScanning(true); setError("");
    try {
      const profile = await invoke<ServerProfile>("inspect_server", { request });
      const updated = { ...server, profile, aiSummary: undefined };
      setServer(updated); persistServers([updated, ...servers.filter((item) => item.id !== updated.id)]);
    } catch (scanError) { setError(scanError instanceof Error ? scanError.message : typeof scanError === "string" ? scanError : "扫描失败，请重新连接服务器后再试。"); }
    finally { setScanning(false); }
  };

  const analyzeServer = async () => {
    if (!server?.profile) return;
    if (!aiConfig.baseUrl.trim() || !aiConfig.model.trim() || (providerPresets[aiConfig.provider].keyRequired && !aiConfig.apiKey.trim())) {
      setView("settings"); setError("请先在设置中完成 AI 模型配置。"); return;
    }
    setAnalyzing(true); setError("");
    try {
      const profile = server.profile;
      const summary = await askModel(aiConfig, `请分析这台服务器的只读信息，并给出新手能看懂的简短结论。请按“当前状态、值得注意的地方、下一步建议”三段回答。\n\n服务器名称：${server.name}\n系统：${profile.osName}\n主机名：${profile.hostname}\nCPU：${profile.cpuCores} 核\n内存：${profile.memory}\n磁盘：${profile.disk}\nDocker：${profile.dockerInstalled ? `已安装，${profile.dockerContainers} 个容器运行中` : "未安装"}`);
      const updated = { ...server, aiSummary: summary };
      setServer(updated); persistServers([updated, ...servers.filter((item) => item.id !== updated.id)]);
    } catch (analysisError) { setError(analysisError instanceof Error ? `AI 调用失败：${analysisError.message}` : "AI 调用失败，请检查模型设置。"); }
    finally { setAnalyzing(false); }
  };

  const saveAiConfig = () => {
    if (!aiConfig.baseUrl.trim()) return setError("请输入 API 地址。");
    if (!aiConfig.model.trim()) return setError("请输入模型名称。");
    if (providerPresets[aiConfig.provider].keyRequired && !aiConfig.apiKey.trim()) return setError("请输入 API Key。");
    const next = { ...aiConfig, baseUrl: normalizeBaseUrl(aiConfig.baseUrl), model: aiConfig.model.trim() };
    setAiConfig(next); persistData(servers, next); setModelStatus("已保存到本机"); setError("");
  };

  const testAiConfig = async () => {
    if (!aiConfig.baseUrl.trim()) return setError("请输入 API 地址。");
    if (providerPresets[aiConfig.provider].keyRequired && !aiConfig.apiKey.trim()) return setError("请输入 API Key。");
    setTestingModel(true); setModelStatus(""); setError("");
    try {
      const models = await listModels(aiConfig);
      if (models.length > 0 && !aiConfig.model.trim()) setAiConfig((current) => ({ ...current, model: models[0] }));
      setModelStatus(models.length > 0 ? `连接成功，发现 ${models.length} 个模型` : "连接成功，可以手动填写模型名称");
    } catch (modelError) { setError(modelError instanceof Error ? `模型连接失败：${modelError.message}` : "模型连接失败，请检查地址和 Key。"); }
    finally { setTestingModel(false); }
  };

  const selectProvider = (provider: AiProvider) => {
    const preset = providerPresets[provider];
    setAiConfig((current) => ({ ...current, provider, baseUrl: preset.baseUrl, model: preset.model }));
    setModelStatus(""); setError("");
  };
  const selectServer = (selected: Server) => { setServer(selected); setView("hosts"); setError(""); };

  return <main className="shell">
    <aside className="sidebar">
      <div className="brand"><img className="brand-icon" src="/opsnest-icon.png" alt="" /><span>OpsNest</span></div>
      <nav aria-label="主导航"><button className={view === "hosts" ? "active" : ""} onClick={() => setView("hosts")}>我的服务器</button><button onClick={() => setError("任务记录将在下一阶段加入。")}>任务记录</button><button className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}>设置</button></nav>
      {servers.length > 0 && <div className="host-list"><p className="nav-caption">服务器</p>{servers.map((item) => <button className={`host-item ${server?.id === item.id ? "selected" : ""}`} key={item.id} onClick={() => selectServer(item)}><span className={`host-dot ${item.status === "connected" ? "online" : ""}`}></span><span className="host-item-text"><strong>{item.name}</strong><small>{item.host}</small></span></button>)}</div>}
      <button className="add-host" onClick={openWizard}>＋ 添加服务器</button>
      <div className="sidebar-note">本地优先<br />凭据只在连接时使用</div>
    </aside>
    <section className="content">
      {view === "settings" ? <section className="settings-view"><header className="topbar"><div><p className="eyebrow">本地配置</p><h1>AI 模型</h1></div><span className="status-pill">● 仅本机使用</span></header><div className="settings-card"><div className="settings-heading"><div><h2>添加一个 AI 模型</h2><p>模型只负责理解你的描述和服务器状态，所有 SSH 操作仍由本地安全流程控制。</p></div><span className="read-only-pill">API 直连</span></div><label className="field-label">模型服务<select value={aiConfig.provider} onChange={(event) => selectProvider(event.target.value as AiProvider)}>{Object.entries(providerPresets).map(([key, preset]) => <option key={key} value={key}>{preset.label}</option>)}</select></label><label className="field-label">API 地址<input value={aiConfig.baseUrl} onChange={(event) => updateAi("baseUrl", event.target.value)} placeholder="https://api.example.com/v1" /></label><label className="field-label">API Key{!providerPresets[aiConfig.provider].keyRequired && <span> 可选</span>}<input type="password" value={aiConfig.apiKey} onChange={(event) => updateAi("apiKey", event.target.value)} placeholder={aiConfig.provider === "ollama" ? "本地 Ollama 不需要 Key" : "输入你的 API Key"} /></label><label className="field-label">模型名称<input value={aiConfig.model} onChange={(event) => updateAi("model", event.target.value)} placeholder="例如：deepseek-chat" /></label><div className="settings-actions"><button className="secondary" onClick={testAiConfig} disabled={isTestingModel}>{isTestingModel ? "正在测试…" : "测试连接"}</button><button className="primary" onClick={saveAiConfig}>保存模型</button></div>{modelStatus && <p className="success-text">✓ {modelStatus}</p>}<p className="settings-note">API Key 目前仅保存在当前电脑的本地配置中，不会上传到 OpsNest。建议使用权限受限、额度可控的 Key。</p></div></section> : <><header className="topbar"><div><p className="eyebrow">欢迎回来</p><h1>我的服务器</h1></div><span className="status-pill">● 本地模式</span></header>{server ? <section className="server-view" id="hosts"><div className="server-card"><div className="server-card-top"><div className="server-orb">⌁</div><span className={`connected-badge ${server.status === "saved" ? "saved-badge" : ""}`}>● {server.status === "connected" ? "已连接" : "已保存"}</span></div><h2>{server.name}</h2><p className="server-address">{server.username}@{server.host}:{server.port}</p><div className="server-meta"><div><span>系统</span><strong>{server.profile?.osName ?? server.system}</strong></div><div><span>连接方式</span><strong>SSH</strong></div></div><button className="primary" onClick={openWizard}>添加另一台服务器</button></div>{server.profile ? <div className="profile-panel"><div className="profile-heading"><div><p className="eyebrow">AI 服务器档案</p><h2>我已经了解这台服务器</h2></div><span className="read-only-pill">只读扫描</span></div><p className="profile-summary">已读取基础环境信息。没有修改文件、安装软件或启动服务。</p><div className="profile-grid"><div><span>主机名</span><strong>{server.profile.hostname}</strong></div><div><span>CPU</span><strong>{server.profile.cpuCores} 核</strong></div><div><span>内存</span><strong>{server.profile.memory}</strong></div><div><span>磁盘</span><strong>{server.profile.disk}</strong></div><div><span>Docker</span><strong>{server.profile.dockerInstalled ? `已安装 · ${server.profile.dockerContainers} 个运行中` : "未安装"}</strong></div></div><div className="profile-actions"><button className="text-button" onClick={scanServer}>重新扫描</button><button className="primary small-button" onClick={analyzeServer} disabled={isAnalyzing}>{isAnalyzing ? "AI 正在分析…" : "让 AI 解读这台服务器"}</button></div>{server.aiSummary && <div className="ai-summary"><p className="eyebrow">AI 解读</p><div>{server.aiSummary}</div></div>}</div> : <button className="next-step clickable" onClick={scanServer} disabled={isScanning}><span className="step-icon">✦</span><div><strong>{isScanning ? "正在了解这台服务器…" : "下一步：让 AI 了解这台服务器"}</strong><p>{isScanning ? "只读取基础环境信息，请稍候。" : "读取系统、资源和 Docker 状态，不会自动修改任何内容。"}</p></div><span className="arrow">→</span></button>}</section> : <section className="empty-state" id="hosts"><div className="hero-icon">⌁</div><h2>连接你的第一台服务器</h2><p>输入 IP 地址、用户名和密码，然后用人话描述你想做什么。</p><button className="primary" onClick={openWizard}>开始连接</button><button className="secondary">查看演示</button></section>}{error && <div className="global-error">{error}</div>}<section className="principles" id="tasks"><div><strong>先检查，再行动</strong><span>AI 会先解释计划和风险</span></div><div><strong>每一步都可追踪</strong><span>查看完整操作时间线</span></div><div><strong>危险操作需批准</strong><span>你始终掌握最终决定权</span></div></section></>}
    </section>
    {isWizardOpen && <div className="modal-backdrop" role="presentation"><section className="wizard" role="dialog" aria-modal="true" aria-labelledby="wizard-title"><div className="wizard-header"><div><p className="eyebrow">第一步 · 连接服务器</p><h2 id="wizard-title">添加你的服务器</h2></div><button className="close-button" onClick={() => setWizardOpen(false)} aria-label="关闭">×</button></div><p className="wizard-intro">只需要填写你已有的信息。OpsNest 会先测试连接，不会修改服务器。</p><label>服务器名称<span>可选</span><input value={form.name} onChange={(event) => update("name", event.target.value)} placeholder="例如：我的网站" /></label><div className="field-row"><label>服务器地址<input value={form.host} onChange={(event) => update("host", event.target.value)} placeholder="例如：203.0.113.10" autoFocus /></label><label className="port-field">SSH 端口<input value={form.port} onChange={(event) => update("port", event.target.value)} inputMode="numeric" /></label></div><label>用户名<input value={form.username} onChange={(event) => update("username", event.target.value)} placeholder="例如：root 或 ubuntu" /></label><div className="auth-tabs"><button className={form.authMethod === "password" ? "selected" : ""} onClick={() => update("authMethod", "password")}>密码登录</button><button className={form.authMethod === "privateKey" ? "selected" : ""} onClick={() => update("authMethod", "privateKey")}>SSH 私钥</button></div>{form.authMethod === "password" ? <label>密码<input type="password" value={form.password} onChange={(event) => update("password", event.target.value)} placeholder="只在本次连接中使用" /></label> : <><label>私钥文件路径<input value={form.privateKeyPath} onChange={(event) => update("privateKeyPath", event.target.value)} placeholder="例如：C:\\Users\\你\\.ssh\\id_ed25519" /></label><label>私钥密码<span>可选</span><input type="password" value={form.passphrase} onChange={(event) => update("passphrase", event.target.value)} /></label></>}{error && <div className="error-box">{error}</div>}<div className="wizard-footer"><button className="secondary" onClick={() => setWizardOpen(false)}>取消</button><button className="primary" onClick={connect} disabled={isConnecting}>{isConnecting ? "正在测试连接…" : "测试并连接"}</button></div></section></div>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
