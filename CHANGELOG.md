# Changelog

## 0.1.2-alpha.1

- 重构内部文件，拆分为模块化，便于开发。

## 0.1.1-alpha.2

- AgentRun 改为通过 OpenAI-compatible Chat Completions Function Calling 请求服务器命令，并把真实命令输出回传给模型，以支持连续的多步骤任务。
- 在持久 SSH Shell 中支持“定位目录 → 切换目录 → `pwd` 验证”这类依赖会话上下文的任务；工作目录会保留给后续命令。
- 优化终端普通对话与服务器任务的分流；聊天请求不再默认作为 Shell 命令执行。
- AI Key 读取失败不会再中断其他本地配置的加载，避免界面错误显示为“AI 未配置”。
- 为 xterm 终端加入 `Ctrl+V` 与 `Shift+Insert` 剪贴板粘贴处理。

## 0.1.1-alpha.1

- 新增图标目录、命名、尺寸和文件大小规则。

## 0.1.0-alpha.9

修复若干已知问题，完善图标加载与桌面版本显示。
