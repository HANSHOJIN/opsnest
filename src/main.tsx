import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function App() {
  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">✦</span><span>OpsNest</span></div>
        <nav aria-label="主导航">
          <a className="active" href="#hosts">我的服务器</a>
          <a href="#tasks">任务记录</a>
          <a href="#settings">设置</a>
        </nav>
        <button className="add-host">＋ 添加服务器</button>
        <div className="sidebar-note">本地优先<br />凭据不会上传到我们的服务器</div>
      </aside>
      <section className="content">
        <header className="topbar"><div><p className="eyebrow">欢迎回来</p><h1>我的服务器</h1></div><span className="status-pill">● 本地模式</span></header>
        <section className="empty-state" id="hosts">
          <div className="hero-icon">⌁</div>
          <h2>连接你的第一台服务器</h2>
          <p>输入 IP 地址、用户名和密码，然后用人话描述你想做什么。</p>
          <button className="primary">开始连接</button>
          <button className="secondary">查看演示</button>
        </section>
        <section className="principles" id="tasks"><div><strong>先检查，再行动</strong><span>AI 会先解释计划和风险</span></div><div><strong>每一步都可追踪</strong><span>查看完整操作时间线</span></div><div><strong>危险操作需批准</strong><span>你始终掌握最终决定权</span></div></section>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
