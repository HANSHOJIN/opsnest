# OpsNest 模块化与在线内容更新计划

## 目标

把当前可工作的单体桌面应用，逐步拆成边界清楚的模块；功能表现、已有服务器配置、对话和终端记录不因拆分而改变。

模块化的目的首先是让开发和维护更清晰，而不是立即做插件平台。当前阶段采用普通的软件在线更新：发布新版本后提示用户，由用户点击下载完整更新包并安装。

## 当前执行范围：功能冻结的重构期

这一轮只做代码、样式、脚本和测试边界的拆分，**不增加任何用户可见功能**。下列事项全部推迟到重构验收之后：

- SSH 首次信任确认。
- 在线更新检查、下载、安装和 portable 替换助手。
- 新系统模板、新服务识别、新卡片、新快捷操作。
- Agent 能力、提示词、工具、模型接入方式和 UI 交互调整。
- 数据库 / 配置格式迁移。

唯一允许的用户可见变化是修复由拆分直接引入的回归问题；它不能借机改变原本功能逻辑。现有设置、服务器、凭据、聊天记录、任务记录、终端会话和图标缓存的读取路径必须保持兼容。

## 更新边界

| 内容 | 更新方式 | 是否需要新 EXE |
| --- | --- | --- |
| Rust SSH、持久 Shell、凭据、Host Key 信任 | 完整应用更新 | 是 |
| React UI、Agent 执行器、数据库结构 | 完整应用更新 | 是 |
| 系统识别、服务签名、端口和管理页规则 | 完整应用更新 | 是 |
| 内置图标和图标别名 | 完整应用更新 | 是 |
| 任务模板和 AI 提示词策略 | 完整应用更新 | 是 |
| 用户自己的快捷入口和本地服务别名 | 本地数据 | 否 |

已有的在线图标查询 / 本地缓存可继续作为图标补全能力使用，但不扩展为可在线下载执行的功能包系统。

## 目标目录

```text
src/
  app/                 # AppShell、路由、启动和全局状态
  components/ui/       # Button、Card、Modal、Badge 等纯 UI
  domain/              # Server、Service、Task、Conversation 等类型
  features/
    hosts/             # 服务器列表、添加 / 编辑、连接状态
    server-detail/     # Linux、OpenWrt、NAS 专属详情页
    terminal/          # xterm、PTY 事件、命令历史、粘贴
    agent/             # Function Calling、执行进度、审批和对话
    cron/              # 服务器 Cron 和执行记录
    settings/          # 模型、语言和应用偏好
    icons/             # 内置图标、在线图标缓存和服务图标解析
  services/            # Tauri invoke 封装、本地数据仓库、日志仓库
  styles/              # tokens.css、layout.css、feature 样式

src-tauri/src/
  commands/            # Tauri command 的薄适配层
  domain/              # Rust 数据模型和错误类型
  ssh/
    connection.rs      # 连接、认证、Host Key 指纹
    terminal.rs        # 持久 PTY / Shell 和实时事件
    exec.rs            # 一次性命令与超时
    discovery.rs       # 读取并解析探测结果
    scripts.rs         # 加载外置脚本并注入参数
    known_hosts.rs     # 预留：首次信任、已信任、指纹变更（本轮不实现）
  ai/                  # OpenAI-compatible Function Calling
  storage/             # 本地配置、日志、会话、目录缓存
  web.rs               # 外部浏览器地址打开
  lib.rs               # 只保留模块声明和命令注册
```

## 重构实施顺序

### R0：冻结基线与回归样本（0.5 天）

1. 建立功能清单：服务器管理、连接、持久终端、AI 三种介入模式、总管、Cron、扫描、服务入口、Docker、图标、日志和设置。
2. 为纯函数建立开发期单元测试：版本比较、服务 URL、服务解析、终端提示符、AI 工具调用结果解析。
3. 固定 Tauri command 名称、事件名称、本地存储 key 和 JSON 数据结构；本轮禁止改名或迁移。
4. 记录一份人工回归清单，并以当前可工作的 alpha.2 为基线。

### R1：公共类型、数据仓库与样式基础（0.5–1 天）

- 把 TypeScript 类型、格式化函数、状态标签、服务 URL 和 `invoke` 封装移到 `domain/`、`services/`。
- 将 CSS token、全局布局与页面专属样式拆开；选择器不改变，渲染结果不改变。
- `main.tsx` 仍负责渲染，先不移动大型页面组件。

验收：启动、恢复本地数据、切换中英文、添加 / 编辑服务器与模型配置完全一致。

### R2：前端 feature 与 CSS 成对迁移（1–1.5 天）

按以下顺序迁移，每次只迁移一个 feature，组件和 CSS 同步移动：

1. `hosts`：侧栏、服务器卡片、添加 / 编辑弹窗。
2. `terminal`：xterm 生命周期、PTY 输入输出、粘贴、命令历史和终端 Agent 渲染。
3. `agent`：总管对话、Function Calling 会话、执行状态和日志。
4. `server-detail`：普通 Linux、OpenWrt、NAS、Docker 和服务入口。
5. `cron` 与 `settings`。

