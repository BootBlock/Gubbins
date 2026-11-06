---
name: drivenet-discovery-sessions
description: "Use this skill to discover running Windows desktop processes and manage Drive.NET sessions. Covers the 'discover' MCP tool (list/filter processes, .NET-only filtering, optional window inventory, optional hierarchy, and Firefox or Electron auto-enrichment) and the 'session' MCP tool (connect, connectNewest/connectLatest, connectWait, reconnect, retarget, disconnect, status, health, and session groups). A session is required before using most other Drive.NET tools. Keywords: Drive.NET, discover, session, connectNewest, connectLatest, connectWait, reconnect, retarget, disconnect, status, health, session group, process, processName, processId, windowTitleRegex, executablePath, commandLineContains, sessionStartWarningMode, hierarchy, windows, HWND, attach, timeoutMs."
argument-hint: "[goal] [optional process name or PID]"
user-invocable: true
---

# Drive.NET Discovery and Sessions

Use this skill when you need to find a running Windows desktop application or connect, retarget, disconnect, check status, or group Drive.NET sessions.

## `discover` Tool

List running processes that have visible windows.

### Parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `filter` | string | No | — | Filter processes by name, process ID, window title or window handle substring (case-insensitive). A filter that names an automation branch, such as `electron` or `firefox`, also matches every process that branch claims. |
| `dotnetOnly` | bool | No | `false` | Only show .NET processes. |
| `includeWindows` | bool | No | `true` for an `electron` or `firefox` filter, otherwise `false` | Include all visible top-level windows owned by each process. An explicit `false` wins, except with `hierarchical=true`, whose nodes always carry their windows. |
| `hierarchical` | bool | No | `false` | Group child processes beneath parents and include ancestor context. |

### Response

```json
[
  {
    "processName": "MyApp",
    "processId": 12345,
    "windowTitle": "My Application",
    "isResponding": true
  }
]
```

When `includeWindows=true` or `hierarchical=true`, the response upgrades to richer process target objects that can include `parentProcessId`, `parentProcessName`, `executablePath`, `startTimeUtc`, `commandLine`, `profileDirectory`, `automationBranch`, `windows` (with per-window `windowHandle` and `windowTitle`), and `children`.

When `filter="firefox"` or `filter="electron"`, Drive.NET returns the richer process-target shape with `automationBranch`, and includes visible `windows` unless `includeWindows=false`. The filter also matches every process the branch claims, so `filter="electron"` finds a packaged Electron app whatever its executable is called: the Electron branch recognises an app by the files Electron installs (`resources\app.asar`, a `resources\app` folder or `resources\default_app.asar`, with `resources.pak`).

## `session` Tool

Connect to, retarget, or disconnect from a target process. The returned `sessionId` is required by nearly all other Drive.NET tools. The same tool also manages session groups for multi-app orchestration.

### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `action` | string | Yes | `"connect"`, `"connectNewest"`, `"connectLatest"`, `"connectWait"`, `"reconnect"`, `"retarget"`, `"disconnect"`, `"status"`, `"health"`, `"createGroup"`, `"addToGroup"`, `"removeFromGroup"`, `"listGroups"`, or `"dissolveGroup"`. |
| `processName` | string | No | Process name (e.g. `"MyApp"`). Optional when another connect filter is provided. |
| `processId` | int | No | Process ID. Alternative to `processName`. Do not combine with `connectNewest` or `connectLatest`. |
| `windowTitleRegex` | string | No | Restrict `connect` or `connectNewest` to processes whose visible windows match this regular expression. |
| `executablePath` | string | No | Restrict `connect` or `connectNewest` to a specific executable path. |
| `commandLineContains` | string | No | Restrict `connect` or `connectNewest` to processes whose command line contains this substring. |
| `sessionStartWarning` | bool | No | Override the session-start warning UI on connect. Omit to use the configured default (enabled by default). |
| `sessionStartWarningMode` | string | No | Warning display mode: `overlay` (the default), `toast` or `persistent`. Providing a mode also enables the warning unless `sessionStartWarning=false` is set. |
| `sessionId` | string | No | Required for disconnect, retarget, status, reconnect, `addToGroup`, or `removeFromGroup`. |
| `windowHandle` | string | No | Required for retarget. For `connect`/`connectNewest`/`connectLatest`, auto-retargets to this window after attaching to its process. Use a top-level handle from `window list`, or a previously saved alias name. |
| `alias` | string | No | Friendly name to assign to the window after retarget (e.g. `"settings"`, `"dialog"`). |
| `groupName` | string | No | Name for `createGroup`. Max 100 characters. |
| `groupId` | string | No | Group ID for `addToGroup`, `removeFromGroup`, or `dissolveGroup`. |
| `role` | string | No | Role label when adding a session to a group (e.g. `"main"`, `"helper"`, `"browser"`). Required for `addToGroup`. |
| `timeoutMs` | int | No | Timeout in milliseconds for `connectWait` (default: 30000, range: 1000–120000). |

