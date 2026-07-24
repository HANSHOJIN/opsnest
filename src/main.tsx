import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import "./styles.css";

type AuthMethod = "password" | "privateKey";

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

type Server = {
  name: string;
  host: string;
  username: string;
  system: string;
};

const initialForm: ServerForm = {
  name: "",
  host: "",
  port: "22",
  username: "root",
  authMethod: "password",
  password: "",
  privateKeyPath: "",
  passphrase: "",
};

function App() {
  const [form, setForm] = useState<ServerForm>(initialForm);
  const [server, setServer] = useState<Server | null>(null);
  const [isWizardOpen, setWizardOpen] = useState(false);
  const [isConnecting, setConnecting] = useState(false);
  const [error, setError] = useState("");

  const update = <K extends keyof ServerForm>(key: K, value: ServerForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setError("");
  };

  const openWizard = () => {
    setForm(initialForm);
    setError("");
    setWizardOpen(true);
  };

  const connect = async () => {
    if (!form.host.trim()) return setError("请输入服务器地址。");
    if (!form.username.trim()) return setError("请输入用户名。");
    if (!/^[1-9]\d{0,4}$/.test(form.port) || Number(form.port) > 65535) {
      return setError("端口号需要是 1 到 65535 之间的数字。");
    }
    if (form.authMethod === "password" && !form.password) return setError("请输入密码。");
    if (form.authMethod === "privateKey" && !form.privateKeyPath.trim()) return setError("请输入私钥文件路径。");

    setConnecting(true);
    setError("");
    try {
      const result = await invoke<{ system: string }>("test_ssh_connection", {
        request: {
          host: form.host.trim(),
          port: Number(form.port),
          username: form.username.trim(),
          authMethod: form.authMethod,
          password: form.authMethod === "password" ? form.password : null,
          privateKeyPath: form.authMethod === "privateKey" ? form.privateKeyPath.trim() : null,
          passphrase: form.passphrase || null,
        },
      });
      setServer({ name: form.name.trim() || form.host.trim(), host: form.host.trim(), username: form.username.trim(), system: result.system });
      setWizardOpen(false);
    } catch (connectionError) {
      setError(typeof connectionError === "string" ? connectionError : "连接失败，请检查地址、端口和登录方式。");
    } finally {
      setConnecting(false);
    }
  };

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand"><img className="brand-icon" src="/opsnest-icon.png" alt="" /><span>OpsNest</span></div>
        <nav aria-label="主导航">
          <a className="active" href="#hosts">我的服务器</a>
          <a href="#tasks">任务记录</a>
          <a href="#settings">设置</a>
        </nav>
        <button className="add-host" onClick={openWizard}>＋ 添加服务器</button>
        <div className="sidebar-note">本地优先<br />凭据只在连接时使用</div>
      </aside>
      <section className="content">
        <header className="topbar"><div><p className="eyebrow">欢迎回来</p><h1>我的服务器</h1></div><span className="status-pill">● 本地模式</span></header>
        {server ? (
          <section className="server-view" id="hosts">
            <div className="server-card">
              <div className="server-card-top"><div className="server-orb">⌁</div><span className="connected-badge">● 已连接</span></div>
              <h2>{server.name}</h2><p className="server-address">{server.username}@{server.host}</p>
              <div className="server-meta"><div><span>系统</span><strong>{server.system}</strong></div><div><span>连接方式</span><strong>SSH</strong></div></div>
              <button className="primary" onClick={openWizard}>添加另一台服务器</button>
            </div>
            <div className="next-step"><span className="step-icon">✦</span><div><strong>下一步：让 AI 了解这台服务器</strong><p>连接成功后，我们会读取基础状态，不会自动修改任何内容。</p></div><span className="arrow">→</span></div>
          </section>
        ) : (
          <section className="empty-state" id="hosts">
            <div className="hero-icon">⌁</div><h2>连接你的第一台服务器</h2>
            <p>输入 IP 地址、用户名和密码，然后用人话描述你想做什么。</p>
            <button className="primary" onClick={openWizard}>开始连接</button><button className="secondary">查看演示</button>
          </section>
        )}
        <section className="principles" id="tasks"><div><strong>先检查，再行动</strong><span>AI 会先解释计划和风险</span></div><div><strong>每一步都可追踪</strong><span>查看完整操作时间线</span></div><div><strong>危险操作需批准</strong><span>你始终掌握最终决定权</span></div></section>
      </section>
      {isWizardOpen && <div className="modal-backdrop" role="presentation"><section className="wizard" role="dialog" aria-modal="true" aria-labelledby="wizard-title">
        <div className="wizard-header"><div><p className="eyebrow">第一步 · 连接服务器</p><h2 id="wizard-title">添加你的服务器</h2></div><button className="close-button" onClick={() => setWizardOpen(false)} aria-label="关闭">×</button></div>
        <p className="wizard-intro">只需要填写你已有的信息。OpsNest 会先测试连接，不会修改服务器。</p>
        <label>服务器名称 <span>可选</span><input value={form.name} onChange={(event) => update("name", event.target.value)} placeholder="例如：我的网站" /></label>
        <div className="field-row"><label>服务器地址<input value={form.host} onChange={(event) => update("host", event.target.value)} placeholder="例如：203.0.113.10" autoFocus /></label><label className="port-field">SSH 端口<input value={form.port} onChange={(event) => update("port", event.target.value)} inputMode="numeric" /></label></div>
        <label>用户名<input value={form.username} onChange={(event) => update("username", event.target.value)} placeholder="例如：root 或 ubuntu" /></label>
        <div className="auth-tabs"><button className={form.authMethod === "password" ? "selected" : ""} onClick={() => update("authMethod", "password")}>密码登录</button><button className={form.authMethod === "privateKey" ? "selected" : ""} onClick={() => update("authMethod", "privateKey")}>SSH 私钥</button></div>
        {form.authMethod === "password" ? <label>密码<input type="password" value={form.password} onChange={(event) => update("password", event.target.value)} placeholder="只在本次连接中使用" /></label> : <><label>私钥文件路径<input value={form.privateKeyPath} onChange={(event) => update("privateKeyPath", event.target.value)} placeholder="例如：C:\\Users\\你\\.ssh\\id_ed25519" /></label><label>私钥密码 <span>可选</span><input type="password" value={form.passphrase} onChange={(event) => update("passphrase", event.target.value)} /></label></>}
        {error && <div className="error-box">{error}</div>}
        <div className="wizard-footer"><button className="secondary" onClick={() => setWizardOpen(false)}>取消</button><button className="primary" onClick={connect} disabled={isConnecting}>{isConnecting ? "正在测试连接…" : "测试并连接"}</button></div>
      </section></div>}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
