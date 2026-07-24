import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import "./styles.css";

type AuthMethod = "password" | "privateKey";
type ServerStatus = "connected" | "saved";
type View = "hosts" | "settings" | "terminal";
type TerminalMode = "shell" | "ai";
type TerminalLine = { kind: "system" | "command" | "output" | "ai"; text: string };
type Locale = "zh-CN" | "en-US";
type AiProvider = "openai" | "deepseek" | "openrouter" | "ollama" | "custom";

type ServerProfile = { osName: string; hostname: string; cpuCores: string; memory: string; disk: string; dockerInstalled: boolean; dockerContainers: string };
type Server = { id: string; name: string; host: string; port: number; username: string; system: string; status: ServerStatus; profile?: ServerProfile; aiSummary?: string };
type ServerForm = { name: string; host: string; port: string; username: string; authMethod: AuthMethod; password: string; privateKeyPath: string; passphrase: string };
type SshRequest = { host: string; port: number; username: string; authMethod: AuthMethod; password: string | null; privateKeyPath: string | null; passphrase: string | null };
type AiConfig = { provider: AiProvider; apiKey: string; baseUrl: string; model: string };
type PersistedData = { servers?: Server[]; aiConfig?: Partial<AiConfig> | null; language?: Locale };

const STORAGE_KEY = "opsnest.servers";
const AI_STORAGE_KEY = "opsnest.ai-model";
const LANGUAGE_STORAGE_KEY = "opsnest.language";
const initialForm: ServerForm = { name: "", host: "", port: "22", username: "root", authMethod: "password", password: "", privateKeyPath: "", passphrase: "" };
const defaultAiConfig: AiConfig = { provider: "deepseek", apiKey: "", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" };
const providerPresets: Record<AiProvider, { label: string; baseUrl: string; model: string; keyRequired: boolean }> = {
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", keyRequired: true },
  deepseek: { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", keyRequired: true },
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini", keyRequired: true },
  ollama: { label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:7b", keyRequired: false },
  custom: { label: "Custom endpoint", baseUrl: "", model: "", keyRequired: true },
};

const zh = {
  welcome: "欢迎回来", hosts: "我的服务器", tasks: "任务记录", settings: "设置", servers: "服务器", addServer: "添加服务器", localFirst: "本地优先", credentialsLocal: "凭据只在连接时使用", localMode: "● 本地模式", localConfig: "本地配置", aiModel: "AI 模型", localOnly: "● 仅本机使用", apiDirect: "API 直连",
  addAiModel: "添加一个 AI 模型", aiModelIntro: "模型只负责理解你的描述和服务器状态，所有 SSH 操作仍由本地安全流程控制。", modelService: "模型服务", apiAddress: "API 地址", apiKey: "API Key", optional: "可选", modelName: "模型名称", modelPlaceholder: "例如：deepseek-chat", apiPlaceholder: "https://api.example.com/v1", keyPlaceholder: "输入你的 API Key", ollamaKey: "本地 Ollama 不需要 Key", testConnection: "测试连接", testing: "正在测试…", saveModel: "保存模型", savedLocal: "已保存到本机", connectionFound: (count: number) => `连接成功，发现 ${count} 个模型`, connectionNoList: "连接成功，可以手动填写模型名称", keyLocalNote: "API Key 目前仅保存在当前电脑的本地配置中，不会上传到 OpsNest。建议使用权限受限、额度可控的 Key。", language: "语言", simplifiedChinese: "简体中文", english: "English", languageNote: "更改语言后，界面会立即更新。",
  connectFirst: "连接你的第一台服务器", connectIntro: "输入 IP 地址、用户名和密码，然后用人话描述你想做什么。", startConnect: "开始连接", demo: "查看演示", connected: "已连接", saved: "已保存", system: "系统", connectionMethod: "连接方式", ssh: "SSH", addAnother: "添加另一台服务器", serverProfile: "AI 服务器档案", understood: "我已经了解这台服务器", readOnly: "只读扫描", profileIntro: "已读取基础环境信息。没有修改文件、安装软件或启动服务。", hostname: "主机名", cpu: "CPU", memory: "内存", disk: "磁盘", docker: "Docker", installedRunning: (count: string) => `已安装 · ${count} 个运行中`, notInstalled: "未安装", rescan: "重新扫描", analyzeServer: "让 AI 解读这台服务器", analyzing: "AI 正在分析…", aiInterpretation: "AI 解读", nextStep: "下一步：让 AI 了解这台服务器", understanding: "正在了解这台服务器…", scanIntro: "读取系统、资源和 Docker 状态，不会自动修改任何内容。", scanWait: "只读取基础环境信息，请稍候。", principles: ["先检查，再行动", "AI 会先解释计划和风险", "每一步都可追踪", "查看完整操作时间线", "危险操作需批准", "你始终掌握最终决定权"],
  addWizardTitle: "添加你的服务器", firstStep: "第一步 · 连接服务器", wizardIntro: "只需要填写你已有的信息。OpsNest 会先测试连接，不会修改服务器。", serverName: "服务器名称", serverNamePlaceholder: "例如：我的网站", serverAddress: "服务器地址", serverAddressPlaceholder: "例如：203.0.113.10", port: "SSH 端口", username: "用户名", usernamePlaceholder: "例如：root 或 ubuntu", passwordLogin: "密码登录", privateKey: "SSH 私钥", password: "密码", passwordPlaceholder: "只在本次连接中使用", keyPath: "私钥文件路径", keyPathPlaceholder: "例如：C:\\Users\\你\\.ssh\\id_ed25519", passphrase: "私钥密码", cancel: "取消", connecting: "正在测试连接…", connect: "测试并连接", close: "关闭", missingHost: "请输入服务器地址。", missingUser: "请输入用户名。", invalidPort: "端口号需要是 1 到 65535 之间的数字。", missingPassword: "请输入密码。", missingKey: "请输入私钥文件路径。", reconnect: "请重新连接服务器后再进行扫描。", noCredentials: "当前会话没有保存登录凭据，请重新连接服务器。", connectionFailed: "连接失败，请检查地址、端口和登录方式。", scanFailed: "扫描失败，请重新连接服务器后再试。", configureAi: "请先在设置中完成 AI 模型配置。", aiFailed: "AI 调用失败，请检查模型设置。", apiMissing: "请输入 API 地址。", modelMissing: "请输入模型名称。", keyMissing: "请输入 API Key。", modelFailed: "模型连接失败，请检查地址和 Key。", taskComing: "任务记录将在下一阶段加入。", terminalShell: "Shell", terminalAi: "AI 助手", terminalPlaceholder: "输入命令，或切换到 AI 模式用自然语言描述…", terminalAiPlaceholder: "例如：查看磁盘还有多少空间", terminalEmpty: "双击左侧服务器名称即可进入 SSH。", terminalConnecting: "正在连接…", terminalExit: "退出终端", terminalCommandFailed: "命令执行失败：", terminalAiNeedModel: "请先在设置中配置 AI 模型。",
};

const en = {
  welcome: "Welcome back", hosts: "My servers", tasks: "Task history", settings: "Settings", servers: "Servers", addServer: "Add server", localFirst: "Local-first", credentialsLocal: "Credentials are used only while connecting", localMode: "● Local mode", localConfig: "Local configuration", aiModel: "AI model", localOnly: "● Local only", apiDirect: "Direct API",
  addAiModel: "Add an AI model", aiModelIntro: "The model only interprets your request and server status. SSH actions remain controlled by the local safety flow.", modelService: "Model provider", apiAddress: "API URL", apiKey: "API key", optional: "Optional", modelName: "Model name", modelPlaceholder: "For example: gpt-4o-mini", apiPlaceholder: "https://api.example.com/v1", keyPlaceholder: "Enter your API key", ollamaKey: "Ollama runs locally and does not need a key", testConnection: "Test connection", testing: "Testing…", saveModel: "Save model", savedLocal: "Saved on this computer", connectionFound: (count: number) => `Connected, found ${count} model${count === 1 ? "" : "s"}`, connectionNoList: "Connected. You can enter a model name manually.", keyLocalNote: "The API key is stored only on this computer and is not sent to OpsNest. Use a key with limited permissions and spending.", language: "Language", simplifiedChinese: "简体中文", english: "English", languageNote: "The interface updates immediately after changing the language.",
  connectFirst: "Connect your first server", connectIntro: "Enter the IP address, username and password, then describe what you want to do in plain language.", startConnect: "Start connecting", demo: "View demo", connected: "Connected", saved: "Saved", system: "System", connectionMethod: "Connection", ssh: "SSH", addAnother: "Add another server", serverProfile: "AI server profile", understood: "I understand this server", readOnly: "Read-only scan", profileIntro: "Basic environment information was read. No files were changed, software installed or services started.", hostname: "Hostname", cpu: "CPU", memory: "Memory", disk: "Disk", docker: "Docker", installedRunning: (count: string) => `Installed · ${count} running`, notInstalled: "Not installed", rescan: "Scan again", analyzeServer: "Ask AI to explain this server", analyzing: "AI is analyzing…", aiInterpretation: "AI interpretation", nextStep: "Next: let AI understand this server", understanding: "Learning about this server…", scanIntro: "Read system, resource and Docker status. Nothing will be changed automatically.", scanWait: "Reading basic environment information…", principles: ["Check first, then act", "AI explains the plan and risk first", "Every step is traceable", "View the complete operation timeline", "Risky actions require approval", "You always make the final decision"],
  addWizardTitle: "Add your server", firstStep: "Step 1 · Connect a server", wizardIntro: "Enter the information you already have. OpsNest tests the connection before doing anything else.", serverName: "Server name", serverNamePlaceholder: "For example: My website", serverAddress: "Server address", serverAddressPlaceholder: "For example: 203.0.113.10", port: "SSH port", username: "Username", usernamePlaceholder: "For example: root or ubuntu", passwordLogin: "Password", privateKey: "SSH private key", password: "Password", passwordPlaceholder: "Used only for this connection", keyPath: "Private key path", keyPathPlaceholder: "For example: C:\\Users\\you\\.ssh\\id_ed25519", passphrase: "Key passphrase", cancel: "Cancel", connecting: "Testing connection…", connect: "Test and connect", close: "Close", missingHost: "Enter the server address.", missingUser: "Enter a username.", invalidPort: "The port must be a number between 1 and 65535.", missingPassword: "Enter the password.", missingKey: "Enter the private key path.", reconnect: "Reconnect to the server before scanning it.", noCredentials: "This session has no login credentials. Reconnect to the server first.", connectionFailed: "Connection failed. Check the address, port and login method.", scanFailed: "Scan failed. Reconnect to the server and try again.", configureAi: "Complete the AI model settings first.", aiFailed: "The AI request failed. Check the model settings.", apiMissing: "Enter the API URL.", modelMissing: "Enter a model name.", keyMissing: "Enter an API key.", modelFailed: "The model connection failed. Check the URL and key.", taskComing: "Task history will be added in the next stage.", terminalShell: "Shell", terminalAi: "AI assistant", terminalPlaceholder: "Enter a command, or switch to AI mode and describe what you need…", terminalAiPlaceholder: "For example: How much disk space is left?", terminalEmpty: "Double-click a server on the left to open SSH.", terminalConnecting: "Connecting…", terminalExit: "Exit terminal", terminalCommandFailed: "Command failed: ", terminalAiNeedModel: "Configure an AI model in Settings first.",
};

function App() {
  const [language, setLanguage] = useState<Locale>("zh-CN");
  const text = language === "zh-CN" ? zh : en;
  const [view, setView] = useState<View>("hosts");
  const [servers, setServers] = useState<Server[]>([]);
  const [server, setServer] = useState<Server | null>(null);
  const [form, setForm] = useState<ServerForm>(initialForm);
  const [aiConfig, setAiConfig] = useState<AiConfig>(defaultAiConfig);
  const [terminalMode, setTerminalMode] = useState<TerminalMode>("shell");
  const [terminalInput, setTerminalInput] = useState("");
  const [terminalLines, setTerminalLines] = useState<TerminalLine[]>([]);
  const [isExecuting, setExecuting] = useState(false);
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
        const savedLanguage = stored.language ?? (localStorage.getItem(LANGUAGE_STORAGE_KEY) as Locale | null);
        if (cancelled) return;
        const restored = (saved ?? []).map((item) => ({ ...item, status: "saved" as ServerStatus }));
        setServers(restored);
        if (restored[0]) setServer(restored[0]);
        if (savedAi) setAiConfig({ ...defaultAiConfig, ...savedAi });
        if (savedLanguage === "zh-CN" || savedLanguage === "en-US") setLanguage(savedLanguage);
        if ((!stored.servers?.length && legacyServers.length) || (!stored.aiConfig && legacyAi)) await invoke("save_local_data", { data: { servers: legacyServers, aiConfig: savedAi, language: savedLanguage ?? "zh-CN" } });
      } catch {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as Server[];
        const savedAi = JSON.parse(localStorage.getItem(AI_STORAGE_KEY) ?? "null") as Partial<AiConfig> | null;
        const savedLanguage = localStorage.getItem(LANGUAGE_STORAGE_KEY) as Locale | null;
        if (cancelled) return;
        const restored = saved.map((item) => ({ ...item, status: "saved" as ServerStatus }));
        setServers(restored);
        if (restored[0]) setServer(restored[0]);
        if (savedAi) setAiConfig({ ...defaultAiConfig, ...savedAi });
        if (savedLanguage === "zh-CN" || savedLanguage === "en-US") setLanguage(savedLanguage);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, []);

  const persistData = (nextServers: Server[], nextAiConfig: AiConfig = aiConfig, nextLanguage: Locale = language) => {
    const data = { servers: nextServers.map(({ status: _status, ...item }) => item), aiConfig: nextAiConfig, language: nextLanguage };
    void invoke("save_local_data", { data }).catch(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify(data.servers)); localStorage.setItem(AI_STORAGE_KEY, JSON.stringify(nextAiConfig)); localStorage.setItem(LANGUAGE_STORAGE_KEY, nextLanguage); });
  };
  const persistServers = (next: Server[]) => { setServers(next); persistData(next); };
  const update = <K extends keyof ServerForm>(key: K, value: ServerForm[K]) => { setForm((current) => ({ ...current, [key]: value })); setError(""); };
  const updateAi = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => { setAiConfig((current) => ({ ...current, [key]: value })); setModelStatus(""); setError(""); };
  const changeLanguage = (next: Locale) => { setLanguage(next); localStorage.setItem(LANGUAGE_STORAGE_KEY, next); persistData(servers, aiConfig, next); };
  const openWizard = () => { setForm(initialForm); setError(""); setWizardOpen(true); };
  const requestForForm = (): SshRequest => ({ host: form.host.trim(), port: Number(form.port), username: form.username.trim(), authMethod: form.authMethod, password: form.authMethod === "password" ? form.password : null, privateKeyPath: form.authMethod === "privateKey" ? form.privateKeyPath.trim() : null, passphrase: form.passphrase || null });
  const openTerminal = (selected: Server) => {
    if (selected.status !== "connected" || !activeCredentials.current[selected.id]) { setServer(selected); setView("hosts"); setError(text.noCredentials); return; }
    setServer(selected); setTerminalMode("shell"); setTerminalInput(""); setTerminalLines([{ kind: "system", text: `${selected.username}@${selected.host}:${selected.port} · SSH` }]); setView("terminal"); setError("");
  };

  const submitTerminalInput = async () => {
    const input = terminalInput.trim();
    if (!input || !server) return;
    const request = activeCredentials.current[server.id];
    if (!request) { setError(text.noCredentials); return; }
    setTerminalInput("");
    setTerminalLines((lines) => [...lines, { kind: "command", text: terminalMode === "shell" ? input : `自然语言 › ${input}` }]);
    setExecuting(true); setError("");
    try {
      if (terminalMode === "ai") {
        if (!aiConfig.baseUrl.trim() || !aiConfig.model.trim() || (providerPresets[aiConfig.provider].keyRequired && !aiConfig.apiKey.trim())) { setTerminalLines((lines) => [...lines, { kind: "system", text: text.terminalAiNeedModel }]); setView("settings"); return; }
        const profileContext = server.profile ? `OS: ${server.profile.osName}; hostname: ${server.profile.hostname}; CPU: ${server.profile.cpuCores}; memory: ${server.profile.memory}; disk: ${server.profile.disk}; Docker: ${server.profile.dockerInstalled ? "installed" : "not installed"}.` : `OS: ${server.system}.`;
        const prompt = language === "zh-CN" ? `用户想在服务器 ${server.name} 上完成这个任务：${input}\n服务器只读信息：${profileContext}\n请说明你理解的目标、建议的 Shell 命令和风险。不要执行命令，不要声称已经完成。` : `The user wants to do this on server ${server.name}: ${input}\nRead-only server context: ${profileContext}\nExplain your understanding, suggest the shell command and describe the risk. Do not execute the command or claim it has been completed.`;
        const response = await askModel(aiConfig, prompt, language);
        setTerminalLines((lines) => [...lines, { kind: "ai", text: response }]);
      } else {
        const output = await invoke<string>("execute_ssh_command", { request, command: input });
        setTerminalLines((lines) => [...lines, { kind: "output", text: output || "(no output)" }]);
      }
    } catch (commandError) {
      setTerminalLines((lines) => [...lines, { kind: "output", text: `${text.terminalCommandFailed}${commandError instanceof Error ? commandError.message : String(commandError)}` }]);
    } finally { setExecuting(false); }
  };

  const connect = async () => {
    if (!form.host.trim()) return setError(text.missingHost);
    if (!form.username.trim()) return setError(text.missingUser);
    if (!/^[1-9]\d{0,4}$/.test(form.port) || Number(form.port) > 65535) return setError(text.invalidPort);
    if (form.authMethod === "password" && !form.password) return setError(text.missingPassword);
    if (form.authMethod === "privateKey" && !form.privateKeyPath.trim()) return setError(text.missingKey);
    setConnecting(true); setError("");
    try {
      const request = requestForForm();
      const result = await invoke<{ system: string }>("test_ssh_connection", { request });
      const nextServer: Server = { id: `${form.host.trim()}:${Number(form.port)}`, name: form.name.trim() || form.host.trim(), host: form.host.trim(), port: Number(form.port), username: form.username.trim(), system: result.system, status: "connected" };
      activeCredentials.current[nextServer.id] = request;
      const next = [nextServer, ...servers.filter((item) => item.id !== nextServer.id)];
      persistServers(next); setServer(nextServer); setWizardOpen(false); setView("hosts");
    } catch (connectionError) { setError(connectionError instanceof Error ? connectionError.message : typeof connectionError === "string" ? connectionError : text.connectionFailed); }
    finally { setConnecting(false); }
  };

  const scanServer = async () => {
    if (!server || server.status !== "connected") { setError(text.reconnect); return; }
    const request = activeCredentials.current[server.id];
    if (!request) { setError(text.noCredentials); return; }
    setScanning(true); setError("");
    try {
      const profile = await invoke<ServerProfile>("inspect_server", { request });
      const updated = { ...server, profile, aiSummary: undefined };
      setServer(updated); persistServers([updated, ...servers.filter((item) => item.id !== updated.id)]);
    } catch (scanError) { setError(scanError instanceof Error ? scanError.message : typeof scanError === "string" ? scanError : text.scanFailed); }
    finally { setScanning(false); }
  };

  const analyzeServer = async () => {
    if (!server?.profile) return;
    if (!aiConfig.baseUrl.trim() || !aiConfig.model.trim() || (providerPresets[aiConfig.provider].keyRequired && !aiConfig.apiKey.trim())) { setView("settings"); setError(text.configureAi); return; }
    setAnalyzing(true); setError("");
    try {
      const profile = server.profile;
      const prompt = language === "zh-CN" ? `请分析这台服务器的只读信息，并给出新手能看懂的简短结论。请按“当前状态、值得注意的地方、下一步建议”三段回答。\n\n服务器名称：${server.name}\n系统：${profile.osName}\n主机名：${profile.hostname}\nCPU：${profile.cpuCores} 核\n内存：${profile.memory}\n磁盘：${profile.disk}\nDocker：${profile.dockerInstalled ? `已安装，${profile.dockerContainers} 个容器运行中` : "未安装"}` : `Analyze this server's read-only information in simple language for a beginner. Answer in three sections: Current status, Things to notice, and Recommended next steps.\n\nServer: ${server.name}\nSystem: ${profile.osName}\nHostname: ${profile.hostname}\nCPU: ${profile.cpuCores} cores\nMemory: ${profile.memory}\nDisk: ${profile.disk}\nDocker: ${profile.dockerInstalled ? `Installed, ${profile.dockerContainers} containers running` : "Not installed"}`;
      const summary = await askModel(aiConfig, prompt, language);
      const updated = { ...server, aiSummary: summary };
      setServer(updated); persistServers([updated, ...servers.filter((item) => item.id !== updated.id)]);
    } catch (analysisError) { setError(analysisError instanceof Error ? `${text.aiFailed} ${analysisError.message}` : text.aiFailed); }
    finally { setAnalyzing(false); }
  };

  const saveAiConfig = () => {
    if (!aiConfig.baseUrl.trim()) return setError(text.apiMissing);
    if (!aiConfig.model.trim()) return setError(text.modelMissing);
    if (providerPresets[aiConfig.provider].keyRequired && !aiConfig.apiKey.trim()) return setError(text.keyMissing);
    const next = { ...aiConfig, baseUrl: normalizeBaseUrl(aiConfig.baseUrl), model: aiConfig.model.trim() };
    setAiConfig(next); persistData(servers, next); setModelStatus(text.savedLocal); setError("");
  };

  const testAiConfig = async () => {
    if (!aiConfig.baseUrl.trim()) return setError(text.apiMissing);
    if (providerPresets[aiConfig.provider].keyRequired && !aiConfig.apiKey.trim()) return setError(text.keyMissing);
    setTestingModel(true); setModelStatus(""); setError("");
    try {
      const models = await listModels(aiConfig);
      if (models.length > 0 && !aiConfig.model.trim()) setAiConfig((current) => ({ ...current, model: models[0] }));
      setModelStatus(models.length > 0 ? text.connectionFound(models.length) : text.connectionNoList);
    } catch (modelError) { setError(modelError instanceof Error ? `${text.modelFailed} ${modelError.message}` : text.modelFailed); }
    finally { setTestingModel(false); }
  };

  const selectProvider = (provider: AiProvider) => { const preset = providerPresets[provider]; setAiConfig((current) => ({ ...current, provider, baseUrl: preset.baseUrl, model: preset.model })); setModelStatus(""); setError(""); };
  const lastServerClick = useRef<{ id: string; time: number }>({ id: "", time: 0 });
  const selectServer = (selected: Server) => { const now = Date.now(); const isDoubleClick = lastServerClick.current.id === selected.id && now - lastServerClick.current.time < 450; lastServerClick.current = { id: selected.id, time: now }; if (isDoubleClick) { openTerminal(selected); return; } setServer(selected); setView("hosts"); setError(""); };

  return <main className="shell">
    <aside className="sidebar">
      <div className="brand"><img className="brand-icon" src="/opsnest-icon.png" alt="" /><span>OpsNest</span></div>
      <nav aria-label="Navigation"><button className={view === "hosts" ? "active" : ""} onClick={() => setView("hosts")}>{text.hosts}</button><button onClick={() => setError(text.taskComing)}>{text.tasks}</button><button className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}>{text.settings}</button></nav>
      {servers.length > 0 && <div className="host-list"><p className="nav-caption">{text.servers}</p>{servers.map((item) => <button className={`host-item ${server?.id === item.id ? "selected" : ""}`} key={item.id} onClick={() => selectServer(item)}><span className={`host-dot ${item.status === "connected" ? "online" : ""}`}></span><span className="host-item-text"><strong>{item.name}</strong><small>{item.host}</small></span></button>)}</div>}
      <button className="add-host" onClick={openWizard}>＋ {text.addServer}</button>
      <div className="sidebar-note">{text.localFirst}<br />{text.credentialsLocal}</div>
    </aside>
    <section className="content">
      {view === "terminal" && server && <TerminalPanel server={server} text={text} mode={terminalMode} input={terminalInput} lines={terminalLines} executing={isExecuting} onModeChange={setTerminalMode} onInputChange={setTerminalInput} onSubmit={submitTerminalInput} onExit={() => setView("hosts")} />}
      {view === "settings" ? <section className="settings-view"><header className="topbar"><div><p className="eyebrow">{text.localConfig}</p><h1>{text.settings}</h1></div><span className="status-pill">{text.localOnly}</span></header><div className="settings-card"><div className="settings-heading"><div><h2>{text.addAiModel}</h2><p>{text.aiModelIntro}</p></div><span className="read-only-pill">{text.apiDirect}</span></div><label className="field-label">{text.language}<select value={language} onChange={(event) => changeLanguage(event.target.value as Locale)}><option value="zh-CN">{text.simplifiedChinese}</option><option value="en-US">{text.english}</option></select></label><p className="settings-note language-note">{text.languageNote}</p><label className="field-label">{text.modelService}<select value={aiConfig.provider} onChange={(event) => selectProvider(event.target.value as AiProvider)}>{Object.entries(providerPresets).map(([key, preset]) => <option key={key} value={key}>{preset.label}</option>)}</select></label><label className="field-label">{text.apiAddress}<input value={aiConfig.baseUrl} onChange={(event) => updateAi("baseUrl", event.target.value)} placeholder={text.apiPlaceholder} /></label><label className="field-label">{text.apiKey}{!providerPresets[aiConfig.provider].keyRequired && <span> {text.optional}</span>}<input type="password" value={aiConfig.apiKey} onChange={(event) => updateAi("apiKey", event.target.value)} placeholder={aiConfig.provider === "ollama" ? text.ollamaKey : text.keyPlaceholder} /></label><label className="field-label">{text.modelName}<input value={aiConfig.model} onChange={(event) => updateAi("model", event.target.value)} placeholder={text.modelPlaceholder} /></label><div className="settings-actions"><button className="secondary" onClick={testAiConfig} disabled={isTestingModel}>{isTestingModel ? text.testing : text.testConnection}</button><button className="primary" onClick={saveAiConfig}>{text.saveModel}</button></div>{modelStatus && <p className="success-text">✓ {modelStatus}</p>}<p className="settings-note">{text.keyLocalNote}</p></div></section> : <><header className="topbar"><div><p className="eyebrow">{text.welcome}</p><h1>{text.hosts}</h1></div><span className="status-pill">{text.localMode}</span></header>{server ? <section className="server-view" id="hosts"><div className="server-card"><div className="server-card-top"><div className="server-orb">⌁</div><span className={`connected-badge ${server.status === "saved" ? "saved-badge" : ""}`}>● {server.status === "connected" ? text.connected : text.saved}</span></div><h2>{server.name}</h2><p className="server-address">{server.username}@{server.host}:{server.port}</p><div className="server-meta"><div><span>{text.system}</span><strong>{server.profile?.osName ?? server.system}</strong></div><div><span>{text.connectionMethod}</span><strong>{text.ssh}</strong></div></div><button className="primary" onClick={openWizard}>{text.addAnother}</button></div>{server.profile ? <div className="profile-panel"><div className="profile-heading"><div><p className="eyebrow">{text.serverProfile}</p><h2>{text.understood}</h2></div><span className="read-only-pill">{text.readOnly}</span></div><p className="profile-summary">{text.profileIntro}</p><div className="profile-grid"><div><span>{text.hostname}</span><strong>{server.profile.hostname}</strong></div><div><span>{text.cpu}</span><strong>{server.profile.cpuCores} {language === "zh-CN" ? "核" : "cores"}</strong></div><div><span>{text.memory}</span><strong>{server.profile.memory}</strong></div><div><span>{text.disk}</span><strong>{server.profile.disk}</strong></div><div><span>{text.docker}</span><strong>{server.profile.dockerInstalled ? text.installedRunning(server.profile.dockerContainers) : text.notInstalled}</strong></div></div><div className="profile-actions"><button className="text-button" onClick={scanServer}>{text.rescan}</button><button className="primary small-button" onClick={analyzeServer} disabled={isAnalyzing}>{isAnalyzing ? text.analyzing : text.analyzeServer}</button></div>{server.aiSummary && <div className="ai-summary"><p className="eyebrow">{text.aiInterpretation}</p><div>{server.aiSummary}</div></div>}</div> : <button className="next-step clickable" onClick={scanServer} disabled={isScanning}><span className="step-icon">✦</span><div><strong>{isScanning ? text.understanding : text.nextStep}</strong><p>{isScanning ? text.scanWait : text.scanIntro}</p></div><span className="arrow">→</span></button>}</section> : <section className="empty-state" id="hosts"><div className="hero-icon">⌁</div><h2>{text.connectFirst}</h2><p>{text.connectIntro}</p><button className="primary" onClick={openWizard}>{text.startConnect}</button><button className="secondary">{text.demo}</button></section>}{error && <div className="global-error">{error}</div>}<section className="principles" id="tasks"><div><strong>{text.principles[0]}</strong><span>{text.principles[1]}</span></div><div><strong>{text.principles[2]}</strong><span>{text.principles[3]}</span></div><div><strong>{text.principles[4]}</strong><span>{text.principles[5]}</span></div></section></>}
    </section>
    {isWizardOpen && <div className="modal-backdrop" role="presentation"><section className="wizard" role="dialog" aria-modal="true" aria-labelledby="wizard-title"><div className="wizard-header"><div><p className="eyebrow">{text.firstStep}</p><h2 id="wizard-title">{text.addWizardTitle}</h2></div><button className="close-button" onClick={() => setWizardOpen(false)} aria-label={text.close}>×</button></div><p className="wizard-intro">{text.wizardIntro}</p><label>{text.serverName}<span>{text.optional}</span><input value={form.name} onChange={(event) => update("name", event.target.value)} placeholder={text.serverNamePlaceholder} /></label><div className="field-row"><label>{text.serverAddress}<input value={form.host} onChange={(event) => update("host", event.target.value)} placeholder={text.serverAddressPlaceholder} autoFocus /></label><label className="port-field">{text.port}<input value={form.port} onChange={(event) => update("port", event.target.value)} inputMode="numeric" /></label></div><label>{text.username}<input value={form.username} onChange={(event) => update("username", event.target.value)} placeholder={text.usernamePlaceholder} /></label><div className="auth-tabs"><button className={form.authMethod === "password" ? "selected" : ""} onClick={() => update("authMethod", "password")}>{text.passwordLogin}</button><button className={form.authMethod === "privateKey" ? "selected" : ""} onClick={() => update("authMethod", "privateKey")}>{text.privateKey}</button></div>{form.authMethod === "password" ? <label>{text.password}<input type="password" value={form.password} onChange={(event) => update("password", event.target.value)} placeholder={text.passwordPlaceholder} /></label> : <><label>{text.keyPath}<input value={form.privateKeyPath} onChange={(event) => update("privateKeyPath", event.target.value)} placeholder={text.keyPathPlaceholder} /></label><label>{text.passphrase}<span>{text.optional}</span><input type="password" value={form.passphrase} onChange={(event) => update("passphrase", event.target.value)} /></label></>}{error && <div className="error-box">{error}</div>}<div className="wizard-footer"><button className="secondary" onClick={() => setWizardOpen(false)}>{text.cancel}</button><button className="primary" onClick={connect} disabled={isConnecting}>{isConnecting ? text.connecting : text.connect}</button></div></section></div>}
  </main>;
}

