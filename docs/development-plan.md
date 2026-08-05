# OpsNest V2 development plan

## Direction

Build a new OpsNest application on top of the CodexShell shell. The shell owns the desktop window, four-pane layout, collapsible/resizable panels, tabs, transitions, settings entry, and portable local data boundary. OpsNest owns server management, SSH, AI, server home pages, files, tasks, and service-specific views.

## Reference policy

The clean `main` branch of `https://github.com/HANSHOJIN/opsnest` is the primary V1 capability source. The reference clone is kept outside this V2 project at:

`C:\Users\hansh\Documents\Codex\2026-07-23\referenced-chatgpt-conversation-this-is-untrusted\outputs\OpsNest-V1-source-reference`

The audited baseline is commit `63ee7c6f4a40648d43894187698292f98fc00b74`. Reuse proven capability code and behavior contracts from this source, but do not copy its old UI, navigation, or monolithic application composition into V2.

The V1 application version represented by this source baseline is `0.1.2-alpha.2`. The separate `0.1.2-alpha.1` portable build remains a black-box runtime reference only.

The OpsNest 0.1.2-alpha.1 portable build is a black-box runtime reference only. It may be used to compare these proven behaviors and design decisions:

- natural-language intent handling and the distinction between conversation and an executable server request;
- seamless SSH plus AI interaction, including persistent PTY behavior;
- command/output continuity, working-directory continuity, reconnect handling, and no-output handling;
- server discovery, hardware facts, Docker/service discovery, and local conversation/task records;
- AgentRun reasoning, execution, verification, and memory behavior.

These capabilities must be re-integrated through the new V2 architecture. Do not copy the old V1/V2 UI, duplicate the old shell, restore the obsolete navigation model, or treat the portable EXE as source code.

All V2 feature design should use `docs/codexshell-aesthetic-guard.md` as the default shell aesthetic baseline. Product requirements, usability, accessibility, and platform constraints take priority; justified deviations should record their reason and scope rather than being treated as forbidden.

## Initial module boundaries

```text
Opsnet-V2/
  src/
    app/              shell integration and routing
    layout/           pane, tab, resize, collapse behavior
    servers/          inventory and server home pages
    ssh/              persistent SSH/PTTY session layer
    agent/            intent, context, tools, approval, execution
    files/            remote/local file panel
    tasks/            task logs and scheduled tasks
    settings/         appearance and application settings
    services/         service discovery and service cards
    storage/          portable local data and migration-free V2 format
  src-tauri/          native window, tray, filesystem and SSH bridge
  docs/               architecture, behavior contracts and test plans
```

## Build order

1. Establish the CodexShell-based shell and the four-pane layout.
2. Add the V2 data model and local portable storage boundary.
3. Add server inventory and the server home-page routing contract.
4. Reconnect the proven SSH/PTTY core without reintroducing the old UI.
5. Add AI orchestration around the same live SSH session.
6. Add server discovery, Docker/services, files, tasks, and settings.
7. Run static checks, Rust checks, UI smoke tests, and real SSH smoke tests before packaging.

## Non-negotiable behavior contracts

- A terminal view is backed by one live session, not a chat transcript disguised as a terminal.
- AI and manual input share the same server session and working directory.
- Switching tabs preserves session state; closing a tab explicitly ends that view/session according to the lifecycle policy.
- Agent actions, command output, verification, and summaries remain traceable in one timeline.
- Server credentials and user data stay in the V2 portable data directory.
- New V2 storage is intentionally incompatible with the old archive format; no legacy migration is required.

## Portable storage contract

- The V2 data root is `data/` beside the running executable: `current_exe().parent()/data`.
- Shell preferences are stored as `appearance.json` and `layout.json` in that directory.
- The frontend accesses these files through typed Tauri commands; it does not use browser `localStorage` for V2 persistence.
- The native bridge validates JSON filenames, creates the directory on first use, and rejects oversized payloads.
- Future server, session, task, log, and credential stores must use the same portable root or an explicitly documented subdirectory.
- No old CodexShell, `co-shell`, or OpsNest archive keys are read or migrated.
