# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| 2.1.x | ✅ Active |
| 2.0.x | ⚠️ Security fixes only |
| 1.x | ❌ End of life |

## Reporting a Vulnerability

If you discover a security vulnerability in PunamIDE, **do not open a public GitHub issue**.

Report it privately by emailing the maintainer directly (see GitHub profile). Include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix if you have one

You will receive a response within 72 hours. If confirmed, a patch will be released as soon as possible and you will be credited in the changelog.

## Security Model

PunamIDE is a desktop application. Key security considerations:

- **API keys** are stored via `tauri-plugin-store` in the OS app data directory, not in plain files or environment variables
- **CSP** is enforced in `tauri.conf.json` — only whitelisted AI provider domains are permitted for network requests
- **File system access** — all Rust file operations go through `safety.rs` path validation to prevent path traversal
- **Agent tool calls** — the `AgentApplyGuard` validates all AI-proposed file writes against architecture rules before applying
- **No telemetry** — PunamIDE does not collect or transmit usage data (Sentry is opt-in for error reporting only)
