---
name: drivenet-lifecycle
description: "Use this skill to launch, stop, and poll target applications with Drive.NET. Covers the 'lifecycle' MCP tool for `launch`, `stop`, and `status`, including startupWaitMs, singleInstance reuse or restart, pre-launch sessionStartWarning control, sessionStartWarningMode selection, graceful shutdown, and pairing launch flows with `session connectWait` or `session reconnect`. Keywords: Drive.NET, lifecycle, launch, stop, status, startupWaitMs, singleInstance, reuse, restart, sessionStartWarning, sessionStartWarningMode, gracePeriodMs, connectWait, reconnect, process control."
argument-hint: "[goal] [launch, stop, or status] [target app or process]"
user-invocable: true
---

# Drive.NET Application Lifecycle

Use this skill when Drive.NET should own application startup, shutdown, or liveness checks instead of assuming the target process already exists.

## `lifecycle` Tool

### Parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `action` | string | Yes | - | `launch`, `stop`, or `status`. |
| `executablePath` | string | For `launch` | - | Absolute path to the `.exe` to launch. |
| `arguments` | string | No | - | Command-line arguments passed to the launched process. |
| `workingDirectory` | string | No | - | Working directory for the launched process. |
| `startupWaitMs` | int | No | `5000` | Milliseconds to wait for the main window after launch. |
| `singleInstance` | string | No | - | `reuse` or `restart`. |
| `processName` | string | No | exe name | Family match key used with `singleInstance`. |
| `sessionStartWarning` | bool | No | config default | Override the pre-launch automation warning for this call. |
| `sessionStartWarningMode` | string | No | config default | Warning display mode: `overlay` (the default), `toast` or `persistent`. Providing a mode also enables the warning unless `sessionStartWarning=false` is set. |
| `processId` | int | For `stop`/`status` | - | Target process ID. |
| `gracePeriodMs` | int | No | `5000` | Grace period before force-kill during `stop`, shared by the close messages. `0` force-kills at once. |

## Actions

### `launch`

Start a new process or reuse or restart an existing family member.

```text
lifecycle action="launch" executablePath="C:\Apps\MyApp.exe" startupWaitMs=10000
lifecycle action="launch" executablePath="C:\Apps\MyApp.exe" arguments="--debug" workingDirectory="C:\Apps"
lifecycle action="launch" executablePath="C:\Apps\MyApp.exe" singleInstance="reuse" processName="MyApp"
lifecycle action="launch" executablePath="C:\Apps\MyApp.exe" singleInstance="restart" processName="MyApp"
lifecycle action="launch" executablePath="C:\Apps\MyApp.exe" sessionStartWarning=false
lifecycle action="launch" executablePath="C:\Apps\MyApp.exe" sessionStartWarningMode="persistent"
```

`launch` returns fields such as `processId`, `processName`, `mainWindowHandle`, and `reused`.

### `status`

Check whether a process is still running and responsive.

```text
lifecycle action="status" processId=12345
```

The response can include `isRunning`, `isResponding`, `hasMainWindow`, `mainWindowTitle`, and `processName`.

### `stop`

Post `WM_CLOSE` to every visible top-level window for the first half of the grace period, then send `WM_QUERYENDSESSION` and `WM_ENDSESSION` to every top-level window for the rest, then force-kill. The response reports each attempt in `attempts`, the method that ended the process in `stoppedBy`, and a `warning` after a forced kill, which skips the app's own save on exit.

```text
lifecycle action="stop" processId=12345 gracePeriodMs=3000
```

## Rules

- Use `singleInstance="reuse"` when the workflow should attach to an existing instance instead of opening a duplicate.
- Use `singleInstance="restart"` when the workflow needs a clean process state before automation starts.
- **VS Code limitation**: VS Code holds a single-instance lock that a second `Code.exe` cannot pass, even with a unique `--user-data-dir`; the launch fails with `Error mutex already exists` and a renderer crash. Do not use `lifecycle launch` for VS Code instances. Instead, spawn the Extension Development Host via F5 and use `session connect` with `windowTitleRegex="\\[Extension Development Host\\]"`.
- An Electron app that uses Electron's own `app.requestSingleInstanceLock()` takes the lock per profile folder, so launching it with its own `--user-data-dir` in `arguments` starts an isolated instance.
- The launched app gets the NUL device as its standard input, output and error and inherits no other handle from Drive.NET, so its console output never reaches the caller's output or the MCP server's stream.
- Pair `lifecycle launch` with `session connectWait` when the app takes time to create a visible main window.
- `sessionStartWarning` and `sessionStartWarningMode` control the same safety notice used by Drive.NET session attach flows.
- The default `overlay` mode shows the agent's automation overlay, which waits 1 second only when it newly appears. It stays between commands only while `overlay action="begin"` (or `plan`) holds it, until `overlay action="finish"`; see the `drivenet-overlay` skill. `toast` uses a 1-second top-centre warning, and `persistent` shows a bottom-right card for the duration of the launch action.
- Use only direct `.exe` paths. Shell commands such as `cmd /c` or `powershell -c` are intentionally not allowed.
- Use `status` after a long-running workflow when the app may have exited or hung.
- After `stop`, read `stoppedBy`: `kill` means the app's own save on exit did not run, and `attempts` shows which close messages reached which windows. Give an app that saves state on shutdown a longer `gracePeriodMs`.
- Prefer `session reconnect` when the session already exists and the app has restarted under the same connection criteria.

## Common Patterns

### Launch Then Connect Once The UI Is Ready

```text
lifecycle action="launch" executablePath="C:\Apps\MyApp.exe" startupWaitMs=10000
session action="connectWait" processName="MyApp" timeoutMs=30000
```

### Reuse A Running Instance Without Creating Duplicates

```text
lifecycle action="launch" executablePath="C:\Apps\MyApp.exe" singleInstance="reuse" processName="MyApp"
session action="connect" processName="MyApp"
```

### Restart To A Clean State

```text
lifecycle action="launch" executablePath="C:\Apps\MyApp.exe" singleInstance="restart" processName="MyApp"
session action="connectWait" processName="MyApp" timeoutMs=30000
```

### Stop The App After Automation Completes

```text
lifecycle action="stop" processId=12345 gracePeriodMs=3000
```