---
name: drivenet-overlay
description: "Use this skill whenever an agent drives an application with Drive.NET, to keep the automation overlay on screen for the whole piece of work with begin and finish, and to show progress on it, move it or close it. Covers the 'overlay' MCP tool and the CLI 'overlay' command for begin, plan, step, move, finish, and status, the hold that keeps the overlay visible between commands, the overlay's placement precedence, what the command list shows, and the 'overlay', 'toast' and 'persistent' session-start warning modes. Keywords: Drive.NET, overlay, automation overlay, begin, hold, held, flicker, disappears, progress, plan, step, move, finish, status, corner, monitor, placedBy, holdIdleSeconds, sessionStartWarningMode, session-start-warning-mode, DRIVENET_AGENT_ID, DriveNet.Overlay.exe."
argument-hint: "[goal] [begin, plan, step, move, finish, or status]"
user-invocable: true
---

# Drive.NET Automation Overlay

Use this skill every time you drive an application, so the user sees one overlay for the whole piece of work. Use it also when the user should see how far through the work you are, or when the overlay sits in the wrong place.

The automation overlay is the default session-start warning mode (`overlay`). It appears on its own when a session connects or a launch starts: one small window per agent that lists each command the agent sends to Drive.NET. The `overlay` tool does not need a session.

## Workflow (Every Piece of Work)

1. **Begin.** Before the first command that drives an application, call `overlay action="begin" label="<what the work is>"`, or `DriveNet.Cli.exe overlay --action begin --label "<what the work is>"`. When you know how many commands the work takes, call `plan` with `total` instead: it holds the overlay in the same way and adds a progress bar.
2. **Drive.** Send the commands. The overlay stays on screen between them, however long you pause to think, build, read output or edit code.
3. **Finish.** After the last command, call `overlay action="finish"` or `DriveNet.Cli.exe overlay --action finish`. Call it also when the work stops early on an error, before you report back.

Why: without a hold, the overlay closes a few seconds after the agent's last session ends. Each CLI command opens and closes its own session, and an agent pauses between bursts of commands, so the overlay disappears and appears again, and each new appearance costs the 1-second warning again.

The hold also ends when the agent process exits, or when the agent sends nothing to Drive.NET for the user's idle limit (`holdIdleSeconds`, 10 minutes by default). These limits only stop a forgotten hold from staying forever. Always call `finish`.

A new piece of work after `finish` starts again at step 1. To change the label during the work, call `begin` again with the new label.

## `overlay` Tool

### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `action` | string | Yes | `begin`, `plan`, `step`, `move`, `finish`, or `status`. |
| `total` | int | For `plan` | The number of commands the work will take. `0` clears the plan and keeps the hold. |
| `completed` | int | No | For `step`: the number of planned commands done. Omit to advance by one. |
| `label` | string | No | For `begin`, `plan` and `step`: a short description shown beside the progress bar. |
| `corner` | string | For `move` | `bottomRight`, `topRight`, `bottomLeft`, `topLeft`, or `auto` for the automatic place. |
| `monitor` | int | No | For `move`: `0` is the primary monitor, the others follow from left to right. Omit for the target's monitor. |

```text
overlay action="begin" label="Verify the settings page"
overlay action="plan" total=8 label="Export the monthly report"
overlay action="step"
overlay action="step" completed=6 label="Checking the totals"
overlay action="move" corner="topLeft"
overlay action="move" corner="auto"
overlay action="status"
overlay action="finish"
```

The response is `{ action, overlay: { visible, placedBy, monitor, corner, left, top, width, height, activeActivities, held, planCompleted, planTotal }, note }`. `held` is true while a `begin` or a `plan` holds the overlay. `placedBy` is `user`, `settings`, `agent`, or `automatic`. `note` appears only when the configured warning mode keeps the overlay off. An error returns `{ error }`.

The CLI equivalent is `DriveNet.Cli.exe overlay --action begin --label "Verify the settings page"`, with `--total`, `--completed`, `--corner`, `--monitor` and `--json`. The CLI and the MCP server of one agent share one overlay, so a hold from either keeps it on screen for both.

## Rules

- Follow the workflow above for every piece of work, through the MCP server or the CLI.
- Calls to `overlay` are not listed on the overlay and do not count as plan steps.
- A `batch` or YAML test run shows its own "step N of M" progress, with its steps indented under it, so a plan is not needed for one batch. Still `begin` and `finish` around the work, so the overlay stays between the batch and the commands before and after it.
- `move` loses to a position the user dragged the overlay to and to a fixed corner chosen in the Helper's Settings page. Check `placedBy` with `status` before trying again.
- Leave placement automatic unless the overlay is in the way: it takes the monitor corner that covers the least of the target window and follows the target when it moves.
- The overlay shows only identifying arguments, such as `automationId` and `name`. Text arguments (`value`, `text`, `keys`, `sendKeys`, `expected`, `secret`, `password`) show only their length, such as `value=(12 chars)`.
- An agent's MCP server and its CLI commands share one overlay, because the agent is the nearest ancestor process that is not a shell. Set `DRIVENET_AGENT_ID` to choose the identity yourself. With `DRIVENET_AGENT_ID` set, Drive.NET cannot watch the agent process, so only `finish` and the idle limit end a hold.

## Warning Modes

| Mode | Behaviour |
|---|---|
| `overlay` | Default. One window per agent that stays while a session is open or a `begin` or `plan` holds it. It waits 1 second only when it newly appears, so later sessions and CLI commands start at once. Falls back to the toast when `DriveNet.Overlay.exe` cannot be found or started. |
| `toast` | A 1-second top-centre countdown before each session. |
| `persistent` | A bottom-right card for each session that stays until the session disconnects. |

Choose a mode with `sessionStartWarningMode` on `session` `connect` and `lifecycle` `launch`, `--session-start-warning-mode` in the CLI, `session_start_warning_mode` in YAML suites, or `DriveNet__SessionStartWarning__Mode` for the default. `--continuation` matters only with `toast` or `persistent`.
