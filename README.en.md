# OpsNest

[简体中文](README.md) · English

An SSH server management application for beginners, with a built-in AI Agent.

Users only need a basic understanding of their servers. Add a server address and login details, configure a model endpoint, and start managing individual servers or a server cluster. No programming experience is required, and you do not need to memorize command-line instructions.

OpsNest aims to be powerful without becoming difficult to use. It brings SSH, server status, file and task management, and AI Agent workflows together in one clear desktop application.

> Connect your server, describe what you need in plain language, and let OpsNest handle the rest.

![OpsNest server dashboard](docs/assets/dashboard.png)

OpsNest is currently in the Alpha stage. It is evolving from an early architecture prototype into a usable desktop application. It can store multiple SSH servers, run AgentRun locally, and provide both a traditional terminal and natural-language operations in the same app.

## Current version

`0.1.0-alpha.6`

Main validation targets:

- Windows x64
- Linux servers, with Debian and Ubuntu tested most often
- SSH password login and private-key login
- IP addresses, domain names, and custom SSH ports
- OpenAI-compatible APIs, DeepSeek, OpenAI, OpenRouter, Ollama, and custom endpoints

This is an Alpha release intended for testing and feedback.

## Features

### Server management

- Save multiple SSH servers
- Use IP addresses or domain names
- Configure custom SSH ports
- Use passwords or SSH private keys
- Show connection status, operating-system information, and latency
- Edit, connect to, and remove saved servers
- Store server credentials in the local operating-system credential store

### SSH terminal sessions

- Command-line-style SSH session window
- Run normal Shell commands directly
- Type `stop` to stop a running command
- Keep server-manager and child-server sessions independent
- Restore terminal conversation history after restarting the app
- Preserve commands and raw server output

### AI AgentRun

Natural-language requests can pass through the local AgentRun workflow:

```text
Understand the request
  → Read server memory
  → Search the web when needed
  → Explore the server
  → Run read-only diagnosis
  → Build the next command
  → Ask for approval
  → Execute
  → Verify the result
  → Summarize in plain language
  → Update server memory
```

The current Agent can:

- Continue analyzing after a failed command
- Detect common failures such as `command not found` and missing paths
- Make a limited number of recovery plans instead of retrying forever
- Avoid repeating the same failed command
- Keep the complete raw output in the terminal
- Produce a beginner-friendly summary in addition to the raw output
- Save completed task results as server memory for later conversations

### Server manager

The server manager is a normal chat workspace for multiple servers. It can:

- Understand the saved server inventory
- Plan checks and maintenance tasks across servers
- Connect to all saved servers
- Add a server from a conversation
- Remove a local server record and its local credential

### AI intervention modes

Settings provide three modes:

1. **Smart AI intervention** (default)
   - Shell commands execute directly
   - Natural-language requests go to the Agent
   - Automatically falls back when the model is unavailable
2. **AI always involved**
   - Both commands and natural language are interpreted by the AI first
   - Suitable for local models
3. **AI not involved**
   - Works like a classic SSH management application
   - Every input is sent directly as a Shell command

### Server-side scheduled tasks

Cron jobs run on each target server, not inside OpsNest. OpsNest reads and manages them through SSH.

- Read user Cron, system Cron, and systemd timers
- Create, edit, enable, disable, and delete OpsNest-managed user Cron jobs
- Select the target server from the Scheduled Tasks page
- Keep task operations in the local task history

## Local data

OpsNest does not require a cloud service. Main data is stored on the user's computer:

- Server and model configuration: local application data
- SSH credentials: operating-system credential storage
- Runtime logs: `opsnest-runtime.jsonl`
- AI and terminal conversations: `opsnest-conversations.jsonl`

The model API is selected and configured by the user. Server command output may be sent as context to that model provider.

## Getting started

### Use a packaged build

Windows users can download `OpsNest_*_x64-setup.exe`, install it, and launch the application.

First steps:

1. Open Settings and configure an AI model API
2. Add your first SSH server
3. Connect to it from My Servers
4. Double-click a server to open its terminal
5. Double-click My Servers to open the server manager

### Develop from source

Requirements:

- Node.js 18+
- Rust stable toolchain
- Tauri 2 platform dependencies

Install dependencies:

```bash
npm install
```

Start the frontend development server:

```bash
npm run dev
```

Start the Tauri desktop development mode:

```bash
npm run tauri:dev
```

Check TypeScript:

```bash
npm run check
```

Build the frontend:

```bash
npm run build
```

Build the Windows installer:

```bash
npm run tauri:build
```

Installer output:

```text
src-tauri/target/release/bundle/nsis/
```

## Project structure

```text
src/
  main.tsx          React UI, server management, and AgentRun flows
  styles.css        Main interface and terminal styles
  manager.css       Server manager and task-history styles
src-tauri/
  src/
    lib.rs          Tauri command registration
    ssh.rs          SSH connections, inspection, and command execution
    ai.rs           Model API calls
    web.rs          Web search
    storage.rs      Local data, logs, and credential storage
docs/
  architecture.md  Architecture notes
  roadmap.md        Development roadmap
public/
  opsnest-icon.png  Application icon
```

## Versioning

OpsNest uses standard semantic versioning:

- `0.1.0-alpha.N`: early testing, small fixes, and experimental features
- `0.1.0-beta.N`: a more complete public testing stage
- `0.1.0`: stable release

Every packaged build should update `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, and the version shown in the interface.

## Current limitations and roadmap

- The current primary target is Windows x64; macOS, Linux, Android, and iOS clients are not complete
- Linux distribution commands, package managers, and permission models still need more coverage
- Agent summaries and recovery planning depend on the configured model
- Web search is an assistant for reasoning and does not yet cover every official release channel
- Backups, rollback, batch changes, and more granular tool permissions are still being developed
- Cloud sync and team collaboration are not currently included

See [docs/roadmap.md](docs/roadmap.md) for the detailed plan. The next major areas are server file management and quick installation actions on server cards.

## Design goal

OpsNest is not meant to be just a chat box hiding a terminal. The goal is to let users:

```text
Describe the problem
  → Understand what the Agent is doing
  → Review the real command and result
  → Approve actions that need approval
  → Receive a plain-language summary
  → Continue later with familiar server memory
```

Issues, real-environment feedback, and improvement suggestions are welcome. Before sharing logs or screenshots, remove passwords, API keys, tokens, cookies, and private addresses.
