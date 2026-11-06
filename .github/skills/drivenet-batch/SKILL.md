---
name: drivenet-batch
description: "Use this skill to execute multi-step UI automation sequences atomically through Drive.NET. Covers the 'batch' MCP tool which chains query, interact, wait_for, assert, and report steps with variable binding (saveAs, save, ${name} references), timing control (startDelayMs, endDelayMs, delayBeforeMs, delayAfterMs), conditional execution (`when`), retries, per-step session overrides, per-step error handling, and held pointer and key input via mouseDown, mouseUp, keyDown and keyUp. Keywords: Drive.NET, batch, multi-step, form fill, automation, saveAs, save, variable, chain, sequence, atomic, assert, report, steps, delay, timing, integration test, dialog, wizard, retry, when, continueOnError, explain, mouseDown, mouseUp, keyDown, keyUp, pointerPath."
argument-hint: "[goal] [sequence of actions to batch]"
user-invocable: true
---

# Drive.NET Batch Automation

Use this skill when you need to execute a deterministic sequence of query, interact, wait_for, assert, and report steps in a single atomic call.

## `batch` Tool

On Windows PowerShell, prefer `--steps-file` for anything non-trivial. If you do use inline `--steps`, wrap the JSON array in single quotes so PowerShell preserves the embedded double quotes and `${name}` references.

### Parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `sessionId` | string | Yes | - | Session ID from `session connect`. |
| `steps` | string | Yes | - | JSON array of step objects (max 100). |
| `stopOnError` | bool | No | `true` | Stop execution on first error. |
| `delayBetweenMs` | int | No | `0` | Delay between steps in ms (max: 60000). |
| `startDelayMs` | int | No | `0` | Delay in ms before the first step executes (max: 60000). Use to let the UI settle after a session connect. |
| `endDelayMs` | int | No | `0` | Delay in ms after the last step completes (max: 60000). Use to allow UI state to finalize before the response. |

## Step Format

Each step is a JSON object with a `tool` field (`"query"`, `"interact"`, `"wait_for"`, `"assert"`, or `"report"`) plus the batch-supported subset of the corresponding tool's parameters. `query`, `wait_for`, `assert`, and `report` stay close to the standalone tools. `interact` steps use the core action inputs shown below, but not every MCP-only diagnostic option is available inside batch. A `report` step runs the Automation Readiness and Accessibility Compliance analysis pipeline and returns score, tier, and finding counts.

Each step can also include:

- `sessionId`: override the batch-level session for this step, including `${variable}` references, when one batch needs to coordinate multiple connected apps.
- `comment`: optional free-text note for humans reviewing the batch definition. Ignored by execution.
- `when`: condition object with `variable`, plus optional `exists`, `equals`, or `notEquals`
- `retry`: policy object with `maxAttempts`, optional `delayMs`, and optional `backoffMs`
- `continueOnError`: keep the batch running after this step fails even when batch-level `stopOnError` remains `true`

### Per-Step Timing Control

Any step can include `delayBeforeMs` and/or `delayAfterMs` for fine-grained timing:

```json
{ "tool": "interact", "action": "click", "elementId": "${btn}", "delayBeforeMs": 200 }
{ "tool": "wait_for", "condition": "elementExists", "automationId": "panel", "delayAfterMs": 500 }
```

- `delayBeforeMs` — pause before this step executes (max: 60000).
- `delayAfterMs` — pause after this step completes (max: 60000).
- These combine with the global `delayBetweenMs` (per-step delays fire first, then the global delay).

### Timing Execution Order

For each step, timing applies in this order:
1. `startDelayMs` (once, before the very first step)
2. Per-step `delayBeforeMs`
3. Step execution
4. Per-step `delayAfterMs`
5. Global `delayBetweenMs` (between steps, not after the last)
6. `endDelayMs` (once, after the very last step)

### Query Steps

Query steps support `action` values: `find`, `resolve`, `explain`, `tree`, `properties`, `bounds`, `children`, `parent`, `gridData`.

For `find` or `explain` steps, use search criteria either via `by` (JSON object), direct flat fields (`automationId`, `name`, `controlType`, `className`), or `path`. Do not mix `path` with flat selectors.

For `tree` steps, `maxNodes` bounds the returned node count in-band. When the result is truncated, the payload includes `nodeCount`, `truncated`, `maxNodes`, and `continuationHints` so later steps can pivot to a smaller subtree.