function TerminalPanel({ server, text, mode, input, lines, executing, onModeChange, onInputChange, onSubmit, onExit }: { server: Server; text: typeof zh; mode: TerminalMode; input: string; lines: TerminalLine[]; executing: boolean; onModeChange: (mode: TerminalMode) => void; onInputChange: (value: string) => void; onSubmit: () => void; onExit: () => void }) {
  return <section className="terminal-view"><div className="terminal-header"><div><p className="eyebrow">SSH</p><h1>{server.name}</h1><span>{server.username}@{server.host}:{server.port}</span></div><button className="secondary terminal-exit" onClick={onExit}>{text.terminalExit}</button></div><div className="terminal-toolbar"><button className={mode === "shell" ? "terminal-mode active" : "terminal-mode"} onClick={() => onModeChange("shell")}>〉 {text.terminalShell}</button><button className={mode === "ai" ? "terminal-mode active" : "terminal-mode"} onClick={() => onModeChange("ai")}>✦ {text.terminalAi}</button><span className="terminal-status">● {executing ? text.terminalConnecting : text.connected}</span></div><div className="terminal-screen"><div className="terminal-welcome">{text.terminalEmpty}</div>{lines.map((line, index) => <div className={`terminal-line ${line.kind}`} key={`${index}-${line.kind}`}><span className="terminal-prefix">{line.kind === "command" ? "$" : line.kind === "ai" ? "✦" : line.kind === "system" ? "•" : ""}</span><pre>{line.text}</pre></div>)}</div><form className="terminal-input-row" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}><span className="terminal-prompt">{mode === "shell" ? "$" : "✦"}</span><input value={input} onChange={(event) => onInputChange(event.target.value)} placeholder={mode === "shell" ? text.terminalPlaceholder : text.terminalAiPlaceholder} disabled={executing} autoFocus /><button className="primary" type="submit" disabled={executing || !input.trim()}>{mode === "shell" ? text.terminalShell : text.terminalAi}</button></form></section>;
}

