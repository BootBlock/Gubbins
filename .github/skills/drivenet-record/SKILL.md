---
name: drivenet-record
description: "Use this skill to record live Drive.NET workflows into reusable assets. Covers the 'record' MCP tool for start, stop, and status, output formats `batch_json` and `yaml_suite`, suiteName and appProcessName for YAML generation, automatic wait coalescing, secret redaction, and replay paths through `playback` or `test`. Keywords: Drive.NET, record, recording, batch_json, yaml_suite, playback, test, suiteName, appProcessName, redaction, automation capture, reusable workflow."
argument-hint: "[goal] [recorded workflow type] [target session]"
user-invocable: true
---

# Drive.NET Recording

Use this skill when you want to capture a live agent workflow first, then refine the generated automation file afterward.

## `record` Tool

While recording is active on a session, Drive.NET captures `query`, `interact`, and `wait_for` calls for that session. `stop` returns the generated script.

### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `action` | string | Yes | `start`, `stop`, or `status`. |
| `sessionId` | string | For `start` | Session to record. |
| `format` | string | No | `batch_json` or `yaml_suite`. Defaults to `batch_json`. |
| `suiteName` | string | No | Suite name used for YAML output. |
| `appProcessName` | string | No | Process name used for the YAML `app` block. |
| `recordingId` | string | For `stop`/`status` | Recording ID returned by `start`. |

## Examples

```text
record action="start" sessionId="session-1"
record action="start" sessionId="session-1" format="yaml_suite" suiteName="Login Flow" appProcessName="MyApp"
record action="status" recordingId="rec:abc123..."
record action="stop" recordingId="rec:abc123..."
```

## Rules

- One recording can be active per session at a time.
- Max 500 steps are retained. Additional steps are dropped.
- Duplicate consecutive `wait_for` steps are automatically coalesced.
- Registered secrets are emitted as `[REDACTED]` instead of plaintext.
- Use `format="batch_json"` when the replay target is `playback` or low-level `batch`.
- Use `format="yaml_suite"` when the output should become a durable YAML test asset for `test`.
- Provide `appProcessName` with `yaml_suite` so the generated suite can include an `app` block.
- Query results whose element IDs are reused later automatically get meaningful saved variable names.

## Common Patterns

### Record A Short MCP Workflow

```text
record action="start" sessionId="session-1"
interact sessionId="session-1" action="click" elementId="e_open"
query sessionId="session-1" action="find" by='{"automationId":"txtName"}'
interact sessionId="session-1" action="type" elementId="e_name" value="fictional user"
record action="stop" recordingId="rec:abc123..."
```

### Record A YAML Test Suite Starter

```text
record action="start" sessionId="session-1" format="yaml_suite" suiteName="Settings Flow" appProcessName="MyApp"
interact sessionId="session-1" action="click" elementId="e_settings"
wait_for sessionId="session-1" condition="elementExists" automationId="SettingsDialog" timeoutMs=5000
record action="stop" recordingId="rec:abc123..."
```

### Replay Or Refine The Result

- Use `playback --input ...` for the simplest CLI rerun path.
- Use `test --manifest ...` when the generated YAML suite becomes part of a broader deterministic test run.
- Review the generated steps before checking them in. Recording is a strong starting point, not a substitute for final selector curation.