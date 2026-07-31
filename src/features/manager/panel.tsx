import { useEffect, useState } from "react";
import type { AgentRun, AgentStep, AgentStepId, Locale, ManagerMessage, Server } from "../../domain/types";

export type ManagerText = {
  managerTitle: string;
  managerSubtitle: string;
  managerExit: string;
  servers: string;
  managerNoServers: string;
  managerIntro: string;
  managerThinking: string;
  managerPlaceholder: string;
  managerSend: string;
};

export function ManagerPanel({ text, language, servers, messages, input, thinking, agentRun, onApprove, onReject, onInputChange, onSubmit, onExit }: { text: ManagerText; language: Locale; servers: Server[]; messages: ManagerMessage[]; input: string; thinking: boolean; agentRun: AgentRun | null; onApprove: () => void; onReject: () => void; onInputChange: (value: string) => void; onSubmit: () => void; onExit: () => void }) {
  return <section className="manager-view"><div className="manager-header"><div><p className="eyebrow">OpsNest</p><h1>{text.managerTitle}</h1><span>{text.managerSubtitle}</span></div><button className="secondary" onClick={onExit}>{text.managerExit}</button></div><div className="manager-layout"><aside className="manager-inventory"><h3>{text.servers}</h3>{servers.length ? servers.map((item) => <div className="manager-server" key={item.id}><span className={`host-dot ${item.status === "connected" ? "online" : ""}`}></span><div><strong>{item.name}</strong><small>{item.host}</small><em>{item.profile ? item.profile.osName : item.system}</em></div></div>) : <p className="manager-empty">{text.managerNoServers}</p>}</aside><div className="manager-chat"><div className="manager-messages"><div className="manager-intro">{text.managerIntro}</div>{messages.map((message, index) => <div className={`manager-message ${message.role}`} key={`${index}-${message.role}`}><span>{message.role === "user" ? "你" : message.role === "assistant" ? "AI" : "系统"}</span><pre>{message.text}</pre></div>)}{thinking && <div className="manager-message assistant"><span>AI</span><pre>{text.managerThinking}</pre></div>}</div>{agentRun && <AgentRunPanel run={agentRun} language={language} onApprove={onApprove} onReject={onReject} />}<form className="manager-input-row" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}><textarea value={input} onChange={(event) => onInputChange(event.target.value)} placeholder={text.managerPlaceholder} disabled={thinking || agentRun?.phase === "executing"} rows={2} autoFocus /><button className="primary" type="submit" disabled={thinking || agentRun?.phase === "executing" || !input.trim()}>{text.managerSend}</button></form></div></div></section>;
}

export function AgentRunPanel({ run, language, onApprove, onReject }: { run: AgentRun; language: Locale; onApprove: () => void; onReject: () => void }) {
  const [expanded, setExpanded] = useState(run.phase !== "completed" && run.phase !== "failed" && run.phase !== "blocked");
  useEffect(() => {
    setExpanded(run.phase !== "completed" && run.phase !== "failed" && run.phase !== "blocked");
  }, [run.id, run.phase]);
  const labels: Record<AgentStepId, string> = language === "zh-CN"
    ? { context: "上下文", memory: "读取服务器记忆", search: "联网搜索", explore: "探索环境", diagnose: "只读诊断", plan: "制定计划", approval: "等待审批", execute: "执行任务", verify: "验证结果", remember: "更新记忆" }
    : { context: "Context", memory: "Read server memory", search: "Web search", explore: "Explore environment", diagnose: "Read-only diagnosis", plan: "Build plan", approval: "Approval", execute: "Execute task", verify: "Verify result", remember: "Update memory" };
  const statusLabel = (status: AgentStep["status"]) => language === "zh-CN" ? ({ pending: "等待", running: "进行中", completed: "完成", failed: "失败", blocked: "已阻止" }[status]) : ({ pending: "Pending", running: "Running", completed: "Done", failed: "Failed", blocked: "Blocked" }[status]);
  const phaseLabel = run.phase === "waiting_approval" ? (language === "zh-CN" ? "等待你的决定" : "Waiting for your approval") : run.phase;
  const canToggle = run.phase === "completed" || run.phase === "failed" || run.phase === "blocked";
  return <div className={`agent-run-panel ${run.phase} ${expanded ? "expanded" : "collapsed"}`}>
    <div className="agent-run-heading"><strong>AgentRun</strong><div className="agent-run-heading-actions"><span>{phaseLabel}</span>{canToggle && <button className="agent-run-toggle" type="button" onClick={() => setExpanded((value) => !value)}>{expanded ? "收起过程" : "查看过程"}</button>}</div></div>
    {expanded && <><div className="agent-run-steps">{run.steps.map((step) => <div className={`agent-run-step ${step.status}`} key={step.id}><span className="agent-run-dot"></span><div><strong>{labels[step.id]}</strong><small>{statusLabel(step.status)}{step.detail ? ` · ${step.detail}` : ""}</small></div></div>)}</div>{run.plan && <div className="agent-run-plan"><p>{run.plan.explanation}</p><code>$ {run.plan.command}</code>{run.plan.verifyCommand && <small>Verify: {run.plan.verifyCommand}</small>}<small>Risk: {run.plan.risk ?? "medium"}</small></div>}{run.error && <div className="agent-run-error">{run.error}</div>}</>}
    {run.phase === "waiting_approval" && <div className="agent-run-actions"><button className="secondary" onClick={onReject}>{language === "zh-CN" ? "取消" : "Cancel"}</button><button className="primary" onClick={onApprove}>{language === "zh-CN" ? "批准执行" : "Approve and execute"}</button></div>}
  </div>;
}
