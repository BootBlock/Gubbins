---
name: drivenet-secret
description: "Use this skill to manage secure typed secrets with Drive.NET. Covers the 'secret' MCP tool for register, revoke, and revokeAll, plus secure `interact type` usage with `secret:` references, window-level typing, batch reuse, and cleanup patterns that keep plaintext out of logs, responses, and artifacts. Keywords: Drive.NET, secret, secure typing, password, token, api key, register, revoke, revokeAll, interact type, redaction, credential, batch, window-level typing."
argument-hint: "[goal] [what secret is being used] [where it must be typed]"
user-invocable: true
---

# Drive.NET Secrets

Use this skill when the workflow must type passwords, tokens, API keys, or other sensitive values without exposing plaintext in tool responses or saved artifacts.

## `secret` Tool

Register a secret in memory, use the returned `referenceId` with `interact action="type"`, then revoke it when the workflow finishes.

### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `action` | string | Yes | `register`, `revoke`, or `revokeAll`. |
| `value` | string | For `register` | Secret plaintext to store in memory. Never echoed back. |
| `referenceId` | string | For `revoke` | Secret reference returned by `register`. |

### Responses

- `register` returns `success`, `referenceId`, and a message.
- `revoke` returns `success` and a message.
- `revokeAll` returns `success` and a message.

### Examples

```text
secret action="register" value="fictional-password-123"
secret action="revoke" referenceId="secret:abc123..."
secret action="revokeAll"
```

## Use With `interact type`

Pass the `secret:` reference as the `value` of `interact action="type"`. Drive.NET resolves the reference at typing time and redacts the typed value in responses.

```text
secret action="register" value="fictional-password-123"
interact sessionId="session-1" action="type" elementId="e_password" value="secret:abc123..."
interact sessionId="session-1" action="type" value="secret:abc123..." windowHandle="0x1A4F"
secret action="revoke" referenceId="secret:abc123..."
```

The same `secret:` reference works for element-targeted typing and window-level typing when neither `elementId` nor a selector field is provided.

## Rules

- Use raw `secret register` before the first secure type action. The plaintext is kept in memory only.
- Treat `referenceId` as transient. It is valid only while the current server process remains alive.
- Secrets are automatically lost on server restart and automatically cleared on server shutdown.
- Use `revoke` when one secret is done and `revokeAll` when the whole workflow is complete.
- Reading the field back, with `query action="properties"` for example, returns `[REDACTED]`. Assert on that, never on the plaintext.
- Prefer the `secret` MCP tool for agent-driven flows that already have the secret value in memory.
- For terminal-only CLI flows, `DriveNet.Cli.exe interact --secret` reads the typed value from stdin instead of using the MCP secret store.
- Batch steps can reuse a registered `secret:` reference by passing it as the `value` of an `interact` `type` step.
- Keep secret references out of long-lived notes or checked-in fixtures even though the plaintext is redacted.

## Common Patterns

### Secure Login Flow

```text
secret action="register" value="fictional-password-123"
interact sessionId="session-1" action="type" elementId="e_username" value="fictional.user@example.test"
interact sessionId="session-1" action="type" elementId="e_password" value="secret:abc123..."
interact sessionId="session-1" action="click" elementId="e_signIn"
secret action="revokeAll"
```

### Type A Token Into A Browser Or Canvas Surface

```text
secret action="register" value="fictional-api-token-123"
window sessionId="session-1" action="bringToFront" windowHandle="0x1A4F"
interact sessionId="session-1" action="type" value="secret:abc123..." windowHandle="0x1A4F"
secret action="revokeAll"
```