**`saveAs`** — saves the first matched element's `elementId` as a named variable:

```json
{ "tool": "query", "action": "find", "automationId": "txtName", "saveAs": "name_field" }
```

The saved value is referenced in later steps as `${name_field}`.

**Cross-session query step:**

```json
{
  "tool": "query",
  "sessionId": "${helperSessionId}",
  "comment": "Resolve the helper-side button through the helper session.",
  "action": "resolve",
  "automationId": "CopyButton",
  "saveAs": "helper_copy_button"
}
```

Use per-step `sessionId` only on the MCP `batch` surface, where multiple connected sessions can already exist.

For selectors that should resolve to exactly one current element after a UI refresh, use `action: "resolve"` instead of `find`.

**`save`** — extracts arbitrary result fields by JSON path into named variables:

```json
{
  "tool": "query", "action": "find", "automationId": "lblStatus",
  "save": { "statusText": "items[0].name", "statusId": "items[0].elementId" }
}
```

Variable names must start with a letter and contain only letters, digits, `_`, or `-` (max 64 chars).

Use `action: "bounds"` when later steps need screen coordinates instead of an element id, for example saving `clickablePoint.x` and `clickablePoint.y` for a held-button picker or a raw pointer move.

**Diagnostics-first query step:**

```json
{
  "tool": "query",
  "action": "explain",
  "path": "Pane[automationId=MainPanel] > Button[name=Save]"
}
```

### Interact Steps

Most batch `interact` steps target an `elementId` saved from an earlier `query` step. Reference saved element IDs with `${variableName}`:

```json
{ "tool": "interact", "action": "type", "elementId": "${name_field}", "value": "Alice" }
```

Batch also supports window-level `sendKeys` and `type`, clipboard actions, `mouseDown`, `mouseUp`, `mouseMove`, `keyDown`, `keyUp`, and `pointerPath` for multi-waypoint pointer traces.

Batch also supports `moveTo` with `position`, `offsetPx`, optional `durationMs`, and optional `motionProfile` / `motionExaggeration`, while `hover` accepts `dwellMs` plus optional `hoverMode`, `approachFrom`, `velocityMs`, `motionProfile`, and `motionExaggeration`.

Generic held-button drags are validated on plain WinUI pointer surfaces, but popup-hosted flyouts can still apply app-specific release or capture logic on `mouseUp`. For popup drags, add follow-up `window` or popup-rooted `query` steps after release instead of assuming the held drag persisted.

The `mouseMove` action works without an `elementId` and accepts screen coordinates plus optional motion controls:

```json
{ "tool": "interact", "action": "mouseMove", "destinationX": 500, "destinationY": 300, "mouseButton": "left", "durationMs": 1400, "motionProfile": "exaggerated", "motionExaggeration": 85 }
```

The `mouseDown` and `mouseUp` actions also work without an `elementId`, which is useful for held-button workflows such as crosshair pickers or multi-step drags:

```json
{ "tool": "interact", "action": "mouseDown", "mouseButton": "left" }
{ "tool": "interact", "action": "mouseUp", "destinationX": 920, "destinationY": 460, "mouseButton": "left" }
```

After `mouseDown`, a `mouseMove` or `pointerPath` step with the same `mouseButton` keeps the button held, so a drag spans several steps until `mouseUp`; with the button up, the move presses it at the start and releases it at the end. `keyDown` and `keyUp` hold and release `keys` such as `"Ctrl"` around a drag (`${var}` substitution applies). The session releases any button or key still held when it ends.

```json
{ "tool": "interact", "action": "keyDown", "keys": "Ctrl" }
{ "tool": "interact", "action": "keyUp", "keys": "Ctrl" }
```

The `pointerPath` action scripts a multi-waypoint pointer trace with optional per-waypoint dwell:

```json
{
  "tool": "interact",
  "action": "pointerPath",
  "mouseButton": "left",
  "waypoints": [
    { "x": 420, "y": 180, "durationMs": 300 },
    { "x": 520, "y": 180, "durationMs": 450, "dwellMs": 150 }
  ]
}
```

The `moveTo` action uses semantic positions relative to an element and can keep a steadier profile:

```json
{ "tool": "interact", "action": "moveTo", "elementId": "${menu}", "position": "outside-right", "offsetPx": 24, "durationMs": 400, "motionProfile": "steady" }
```