function normalizeBaseUrl(value: string) { return value.trim().replace(/\/+$/, ""); }

async function listModels(config: AiConfig) {
  const response = await fetch(`${normalizeBaseUrl(config.baseUrl)}/models`, { headers: config.apiKey.trim() ? { Authorization: `Bearer ${config.apiKey.trim()}` } : {} });
  if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 180)}`);
  const payload = await response.json() as { data?: Array<{ id?: string }> };
  return (payload.data ?? []).map((item) => item.id).filter((item): item is string => Boolean(item));
}

async function askModel(config: AiConfig, prompt: string, language: Locale) {
  const system = language === "zh-CN" ? "你是 OpsNest 的服务器助手。请用简洁、易懂的中文解释服务器状态，不要编造没有提供的信息。当前只能分析和建议，不要假设已经执行了任何操作。" : "You are the OpsNest server assistant. Explain server status clearly for beginners. Do not invent information or claim that any action has been executed. Provide analysis and suggestions only.";
  const response = await fetch(`${normalizeBaseUrl(config.baseUrl)}/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", ...(config.apiKey.trim() ? { Authorization: `Bearer ${config.apiKey.trim()}` } : {}) }, body: JSON.stringify({ model: config.model.trim(), temperature: 0.2, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] }) });
  if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 220)}`);
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return payload.choices?.[0]?.message?.content?.trim() || (language === "zh-CN" ? "模型没有返回可显示的内容。" : "The model returned no displayable content.");
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
