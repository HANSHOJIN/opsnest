# Third-party notices

OpsNest uses the following direct dependencies and referenced assets. Their copyright and license terms remain with their respective authors. Versions below are the versions resolved in the current lockfiles.

## Frontend and desktop dependencies

| Component | Resolved version | License | Project |
| --- | ---: | --- | --- |
| Tauri / `@tauri-apps/api` / Tauri CLI | 2.11.x | Apache-2.0 OR MIT | <https://github.com/tauri-apps/tauri> |
| React / React DOM | 18.3.1 | MIT | <https://github.com/facebook/react> |
| xterm.js / fit addon | 6.0.0 / 0.11.0 | MIT | <https://github.com/xtermjs/xterm.js> |
| Simple Icons | 16.27.0 | CC0 1.0 | <https://github.com/simple-icons/simple-icons> |
| Vite | 5.4.x | MIT | <https://github.com/vitejs/vite> |
| TypeScript | 5.9.x | Apache-2.0 | <https://github.com/microsoft/TypeScript> |

OpsNest uses Simple Icons for operating-system, Docker, database, runtime, and service glyphs. Simple Icons are released under CC0 1.0; individual brand names and marks remain the property of their respective owners. Their appearance in OpsNest does not imply endorsement.

## Rust dependencies

| Crate | Resolved version | License | Project |
| --- | ---: | --- | --- |
| `tauri` / `tauri-build` | 2.x | Apache-2.0 OR MIT | <https://github.com/tauri-apps/tauri> |
| `russh` | 0.62.4 | Apache-2.0 | <https://github.com/warp-tech/russh> |
| `keyring` | 3.6.3 | MIT OR Apache-2.0 | <https://github.com/hwchen/keyring-rs> |
| `reqwest` | 0.12.x | MIT OR Apache-2.0 | <https://github.com/seanmonstar/reqwest> |
| `serde` / `serde_json` | 1.x | MIT OR Apache-2.0 | <https://github.com/serde-rs/serde> |
| `tokio` | 1.x | MIT | <https://github.com/tokio-rs/tokio> |
| `urlencoding` | 2.1.3 | MIT | <https://github.com/kornelski/rust_urlencoding> |

The complete transitive dependency set is recorded in `package-lock.json` and `src-tauri/Cargo.lock`. Re-run the license review after dependency updates.

## Recommended external service

[FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) is an independent third-party project recommended as an OpenAI-compatible model endpoint. It is not bundled with OpsNest. Its license, provider terms, quotas, and privacy behavior are governed by its own project and deployment.

## OpsNest assets

The OpsNest name, application icon, UI, source code, documentation, and demo screenshots are project assets unless a file states otherwise. Brand names shown in service discovery belong to their respective owners.