验收：迁移后界面结构、按钮位置、文案、操作路径和本地数据结果与迁移前一致。`main.tsx` 最终只保留 AppShell、初始化和页面路由。

### R3：Rust 内部模块与 SSH 脚本外置（0.5–1 天）

- 仅移动现有 Rust 代码到 `ssh/connection.rs`、`ssh/terminal.rs`、`ssh/exec.rs`、`ssh/discovery.rs`、`storage/`、`ai/` 和 `commands/`；公开 Tauri command 名称不变。
- 把 `ssh.rs` 中已有探测脚本逐字迁移到 `src-tauri/resources/ssh/*.sh`，再以 `include_str!()` 编译进 EXE。
- 保持脚本命令、输出标记 `OPSNEST_*` 和解析规则不变；本轮不增加探测逻辑。

验收：普通 Linux、iStoreOS / OpenWrt、飞牛 NAS 的硬件扫描、服务扫描、Docker 容器与终端结果逐项对照基线。

### R4：清理与完整回归（0.5 天）

- 删除已经迁移后的重复代码和无引用 CSS；不进行“顺手优化”。
- 对 TypeScript、Rust、Tauri 完整构建和 portable / setup 打包进行验证。
- 用同一份本地数据目录升级覆盖测试，确认不丢失服务器、凭据引用、模型配置、会话、日志、Cron 与图标缓存。

## 每次迁移的硬性门槛

1. 只移动一个模块；不混入功能需求或视觉改版。
2. `npm run check`、`cargo check`、`npm run tauri:build` 全部通过。
3. 运行时日志中无新增 error；手工回归当前模块相关路径。
4. 保留可读的原子提交；发现行为差异立即修复，不继续叠加下一轮拆分。
5. R4 未通过前不打新功能包、不发布功能版本。

## SSH 首次信任确认（重构完成后，高，约 1 天）

新增 `known_hosts` 模块。连接时从 SSH 握手读取服务器公钥指纹：

```text
未见过的主机
  -> 显示算法 + SHA-256 指纹
  -> 用户选择“信任并连接”
  -> 保存到本地 known_hosts

指纹匹配
  -> 直接连接

指纹变化
  -> 阻止自动连接，显示旧 / 新指纹
  -> 用户确认后才替换
```

该机制只保护 SSH 身份确认，不改变密码、私钥或 AI 模式的现有使用方式。

## SSH 脚本外部化说明

当前 `ssh.rs` 包含较长的 shell 字符串。外置脚本属于 R3 的代码拆分，不是新功能；将它们迁移到源码中的脚本文件，例如：

```text
src-tauri/resources/ssh/
  profile.sh
  discover-linux.sh
  discover-openwrt.sh
  discover-nas.sh
  discover-services.sh
  diagnose-readonly.sh
```

编译时用 `include_str!` 嵌入 EXE，因此离线使用不受影响。`scripts.rs` 只负责：选择脚本、注入经过转义的参数、执行、解析 `OPSNEST_*` 输出标记。

收益：脚本逻辑可单独审阅、测试和提交；社区贡献一个新系统 / 服务的探测规则时，不必在 1700 行 Rust 文件里寻找字符串。

## 普通在线更新（重构完成后）

### 用户流程

```text
应用启动后异步检查新版本（不阻塞首页）
-> 发现新版本时显示“发现 vX.Y.Z，查看更新”
-> 用户查看更新说明
-> 用户点击“下载并更新”
-> 下载完整 setup 或 portable 更新包
-> 校验文件摘要
-> 退出当前应用，安装 / 替换并重新启动
```

不会自动下载、不会后台静默更新；是否更新始终由用户决定。

### 发布与包类型

- 更新源使用 OpsNest 的 GitHub Release。
- Release 提供版本、更新说明、下载地址和 SHA-256。
- setup 版本下载完整 NSIS 安装包，退出应用后启动安装程序完成覆盖安装。
- portable 版本下载完整 ZIP，由轻量更新助手在主程序退出后替换 `opsnest.exe` 并重新启动；不能在运行中的 EXE 上直接覆盖。
- 当网络不可用、Release 无法访问或摘要校验失败时，继续使用当前版本，不影响服务器配置和本地数据。

第一版只做“检查并提醒”。自动下载、setup 覆盖安装和 portable 更新助手在后续小版本依次接入。

## 验收与回归

每个里程碑都必须覆盖：

- 已保存服务器、模型配置、密码凭据、聊天记录和终端会话不丢失。
- 普通 Linux、OpenWrt / iStoreOS、飞牛 NAS 的扫描结果和详情页可恢复。
- 终端的 `cd`、粘贴、交互命令、AI Function Calling 多步骤任务仍可用。
- 网络离线时，应用可正常启动、使用当前版本与已有图标缓存。
- 本轮重构不触发任何在线更新检查或下载行为。

## 不在这一轮做的事

- 不做任意远程插件、远程 JavaScript 或远程脚本执行。
- 不把用户服务器凭据、对话或扫描数据上传到目录服务。
- 不为了拆分而改变当前 UI 设计或重写已验证的持久 Shell。
