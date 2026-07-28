# OpsNest 运维小窝

简体中文 · [English](README.en.md)

一款面向新手、内置 AI Agent 的服务器 SSH 管理软件。

用户只需要知道服务器地址、登录方式，并配置一个模型接口，就可以开始管理自己的服务器或服务器集群。OpsNest 保留真实 SSH 终端，也提供服务器仪表板、服务入口和自然语言 AgentRun；不要求用户记住 Linux 命令，也不要求部署 OpsNest 云端服务。

> 连接服务器，用人话描述需求，逐步看懂每一次操作。

![OpsNest server dashboard](docs/assets/dashboard.png)

![OpsNest SSH terminal](docs/assets/terminal.png)

截图使用虚构的演示服务器，仅用于展示界面。

## 当前状态

当前版本：`0.1.0-alpha.8`

OpsNest 仍处于 Alpha 阶段，适合真实环境测试、反馈和共同开发。当前主要验证目标是 Windows x64 客户端，以及 Debian、Ubuntu、OpenWrt/iStoreOS 和 NAS 类 Linux 环境。它不是生产环境堡垒机，也不承诺覆盖所有发行版、包管理器和厂商系统。

## 已实现功能

### 服务器与桌面体验

- 保存多台服务器，支持 IP、域名和自定义 SSH 端口
- 支持密码登录与 SSH 私钥登录
- 使用系统凭据存储保存服务器凭据和 AI API Key
- 显示连接状态、延迟、操作系统、CPU、内存、系统盘和 Docker 信息
- 普通 Linux、OpenWrt/iStoreOS、NAS 服务器详情页
- 自动发现常见 Web 管理服务、Docker 容器和可访问端口
- 自定义管理入口，可用系统浏览器打开
- 中文界面，支持 English

### 原生 SSH 终端

- 命令行风格的持久 SSH Shell 会话
- 支持 `cd`、环境变量、虚拟环境和交互式终端程序
- 可直接执行普通 Shell 命令
- 支持 `stop` 停止正在执行的命令
- 子服务器终端与服务器总管相互独立
- 会话、命令和服务器原始输出可以在重启后恢复

### AI AgentRun

自然语言任务会在本地经过 AgentRun：

```text
理解请求
  → 读取服务器记忆与上下文
  → 必要时联网搜索
  → 探索服务器环境
  → 只读诊断
  → 生成下一步计划
  → 用户确认
  → 执行命令
  → 验证结果
  → 人话总结
  → 更新服务器记忆
```

Agent 会把机器身份、系统类型、已发现服务和之前的任务结果作为上下文，保留完整原始输出，同时尝试解释结果。命令失败时，它可以继续分析并有限次生成恢复计划，而不是无休止重试。

设置中可以选择三种介入模式：

1. **AI 智能介入**（默认）：明显的 Shell 命令直接执行，自然语言请求交给 Agent；模型不可用时自动降级。
2. **AI 全程介入**：命令和自然语言都先交给模型理解，适合本地模型或希望统一交互的用户。
3. **AI 全程不介入**：相当于传统 SSH 管理软件，输入直接发送给远程 Shell。

### 服务器总管、Cron 与日志

- 服务器总管用于跨服务器对话、连接和维护规划
- 总管可以根据对话添加或删除本地服务器记录
- Cron 任务实际运行在目标服务器上，OpsNest 只负责读取、展示和管理
- 任务记录、软件运行日志、AI 对话日志和终端会话记录保存在本机
- 服务器记忆用于后续 Agent 对话，不替代用户对执行结果的确认

## AI 模型

OpsNest 支持 OpenAI 兼容接口，并提供 OpenAI、DeepSeek、OpenRouter、Ollama 和自定义接口预设。用户自行选择模型服务商；服务器命令输出、日志片段或配置内容可能会作为上下文发送给所选模型服务。

推荐尝试：[FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi)。它提供 OpenAI 兼容的统一接口，可聚合多个免费模型提供方，也支持自定义 OpenAI 兼容端点。它是独立的第三方项目，使用前请阅读其文档、许可和服务条款。

## 本地数据与安全边界

- OpsNest 不要求用户部署云端服务，主要数据保存在本机
- 服务器密码、私钥密码、私钥路径和 AI API Key 使用操作系统凭据存储；私钥文件仍保留在用户指定的位置
- 服务器列表、模型地址、界面设置和任务摘要保存在本地应用数据中
- 软件运行日志与 AI/终端对话日志保存在本地 JSONL 文件中
- OpsNest 不会把凭据发送给模型；但服务器输出可能被发送给用户选择的模型 API

Alpha 阶段仍有明确限制：首次 SSH 连接采用首次信任（TOFU），会自动把主机密钥写入用户的 `~/.ssh/known_hosts`，但尚未提供指纹确认窗口；Agent 仍可能生成任意 Shell 命令。请通过其他可信渠道核对新服务器指纹，在测试服务器或有备份的环境中使用，并在分享日志、截图或 Issue 前删除密码、API Key、Token、Cookie、域名和私有地址。

更详细的发布前安全检查见 [SECURITY.md](SECURITY.md)。使用前请阅读 [免责声明](DISCLAIMER.md)。

## 开始使用

### 使用 Windows 打包版本

下载 `OpsNest_*_x64-setup.exe`，安装后启动应用：

1. 打开“设置”，填写模型 API（也可以暂时不配置 AI）
2. 添加第一台 SSH 服务器
3. 在“我的服务器”中连接服务器
4. 双击服务器名称进入原生 SSH 终端
5. 双击“我的服务器”进入服务器总管

### 从源码开发

环境要求：Node.js 18+、Rust stable toolchain，以及 Tauri 2 的平台依赖。

```bash
npm install
npm run check
npm run dev          # 仅启动前端
npm run tauri:dev    # 启动桌面开发模式
npm run build        # 构建前端
npm run tauri:build  # 构建 Windows 安装包
```

安装包输出目录：`src-tauri/target/release/bundle/nsis/`

## 项目结构

```text
src/
  main.tsx          React 界面、服务器管理和 AgentRun 流程
  styles.css        主界面与终端样式
  manager.css       总管与日志样式
src-tauri/
  src/lib.rs        Tauri 命令注册与桌面能力
  src/ssh.rs        SSH 连接、终端、探测和命令执行
  src/ai.rs         OpenAI 兼容模型调用
  src/web.rs        联网搜索
  src/storage.rs    本地数据、日志和凭据存取
docs/
  architecture.md  架构说明
  roadmap.md        开发路线图
  assets/           使用虚构数据的演示截图
```

## 版本规则

- `0.1.0-alpha.N`：早期测试、小修和实验功能
- `0.1.0-beta.N`：功能相对完整的公开测试阶段
- `0.1.0`：稳定版本

每次发布前请同步检查 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`、后端版本命令和界面版本显示。

## 路线图

近期方向包括服务器文件管理、服务器卡片快捷安装、SSH 隧道、更多系统专属首页，以及更完整的 Agent 工具层。详情见 [docs/roadmap.md](docs/roadmap.md)。

## 开源与第三方声明

本项目采用 [MIT License](LICENSE)。第三方依赖和图标来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

欢迎提交真实环境反馈和改进建议。请先阅读 [安全说明](SECURITY.md) 和 [免责声明](DISCLAIMER.md)，不要在 Issue 中公开凭据或未脱敏的服务器日志。