### Connect Response

```json
{
  "sessionId": "a1b2c3d4...",
  "processName": "MyApp",
  "processId": 12345,
  "automationBranch": "generic",
  "mainWindowTitle": "My Application - Main Window",
  "mainWindowHandle": "0x12D687",
  "executablePath": "C:\\Apps\\MyApp\\MyApp.exe",
  "profileDirectory": null,
  "processStartTimeUtc": "2026-03-24T10:15:30.0000000+00:00"
}
```

When connecting to a browser process (Firefox, Chrome, Edge, Brave, Vivaldi, Opera), the response also includes `addressBarUrl` if the address bar is accessible via UI Automation. When the address bar is not accessible (e.g. accessibility disabled), Drive.NET attempts keyboard+clipboard URL recovery automatically and returns the result with `addressBarUrlSource: "keyboardClipboard"`. When Drive.NET detects that the browser's accessibility runtime is disabled, a `browserHealth` block is included warning that page content will not be queryable.

When accessibility **is** working (no `browserHealth` block), the response also includes `tabMetadata` with `tabCount` (number of open tabs) and `activeTabTitle` (the selected tab's title).

When the session window renders Chromium content (Electron, CEF, WebView2 or a Chromium browser), Drive.NET sends `WM_GETOBJECT` to each render widget on connect and retarget, as a screen reader does, and waits up to 3 seconds for the web document to expose elements; the app needs no `--force-renderer-accessibility` switch. The `connect` and `status` responses then include `"chromiumAccessibility": { "state": "...", "renderWidgets": 1, "elapsedMs": 120 }`, where `state` is `alreadyActive` (nothing sent), `activated`, `noContent` (no element exposed within 3 seconds) or `noReply` (no render widget answered). With `noContent` or `noReply`, a query may find only the window frame.

### Retarget Response

```json
{
  "success": true,
  "message": "Session 'a1b2c3d4...' retargeted to window 'Settings'.",
  "sessionId": "a1b2c3d4...",
  "mainWindowTitle": "Settings",
  "mainWindowHandle": "0x1A4F",
  "savedAlias": "settings"
}
```

The `savedAlias` field appears only when you pass `alias` during retarget.
Once saved, you can retarget back by passing the alias name as `windowHandle`.

### Status Response

```json
{
  "status": "healthy",
  "sessionId": "a1b2c3d4...",
  "processId": 12345,
  "processName": "MyApp",
  "mainWindowHandle": "0x12D687",
  "mainWindowTitle": "My Application",
  "processAlive": true,
  "mainWindowValid": true
}
```

Possible `status` values: `healthy`, `degraded` (process alive but window invalid), `terminated` (process exited), `notFound` (session ID not recognized). Includes `recoveryHint` and `candidateWindows` when recovery is possible.

When `status` is `terminated`, the response also includes process-exit metadata such as `terminationReason`, `terminatedAt`, optional exit-code fields, and `crashEvidence` when Drive.NET can correlate WER dumps, crash logs, or Windows Application event entries for the target app.

### Health Response

```json
{
  "status": "ok",
  "version": "0.31.0",
  "activeSessions": 2,
  "sessions": [
    { "sessionId": "a1b2c3d4...", "processName": "MyApp", "processId": 12345 },
    { "sessionId": "e5f6a7b8...", "processName": "Notepad", "processId": 67890 }
  ]
}
```

`status` is `ok` when the server is fully operational, or `degraded` when internal services are unavailable (session enumeration may be empty). Unlike `status` (which reports on a single session), `health` is a server-wide liveness probe that does not require a `sessionId` and works even when server services are partially degraded.

### Disconnect Response

```json
{
  "success": true,
  "message": "Session 'a1b2c3d4...' disconnected."
}
```

### Session Group Responses

**createGroup:**

```json
{
  "groupId": "a1b2c3d4...",
  "name": "CrossAppWorkflow",
  "members": []
}
```

**listGroups:**

```json
{
  "groups": [
    {
      "groupId": "a1b2c3d4...",
      "name": "CrossAppWorkflow",
      "members": [
        {
          "sessionId": "sess-1",
          "role": "main",
          "processName": "MyApp",
          "processId": 12345
        }
      ]
    }
  ]
}
```

## Rules

- Use `discover` first when the process name is ambiguous or you need window inventory before attaching.
- If you already have a deterministic PID or a narrow attach filter set, direct `connect` is fine without a prior `discover` call.
- `connect` shows a non-activating warning by default before automation starts. The default `overlay` mode shows the agent's automation overlay, one window per agent that lists its commands and stays while a session is open; it waits 1 second only when it newly appears. Call `overlay action="begin"` before the first command of a piece of work and `overlay action="finish"` after the last, so the overlay stays on screen between sessions and pauses. Set `sessionStartWarningMode="toast"` for a 1-second top-centre countdown, or `sessionStartWarningMode="persistent"` for a bottom-right card that stays visible until the session disconnects. See the `drivenet-overlay` skill.
- Set `sessionStartWarning=false` to skip that warning for a specific session.
- `connectNewest` and `connectLatest` are synonyms. Use them when several matching processes may already be running and you want the newest remaining match after all filters are applied. When the best candidate becomes inaccessible, the next-best match is tried automatically.
- `connectWait` polls for a matching process until one appears or `timeoutMs` expires. Use after launching an app (e.g., via `lifecycle launch`) when the process may not be visible yet. The response includes `waitedMs` and `attempts`.
- `reconnect` disconnects an existing or terminated session and re-attaches to the newest matching process using the original session's connection criteria. Useful after an app restart or crash. Requires `sessionId`.
- `connect` requires at least one attach filter: `processName`, `processId`, `executablePath`, `commandLineContains`, or `windowTitleRegex`.
- Do not combine `processId` with `connectNewest` or `connectLatest`.
- For several CLI follow-up commands against the same process, prefer one `batch` command or a long-lived MCP session instead of repeatedly reconnecting from the executable and paying another 1-second warning delay.
- Use `includeWindows=true` when you need the exact visible HWND/title inventory before choosing a session target.
- Use `hierarchical=true` for multi-process apps so helper windows appear under the right parent process instead of as unrelated flat rows.
- One session per process within a given server, and only one MCP/CLI controller may attach to the same target process at a time. Different VS Code instances can automate different target processes concurrently, but connecting two controllers to the same process is intentionally blocked. The error message is: *"Process '…' (PID …) is already connected by another Drive.NET MCP/CLI controller. Only one controller may attach to the same target process at a time."* This most commonly occurs when an IDE MCP session is active against the same app you are testing from the terminal via `DriveNet.Cli.exe test`. Disconnect the IDE session first.
- Use `retarget` to move an existing session to another top-level window in the same process instead of reconnecting.
- Pass `alias` when retargeting to give the window a friendly name. Use that alias as `windowHandle` later to quickly switch back.
- Use `health` to check server-level status, version, and active sessions without needing a `sessionId`. Health is a liveness probe that works even when server services are partially degraded.
- Use session groups when a workflow spans multiple apps or helper windows that each need their own long-lived session. Max 5 groups, max 10 sessions per group.
- Save the `sessionId` — every other Drive.NET tool requires it.
- Sessions auto-cleanup when the target process exits, and later errors can include that termination reason.
- If `interact`, `wait_for`, `window`, or `batch` reports `processExited: true`, call `session status` on the same `sessionId` before reconnecting. That terminated-session response is the durable agent-facing place to read `crashEvidence` and decide whether the app needs relaunch, triage, or both.
- If multiple processes share a name, use `processId` for disambiguation.
- Firefox and Electron session attaches use dedicated automation branches that adjust window resolution and blocker classification. `discover filter="firefox"` and `discover filter="electron"` also auto-enrich the response with visible windows and match every process their branch claims. `filter="win32"` or `filter="mfc"` does not auto-enrich; it matches Win32-branch processes only in the richer listing (`includeWindows=true` or `hierarchical=true`).
- **VS Code / Electron extension hosts**: VS Code holds a single-instance lock, so a second `Code.exe` instance always fails to start, even with a unique `--user-data-dir`. An Electron app that uses Electron's own `app.requestSingleInstanceLock()` takes the lock per profile folder, so its own `--user-data-dir` starts an isolated instance. Use `connect` with `processName="Code"` and `windowTitleRegex="\\[Extension Development Host\\]"` to attach to an F5-launched host window. See [docs/yaml-test-runner.md — Testing VS Code / Electron Extensions](../../../docs/yaml-test-runner.md#testing-vs-code--electron-extensions) for the full YAML pattern.

Global configuration can disable the default warning via `DriveNet__SessionStartWarning__Enabled=false` and can set the default display mode via `DriveNet__SessionStartWarning__Mode=overlay|toast|persistent` (default: `overlay`).

## Integration Testing Workflow

When automating integration tests against a desktop application:

1. **Discover** the target process to confirm it is running and responsive.
2. **Connect** a session with `processName`, `processId`, or other attach filters.
3. If the app opens a modal dialog or another owned top-level window, call `window list` and then `session retarget` to move the session root when appropriate.
4. Use `batch` with `startDelayMs` to allow the UI to settle after connecting or retargeting.
5. Chain query → interact → wait_for steps in batch for atomic multi-step workflows.
6. Verify results by inspecting saved variables from `save` on query steps.
7. If a step kills the app under test, run `session status` before reconnecting so you preserve `crashEvidence` (dumps, crash logs, Windows Application log entries) for the failed instance.
8. **Disconnect** the session when done (or let it auto-cleanup on process exit).

This pattern minimizes round-trips and keeps the entire test sequence in a single deterministic batch call.
