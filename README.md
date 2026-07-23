# OpsNest

一个本地优先、面向新手的 AI Linux 服务器管理桌面应用。

> Describe the problem. Review the plan. Approve the action.

## 当前阶段

这是项目初始化骨架，目标架构为：

- Tauri 2 + Rust：桌面壳、本地凭据与 SSH 执行边界
- React + TypeScript + Vite：用户界面
- 本地 Agent 编排：计划、审批、执行、验证
- SQLite：主机、任务时间线与本地设置

当前只包含占位代码和架构约定，尚未实现真实 SSH 连接或模型调用。

## 版本规则

项目使用标准三段式版本号，初始版本为 `0.1.0-alpha.1`。其中：

- `alpha.N`：小修、实验功能和早期迭代，例如 `0.1.0-alpha.2`
- `beta.N`：较大的功能阶段，例如 `0.1.0-beta.1`
- 无后缀：正式稳定版，例如 `0.1.0`

## 设计原则

1. 服务器凭据只保存在用户本机的系统安全存储中。
2. Agent 不直接拥有任意 Shell 权限，所有动作经过安全网关。
3. 默认先诊断、再生成计划，修改操作必须经过用户批准。
4. 每个任务都记录时间线、影响范围、执行结果和恢复建议。
5. 首版优先支持 Ubuntu/Debian、单台主机和高频诊断任务。

## 目录

```text
src/                 React 界面与功能模块
src-tauri/           Tauri/Rust 本地核心占位
docs/                产品与安全设计文档
```

## 开始开发

```bash
npm install
npm run dev
```

正式接入 Tauri 前，请安装 Rust、Tauri CLI 和对应平台依赖。相关命令会在第一轮功能实现时补充。

## 安全提醒

此骨架不能连接生产服务器。接入 SSH、模型 API 和凭据存储前，必须补齐权限校验、输出脱敏、审批状态机、超时、取消和审计测试。
