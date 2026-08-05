# OpsNest V1 capability migration checklist

## Baseline identity

Verified source record:

- clone path: `C:\Users\hansh\Documents\Codex\2026-07-23\referenced-chatgpt-conversation-this-is-untrusted\outputs\OpsNest-V1-source-reference`
- remote URL: `https://github.com/HANSHOJIN/opsnest.git`
- remote name: `origin`
- branch: `main`
- commit: `63ee7c6f4a40648d43894187698292f98fc00b74`
- working tree at clone verification: clean and tracking `origin/main`

Black-box runtime record:

- portable ZIP: `C:\Users\hansh\Documents\Codex\2026-07-23\referenced-chatgpt-conversation-this-is-untrusted\outputs\ai-server-manager\artifacts-release-0.1.2-alpha.1\OpsNest_0.1.2-alpha.1_x64-portable.zip`
- role: black-box behavior comparison only; it is not source code and must not be used as a migration source or project root

- [x] Clone `https://github.com/HANSHOJIN/opsnest` outside the V2 project tree.
- [x] Verify the reference branch is `main`.
- [x] Verify the reference commit is `63ee7c6f4a40648d43894187698292f98fc00b74`.
- [x] Verify the fresh reference clone is clean and tracks `origin/main`.
- [x] Keep the 0.1.2-alpha.1 portable EXE as black-box behavior evidence only.
- [x] Keep CodexShell as the V2 window and layout baseline.
- [ ] Pin any later reference update by commit before using it.

## Source capability map

### Native SSH and PTY

Primary reference: `src-tauri/src/ssh.rs`

- [ ] Extract connection/authentication handling without copying UI assumptions.
- [ ] Preserve the per-session persistent command Shell registry.
- [ ] Preserve command serialization and end-marker output collection.
- [ ] Preserve cancellation through command IDs and remote interrupt handling.
- [ ] Preserve the per-session interactive PTY registry and output events.
- [ ] Preserve PTY resize, explicit close, and stale-session cleanup behavior.
- [ ] Preserve working-directory and environment continuity across commands.
- [ ] Re-test reconnect and no-output behavior against the portable EXE.
- [ ] Ensure a React mount never owns or implicitly duplicates a native PTY.

### Terminal integration

Primary references: `src/features/terminal/panel.tsx`, `command-classification.ts`, and `history.ts`

- [ ] Rebuild the terminal view inside CodexShell rather than copying the old panel UI.
- [ ] Bind each V2 terminal tab to one stable `sessionId`.
- [ ] Keep sessions alive while tabs, panels, settings, or the window are hidden.
- [ ] End a session only through the explicit V2 tab/session lifecycle policy.
- [ ] Preserve manual interactive input, resize, paste, stop, and output streaming.
- [ ] Preserve Shell context probing for current directory and virtual environment.
- [ ] Restore persisted terminal history without replaying it as live PTY output.

### AI and AgentRun

Primary references: `src/features/agent/`, `src/domain/types.ts`, `src-tauri/src/ai.rs`, and the Agent orchestration currently located in `src/main.tsx`

- [ ] Move Agent orchestration out of the old monolithic `main.tsx` into V2 services/state machines.
- [ ] Preserve the distinction between chat and an executable server request.
- [ ] Preserve the three AI intervention modes.
- [ ] Preserve context, memory, optional web search, exploration, and diagnosis steps.
- [ ] Preserve typed command planning, risk classification, approval, execution, verification, and summary.
- [ ] Preserve bounded recovery after a failed command; never retry indefinitely.
- [ ] Keep manual SSH and AI actions on the same logical server session and working directory.
- [ ] Keep model calls separate from SSH execution and prevent credentials from entering prompts.

### Safety and audit

Primary references: `src/features/agent/runtime-utils.ts`, `src-tauri/src/storage.rs`, and AgentRun state in `src/domain/types.ts`

- [ ] Replace scattered regular-expression checks with a V2 safety gateway contract.
- [ ] Keep typed tools, explicit targets, risk checks, and approval gates.
- [ ] Preserve log redaction and add structured audit records for plan, approval, execution, output, and verification.
- [ ] Treat remote output, web results, and stored history as untrusted context.
- [ ] Verify destructive commands cannot bypass approval through alternate entry paths.

### Server inventory, profiles, and discovery

Primary references: `src-tauri/src/ssh.rs`, `src/features/servers/`, `src/features/services/`, and `src/features/docker/`

- [ ] Define the fresh V2 server and credential-reference schemas first.
- [ ] Preserve connection tests, latency, system facts, Docker facts, and OS-specific profiles.
- [ ] Preserve OpenWrt/iStoreOS and NAS routing logic as domain behavior, not old page layout.
- [ ] Preserve service and reachable-panel discovery with normalized service records.
- [ ] Rebuild server home pages and service cards in the CodexShell visual language.

### Cron, tasks, logs, and credentials

Primary references: `src/features/cron/`, `src/features/activity/`, `src-tauri/src/ssh.rs`, and `src-tauri/src/storage.rs`

- [ ] Preserve Cron/systemd timer listing and guarded mutation behavior.
- [ ] Separate V2 task history from server-side scheduled-task state.
- [ ] Preserve append-only runtime and conversation logging semantics.
- [ ] Use new V2 filenames, schema versions, and application data boundaries.
- [ ] Preserve operating-system credential storage while using new V2 service/account identifiers.
- [ ] Do not load, convert, or migrate old OpsNest archives or local data.

## CodexShell integration gates

- [x] Freeze the exact CodexShell source baseline before copying shell code into V2.
- [x] Copy the CodexShell `0.1.1` source baseline into the V2 project while preserving the V2 planning documents.
- [ ] Add a shell-owned tab model and explicit tab lifecycle contract.
- [ ] Keep layout, resize, collapse, animation, window, tray, and settings mechanics in the shell layer.
- [ ] Keep servers, SSH, AI, files, tasks, services, and discovery out of shell components.
- [x] Store shell preferences under `data/appearance.json` and `data/layout.json` beside the executable rather than legacy browser keys.
- [ ] Extend the same portable data boundary to server, session, task, log, and credential stores.
- [ ] Verify opening settings or collapsing a panel does not unmount or recreate a PTY session.

## Verification gates

- [ ] TypeScript static check and frontend build.
- [ ] Rust formatting, check, and unit tests.
- [ ] Unit tests for session registry, command completion markers, cancellation, parsing, intent, and risk policy.
- [ ] UI test for one tab to one session and no duplicate terminal mounts.
- [ ] Real SSH smoke test for `cd`, environment variables, virtual environments, and interactive commands.
- [ ] Disconnect/reconnect and silent-command smoke tests.
- [ ] AI/manual shared-session and approval-flow smoke tests.
- [ ] Fresh-install storage test proving no legacy data is read.
- [ ] Package only after all applicable gates pass and packaging is explicitly requested.
