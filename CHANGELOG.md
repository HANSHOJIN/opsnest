# Changelog
## 0.2.0-alpha.1
- 使用codexshell彻底重写了界面，重写了80%内核，目前还属于预览版。发布源码用于多AI审查代码提交PR以提速开发。



## 0.1.2-alpha.2

- 合并反向隧道 SSH 支持：服务器连接配置、跳板机路由和 AI 总管隧道脚本生成。
- 统一凭据解析，使终端、Cron、Docker、服务扫描和 AI Agent 操作支持隧道路由。
- 修复 AI 审批任务影响持久 SSH Shell 的问题；安装、更新等 AI 任务使用独立 SSH 执行通道。
- 修复反向隧道脚本的 SSH 端口参数，并补充 systemd、crontab、rc.local 等启动方式兼容。

## 0.1.2-alpha.1

- 重构内部文件，拆分为模块化，便于开发。

## 0.1.1-alpha.2

- AgentRun 支持通过 OpenAI-compatible Chat Completions Function Calling 规划并执行多步服务器任务。
- 持久 SSH Shell 保留当前目录等会话上下文，并改进自然语言与命令行分流。
- 增加终端剪贴板粘贴支持。

## 0.1.1-alpha.1

- 新增图标目录、命名、尺寸和文件大小规则。

## 0.1.0-alpha.9

- 修复若干已知问题，完善图标加载与桌面版本显示。