`pointerPath` also accepts `motionProfile` and `motionExaggeration`, which Drive.NET applies to each segment between waypoints. It presses `mouseButton` once for the whole path and releases it once at the end.

For `hover`, the default movement is edge-aware, including the smooth exit plus horizontal re-approach used for top-edge appbar targets. Batch hover results stay lightweight step messages. If you need richer MCP `interact` diagnostics such as `sameWindowEffect`, `effectObservation`, `replacedWindowPairs`, or `windowTimeline`, use the standalone `interact` tool instead of `batch`.

The `sendKeys` and `type` actions can also work without `elementId` or selector fields to send input directly to the foreground window:

```json
{ "tool": "interact", "action": "sendKeys", "keys": "Ctrl+Shift+K" }
{ "tool": "interact", "action": "type", "value": "console.log('hello')" }
```

When neither `elementId` nor a selector field is provided, the session's main window (or an explicit `windowHandle`) receives focus before input is sent. This is useful for browser content areas and other surfaces without UIA elements.

For `type`, registered secret references such as `secret:...` are resolved before typing, including window-level typing when neither `elementId` nor a selector field is provided.

Batching same-process work is also the preferred way to avoid repeated CLI re-attach overhead, and, with the `toast` or `persistent` warning mode, repeated 1-second session-start warnings across follow-up actions. On the automation overlay, each batch step appears indented under the batch, and the progress bar shows "step N of M". Call `overlay action="begin"` before the work and `overlay action="finish"` after it, so the overlay also stays between the batch and the commands around it.

### Wait Steps

Same conditions as the standalone `wait_for` tool:

```json
{ "tool": "wait_for", "condition": "elementExists", "automationId": "lblSuccess" }
```

Inside `batch`, wait steps use the shared MCP/server wait contract directly. In practice:

- Selector-driven waits are the right fit for `elementExists`, `elementRemoved`, `windowOpened`, `windowClosed`, and `structureChanged`.
- State checks against an existing element such as `elementVisible`, `elementEnabled`, `textEquals`, and `propertyChanged` should usually use an `elementId`, typically saved from an earlier `query` step.
- If the UI rebuilds the control you care about, do not keep polling a stale `elementId`. Re-run `query find` or `query resolve` with `retry`, then assert on the freshly resolved element or on a stable downstream signal.

If an `interact` or `wait_for` step causes the target process to exit, the batch aborts remaining steps and marks the triggering step with `processExited` metadata. The top-level batch response also appends `processExited`, `terminationReason`, optional exit-code fields, and `crashEvidence` when Drive.NET can correlate target-app dumps, crash logs, or Windows Application event entries.

When a batch response includes `processExited: true`, do not retry the dead session. Call `session status` with the same `sessionId` to retrieve the durable `crashEvidence` block, then relaunch or `reconnect` only after you have captured the failure context.

Wait steps support `save` to capture result fields into variables for later steps, for example saving the handle of a newly opened popup window:

```json
{
  "tool": "wait_for", "condition": "windowOpened", "ownerHandle": "${mainWindow}",
  "save": { "popupHandle": "changedWindow.windowHandle" }
}
```

Wait steps also support `ownerHandle` to filter `windowOpened`/`windowClosed` to popup or flyout windows owned by a specific parent.

### Assert Steps

Use `assert` steps when the workflow should fail on an unmet UI expectation instead of just capturing state for later inspection.

```json
{ "tool": "assert", "clauses": [{ "automationId": "lblStatus", "condition": "textEquals", "expected": "Saved" }] }
```

Assert steps are a better fit than ad hoc post-processing when the batch itself should be the source of truth for pass/fail. Prefer `expected` in assert clauses; `expectedValue` is also accepted in batch clause JSON for compatibility with older examples.

### Conditional And Retry Controls

Use `when` when later steps should run only if an earlier outcome or saved variable says they should. Use `retry` when a step is expected to succeed eventually without changing the rest of the flow.

```json
{
  "tool": "wait_for",
  "condition": "elementExists",
  "path": "Pane[automationId=MainPanel] > Button[name=Save]",
  "when": { "variable": "lastStepSuccess", "equals": "true" },
  "retry": { "maxAttempts": 3, "delayMs": 150, "backoffMs": 150 }
}
```

## Complete Example: Form Fill and Submit

PowerShell-safe inline invocation:

