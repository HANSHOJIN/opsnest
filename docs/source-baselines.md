# Source baselines for the new session

## OpsNest V1 capability source

Repository: `https://github.com/HANSHOJIN/opsnest`

Clean reference clone:

`C:\Users\hansh\Documents\Codex\2026-07-23\referenced-chatgpt-conversation-this-is-untrusted\outputs\OpsNest-V1-source-reference`

Verified baseline:

- V1 application version: `0.1.2-alpha.2`
- branch: `main`
- commit: `63ee7c6f4a40648d43894187698292f98fc00b74`
- commit subject: `feat: keep terminal sessions alive when minimized`
- working tree at clone time: clean and tracking `origin/main`

Use this repository as the primary source-level reference for proven SSH, persistent shell/PTTY, AgentRun, discovery, Cron, local logging, storage, and credential behavior. Extract those capabilities behind new V2 contracts. Do not copy the old React composition, navigation, styles, or UI shell wholesale.

## CodexShell source

`C:\Users\hansh\Documents\Codex\2026-07-23\referenced-chatgpt-conversation-this-is-untrusted\outputs\codexShell`

Use this as the desktop shell baseline. Preserve its visual language and shell mechanics; do not assume it contains OpsNest functionality.

## Copied V2 shell baseline

The CodexShell source was copied into the V2 project at:

`C:\Users\hansh\Documents\Codex\2026-07-23\referenced-chatgpt-conversation-this-is-untrusted\outputs\Opsnet-V2`

The copied CodexShell source baseline was version `0.1.1`; the current OpsNest V2 product metadata is `0.2.0-alpha1` in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`. The existing V2 `docs/` directory was preserved. Git metadata, dependency directories, build output, `src-tauri/target`, release artifacts, and build logs were excluded. The copied shell has since been renamed to the OpsNest product identity and its preferences now use the portable `data/` directory beside the executable.

## OpsNest 0.1.2-alpha.1 portable build

`C:\Users\hansh\Documents\Codex\2026-07-23\referenced-chatgpt-conversation-this-is-untrusted\outputs\ai-server-manager\artifacts-release-0.1.2-alpha.1\OpsNest_0.1.2-alpha.1_x64-portable.zip`

Treat this as a read-only black-box behavior reference. It contains the portable executable, not the migration source. Extract or run it only when a specific behavior needs comparison. Do not modify the backup and do not use it as the new project root.

## Historical snapshot

`C:\Users\hansh\Documents\Codex\2026-07-23\referenced-chatgpt-conversation-this-is-untrusted\outputs\opsnest-snapshots\OpsNest-refactor-baseline-0.1.1-alpha.2-20260730-085426.zip`

Use only for investigating regressions or recovering a missing V1 behavior. It is not part of the V2 baseline.
