---
name: drivenet-desktop
description: "Use this skill to query OS-level desktop state with Drive.NET. Covers the 'desktop' MCP tool for monitor inventories, working-area and DPI scale checks, foreground-window verification, and cross-process top-level window snapshots that help guide later window, query, capture, or interaction steps. Keywords: Drive.NET, desktop, monitors, workingArea, DPI, foregroundWindow, topLevelWindows, desktop state, focus, window handle, monitor bounds, snapshot."
argument-hint: "[goal] [monitors, foreground window, or top-level windows]"
user-invocable: true
---

# Drive.NET Desktop Metrics

Use this skill when you need desktop-wide context before targeting a specific application window.

## `desktop` Tool

The `desktop` tool is read-only and does not require a session.

### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `action` | string | Yes | `monitors`, `foregroundWindow`, or `topLevelWindows`. |

## Actions

### `monitors`

Return connected-monitor bounds, working area, primary-monitor flag, and DPI scale.

```text
desktop action="monitors"
```

Use this before `window move` or `window resize` when multi-monitor layout or reserved work area can affect placement.

### `foregroundWindow`

Return the currently active top-level window.

```text
desktop action="foregroundWindow"
```

The response can include `windowHandle`, `title`, `processId`, and `processName`. If no foreground window can be resolved, Drive.NET returns `foregroundWindow: null` and a note.

### `topLevelWindows`

Return a cross-process snapshot of visible top-level windows on the desktop.

```text
desktop action="topLevelWindows"
```

The response includes `timestamp`, `windowCount`, and a `windows` array with each visible window's `windowHandle`, `title`, `processId`, and `processName`.

## Rules

- Use `monitors` when layout decisions depend on full monitor bounds versus working area.
- `workingArea` reflects taskbar or AppBar reserved space; `bounds` reflects the full monitor rectangle.
- Use `foregroundWindow` before window-level `interact sendKeys` or `interact type` when focus correctness matters.
- Reuse `windowHandle` values from `foregroundWindow` or `topLevelWindows` with `window`, `query`, or `capture` when you need to target that exact surface.
- Use `topLevelWindows` when you need a cross-process before/after snapshot instead of a single-process `window list` response.
- If you already know the target process and only care about its windows, prefer the `window` tool over `desktop topLevelWindows`.

## Common Patterns

### Verify The Correct Window Has Focus Before Sending Keystrokes

```text
desktop action="foregroundWindow"
window action="bringToFront" sessionId="session-1" windowHandle="0x1A4F"
desktop action="foregroundWindow"
```

### Compare Desktop State Before And After Launching An External App

```text
desktop action="topLevelWindows"
lifecycle action="launch" executablePath="C:\Apps\MyApp.exe" startupWaitMs=10000
desktop action="topLevelWindows"
```

### Check Monitor Work Area Before Docking A Window

```text
desktop action="monitors"
window action="move" sessionId="session-1" windowHandle="0x1A4F" x=0 y=0
```