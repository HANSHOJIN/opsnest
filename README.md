# OpsNest

[简体中文](README_cn.md) · English

## What is OpsNest?

OpsNest is, as its name suggests, a small operations and maintenance nest. It is a management application for centrally managing the terminals you own, including servers, routers, NAS devices, and more.

## Virtual screenshots

The screenshots below use fictional demo servers and addresses for illustration only. They contain no real server information.

![OpsNest server home demo](docs/assets/dashboard-en.png)

![OpsNest AI-SSH terminal demo](docs/assets/terminal-en.png)

## Core features

- Powerful AI-SSH: AI is integrated directly into the SSH terminal. You do not need to memorize complicated command-line syntax; describe what you need in natural language and the AI will help you get the work done.
- A true Agent, not just an advisory assistant: the integrated AI can analyze a task, execute it, and provide a summary report.
- A familiar native SSH experience: the interface preserves the look and feel of a real SSH terminal.

## Highlights

1. **Server Manager**: a traditional AI chat interface for managing all your servers. It can help modify the application interface, add or remove server connections, and execute other Agent commands.
2. **Specialized home pages**: each terminal connection is automatically identified according to its capabilities as a general Linux server, an OpenWrt router, or a NAS. OpsNest then presents the appropriate home-page design. For example, a router home page can show connection counts and other router-specific information.
3. **Service discovery**: automatically scans ports that expose Web services and presents them as quick-open cards. Open a service with one click instead of remembering every port number, and add custom entries when needed.

## Development goals

- Support more types of terminals
- File management
- Online file editing