```powershell
DriveNet.Cli.exe batch -n MyApp --steps '[{"tool":"query","action":"find","automationId":"txtName","saveAs":"name"},{"tool":"interact","action":"type","elementId":"${name}","value":"Alice"}]'
```

For larger flows, prefer a UTF-8 JSON file and `--steps-file`.

```json
[
  { "tool": "query", "action": "find", "automationId": "txtName", "saveAs": "name" },
  { "tool": "query", "action": "find", "automationId": "txtEmail", "saveAs": "email" },
  { "tool": "query", "action": "find", "automationId": "cboCountry", "saveAs": "country" },
  { "tool": "query", "action": "find", "automationId": "chkAgree", "saveAs": "agree" },
  { "tool": "query", "action": "find", "automationId": "btnSubmit", "saveAs": "submit" },
  { "tool": "interact", "action": "type", "elementId": "${name}", "value": "Alice" },
  { "tool": "interact", "action": "type", "elementId": "${email}", "value": "alice@example.com" },
  { "tool": "interact", "action": "select", "elementId": "${country}", "value": "United States" },
  { "tool": "interact", "action": "toggle", "elementId": "${agree}" },
  { "tool": "interact", "action": "click", "elementId": "${submit}" },
  { "tool": "wait_for", "condition": "elementExists", "automationId": "lblSuccess", "timeoutMs": 10000 }
]
```

## Complex Automation Scenarios

### Dialog Handling: Click Button Then Dismiss Confirmation Dialog

When a button triggers a modal dialog, wait for the new window, find the dialog's confirm button, and click it:

```json
[
  { "tool": "query", "action": "find", "automationId": "btnDelete", "saveAs": "del" },
  { "tool": "interact", "action": "click", "elementId": "${del}" },
  { "tool": "wait_for", "condition": "windowOpened", "timeoutMs": 5000 },
  { "tool": "query", "action": "find", "name": "Yes", "controlType": "Button", "saveAs": "confirm" },
  { "tool": "interact", "action": "click", "elementId": "${confirm}" },
  { "tool": "wait_for", "condition": "windowClosed", "timeoutMs": 5000 }
]
```

### Multi-Window Workflow: Open Settings and Change a Value

Open a settings dialog from the main window, modify a control, save, and wait for the dialog to close:

```json
[
  { "tool": "query", "action": "find", "automationId": "mnuSettings", "saveAs": "menu" },
  { "tool": "interact", "action": "click", "elementId": "${menu}" },
  { "tool": "wait_for", "condition": "windowOpened", "timeoutMs": 5000 },
  { "tool": "query", "action": "find", "automationId": "txtMaxRetries", "saveAs": "retries" },
  { "tool": "interact", "action": "type", "elementId": "${retries}", "value": "5" },
  { "tool": "query", "action": "find", "automationId": "btnSave", "saveAs": "save" },
  { "tool": "interact", "action": "click", "elementId": "${save}" },
  { "tool": "wait_for", "condition": "windowClosed", "timeoutMs": 5000 }
]
```

### Wizard / Multi-Page Flow: Step Through Pages

Navigate a multi-page wizard by filling fields and clicking Next, then waiting for each page's elements to appear:

```json
[
  { "tool": "query", "action": "find", "automationId": "txtProjectName", "saveAs": "projName" },
  { "tool": "interact", "action": "type", "elementId": "${projName}", "value": "MyProject" },
  { "tool": "query", "action": "find", "automationId": "btnNext", "saveAs": "next1" },
  { "tool": "interact", "action": "click", "elementId": "${next1}" },
  { "tool": "wait_for", "condition": "elementExists", "automationId": "cboTemplate", "timeoutMs": 5000 },
  { "tool": "query", "action": "find", "automationId": "cboTemplate", "saveAs": "template" },
  { "tool": "interact", "action": "select", "elementId": "${template}", "value": "Console App" },
  { "tool": "query", "action": "find", "automationId": "btnNext", "saveAs": "next2" },
  { "tool": "interact", "action": "click", "elementId": "${next2}" },
  { "tool": "wait_for", "condition": "elementExists", "automationId": "btnFinish", "timeoutMs": 5000 },
  { "tool": "query", "action": "find", "automationId": "btnFinish", "saveAs": "finish" },
  { "tool": "interact", "action": "click", "elementId": "${finish}" },
  { "tool": "wait_for", "condition": "elementExists", "automationId": "lblComplete", "timeoutMs": 10000 }
]
```

### Data Grid Validation: Read and Verify Table Contents

