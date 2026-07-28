# Security notes

OpsNest is an Alpha desktop application. This document records the current release posture so users can make an informed decision before connecting real servers.

## Current protections

- Server credentials and AI API keys are stored through the operating-system credential store.
- The local data file does not intentionally contain plaintext server passwords, private keys, or AI API keys.
- Server command output is kept in local logs, with basic redaction before conversation logging.
- AI and mutating operations pass through local application logic; the model does not receive SSH credentials.
- The app does not require an OpsNest cloud backend.
- SSH server keys use trust on first use (TOFU) with the user's standard `~/.ssh/known_hosts` file. A changed key is rejected on later connections.

## Known Alpha limitations

- The first SSH connection automatically records the presented host key. Verify a new server's fingerprint through another trusted channel before entering credentials. The app does not yet provide a fingerprint confirmation or known-hosts management screen.
- The current SSH stack supports RSA private keys through the RustCrypto `rsa` crate. RustSec advisory `RUSTSEC-2023-0071` has no patched release; prefer password or Ed25519-key authentication until the upstream dependency provides a fix.
- The Agent can still generate Shell commands. Review the plan and output before approving changes.
- Server output and selected log/configuration content may be sent to the model provider configured by the user.
- The app has been exercised mainly on Windows x64 and a limited set of Linux-based systems.

## Before production use

Use a test server or a verified backup. Do not use an unreviewed Alpha build for unattended production changes. Before the stable release, the project should add a user-facing host-fingerprint workflow, stronger redaction tests, a documented threat model, and a dependency vulnerability scan in CI.

## Reporting a vulnerability

Please do not publish credentials or an exploitable proof of concept in a public Issue. Report a suspected vulnerability privately through the repository's private contact channel, or open a minimal Issue asking for a private contact method. Include the affected version, operating system, reproduction steps, and impact, with all addresses, tokens, passwords, and logs redacted.