Read a data grid's contents to verify expected data after an operation:

```json
[
  { "tool": "query", "action": "find", "automationId": "dgResults", "saveAs": "grid" },
  { "tool": "query", "action": "gridData", "elementId": "${grid}",
    "save": { "rowCount": "rowCount", "firstCell": "rows[0].cells[0]" } }
]
```

The saved `${rowCount}` and `${firstCell}` can then be inspected in the batch response to verify correctness.

### Integration Test Pattern: Interact Then Assert State

After performing an action, immediately verify the UI updated correctly using `textEquals`:

```json
[
  { "tool": "query", "action": "find", "automationId": "txtInput", "saveAs": "input" },
  { "tool": "interact", "action": "type", "elementId": "${input}", "value": "42" },
  { "tool": "query", "action": "find", "automationId": "btnCalculate", "saveAs": "calc" },
  { "tool": "interact", "action": "click", "elementId": "${calc}" },
  { "tool": "query", "action": "find", "automationId": "lblResult", "saveAs": "result" },
  { "tool": "wait_for", "condition": "textEquals", "elementId": "${result}", "expectedValue": "1764", "timeoutMs": 5000 }
]
```

### Delayed UI Transitions: Using Per-Step Timing

For apps with animations or slow transitions, use per-step delays instead of a blanket `delayBetweenMs`:

```json
[
  { "tool": "query", "action": "find", "automationId": "btnExpand", "saveAs": "expand" },
  { "tool": "interact", "action": "click", "elementId": "${expand}", "delayAfterMs": 500 },
  { "tool": "query", "action": "find", "automationId": "panelContent", "saveAs": "panel" },
  { "tool": "interact", "action": "click", "elementId": "${panel}" }
]
```

### Clipboard Round-Trip: Copy and Paste Between Fields

Read from one field via clipboard, then paste into another:

```json
[
  { "tool": "query", "action": "find", "automationId": "txtSource", "saveAs": "src" },
  { "tool": "interact", "action": "click", "elementId": "${src}" },
  { "tool": "interact", "action": "sendKeys", "elementId": "${src}", "keys": "Ctrl+A" },
  { "tool": "interact", "action": "sendKeys", "elementId": "${src}", "keys": "Ctrl+C" },
  { "tool": "query", "action": "find", "automationId": "txtDest", "saveAs": "dest" },
  { "tool": "interact", "action": "click", "elementId": "${dest}" },
  { "tool": "interact", "action": "sendKeys", "elementId": "${dest}", "keys": "Ctrl+V" }
]
```

### App Startup with Settling: Wait for Main Window to Load

Use `startDelayMs` so the batch waits for the app to finish rendering after session connect or after the workflow has just shifted to a new top-level surface:

```json
// Call batch with: startDelayMs: 2000
[
  { "tool": "wait_for", "condition": "elementExists", "automationId": "mainPanel", "timeoutMs": 10000 },
  { "tool": "query", "action": "find", "automationId": "mainPanel", "saveAs": "panel" },
  { "tool": "query", "action": "tree", "elementId": "${panel}", "maxDepth": 2 }
]
```

## Response

```json
{
  "results": [
    { "stepIndex": 0, "tool": "query", "success": true, "result": { "items": [...], "count": 1 }, "saved": { "name": "e_abc" }, "skipped": false, "attemptCount": 1, "error": null },
    { "stepIndex": 1, "tool": "interact", "success": true, "result": "Typed text (5 chars).", "skipped": false, "attemptCount": 1, "error": null }
  ]
}
```

## Rules

- Use `stopOnError: true` (default) when later steps depend on earlier ones.
- Use `delayBetweenMs` if the UI needs settling time between rapid interactions.
- Use `startDelayMs` and `endDelayMs` to bookend the batch with pauses for UI settling.
- Use per-step `delayBeforeMs` / `delayAfterMs` for targeted timing on individual steps.
- Use `when` for optional diagnostics, cleanup, or alternate branches rather than forcing every step to run.
- Use `retry` for short-lived readiness issues, not for selector ambiguity; fix selector ambiguity with `query action="explain"` first.
- Use `continueOnError` sparingly, usually for cleanup or best-effort diagnostics.
- `saveAs` fails if the query returns no results.
- Variables are scoped to the batch execution and available to all subsequent steps.
- Maximum 20 saved variables per `save` block; maximum 32KB per saved value.
- Max 100 steps per batch.
