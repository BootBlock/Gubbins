---
name: drivenet-waiting
description: "Use this skill to wait for UI conditions in a Windows desktop app through Drive.NET. Covers the 'wait_for' MCP tool with polling and event-driven conditions, selector diagnostics via explain, and hierarchical path selectors. Keywords: Drive.NET, wait_for, wait, condition, polling, timeout, explain, path, matchIndex, elementExists, elementRemoved, propertyChanged, textEquals, elementEnabled, elementVisible, windowOpened, windowClosed, structureChanged, helpTextEquals, helpTextContains, itemStatusEquals, itemStatusContains."
argument-hint: "[condition] [target element, path, or criteria]"
user-invocable: true
---

# Drive.NET Wait For Conditions

Use this skill when you need to wait for a UI state change after an interaction, verify that a condition has been met, or debug why a selector-based wait keeps timing out.

## `wait_for` Tool

Wait for a UI condition using polling or event-based detection depending on the condition.

### Parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `sessionId` | string | Yes | - | Session ID from `session connect`. |
| `condition` | string | Yes | - | Condition to wait for. |
| `automationId` | string | No | - | Flat selector field. |
| `name` | string | No | - | Flat selector field. |
| `controlType` | string | No | - | Flat selector field. |
| `className` | string | No | - | Flat selector field. |
| `path` | string | No | - | Hierarchical selector path for selector-based waits. |
| `matchIndex` | int | No | - | 1-based match position after selector filtering. |
| `windowHandle` | string | No | - | Window handle filter for `windowOpened` and `windowClosed`. |
| `ownerHandle` | string | No | - | Owner window handle filter for `windowOpened`/`windowClosed`. Matches popup/flyout windows owned by the specified handle. |
| `elementId` | string | No | - | Existing element ID for state-based waits. |
| `propertyName` | string | No | - | Property to watch for `propertyChanged`. |
| `expectedValue` | string | No | - | Expected value for `textEquals`, optional for `propertyChanged`. |
| `explain` | bool | No | `false` | Return selector diagnostics instead of waiting. |
| `fallback` | bool | No | `false` | Try alternative selector strategies during polling when the primary selector yields no results. |
| `timeoutMs` | int | No | `30000` | Timeout in milliseconds (max: 300000). |

### Conditions

| Condition | Description | Required Parameters |
|---|---|---|
| `elementExists` | Matching element appears in the tree | At least one selector: `automationId`, `name`, `controlType`, `className`, or `path` |
| `elementRemoved` | Matching element disappears from the tree | `elementId` or search criteria |
| `propertyChanged` | A property on an element changes | `elementId`, `propertyName` |
| `textEquals` | Element text equals the expected value | `elementId`, `expectedValue` |
| `elementEnabled` | Element becomes enabled | `elementId` |
| `elementVisible` | Element becomes visible | `elementId` |
| `windowOpened` | A new matching window opens | Optional selectors, `windowHandle`, or `ownerHandle` |
| `windowClosed` | A matching window closes | Optional selectors, `windowHandle`, or `ownerHandle` |
| `structureChanged` | Any UI tree structure change | None |
| `childAppeared` | Matching child appears under a parent element | `elementId` plus a selector for the child |
| `childRemoved` | Matching child disappears from a parent element | `elementId` plus a selector for the child |
| `helpTextEquals` | Element help text (UIA HelpText) equals the expected value | `elementId`, `expectedValue` |
| `helpTextContains` | Element help text contains the expected value | `elementId`, `expectedValue` |
| `itemStatusEquals` | Element item status (UIA ItemStatus) equals the expected value | `elementId`, `expectedValue` |
| `itemStatusContains` | Element item status contains the expected value | `elementId`, `expectedValue` |

### Response

```json
{
  "conditionMet": true,
  "elapsedMs": 1250,
  "details": "Element found after 1250ms."
}
```

Window waits can also return a `changedWindow` object when a specific window opens or closes.

If the target process exits during the wait, the response includes `processExited: true`, `terminationReason`, optional exit-code fields, and `crashEvidence` when Drive.NET can correlate target-app dumps, crash logs, or Windows Application event entries. When you see `processExited: true`, call `session status` with the same `sessionId` to retrieve the durable `crashEvidence` block before retrying or reconnecting.

### Examples

```
wait_for sessionId="..." condition="elementExists" automationId="lblSuccess"
wait_for sessionId="..." condition="elementExists" automationId="lblSuccess" explain=true
wait_for sessionId="..." condition="elementExists" path='Pane[automationId=MainPanel] > Button[name=Save]' matchIndex=2
wait_for sessionId="..." condition="textEquals" elementId="e_status" expectedValue="Complete"
wait_for sessionId="..." condition="elementEnabled" elementId="e_btn1" timeoutMs=10000
wait_for sessionId="..." condition="windowOpened" name="Preferences" timeoutMs=5000
wait_for sessionId="..." condition="windowClosed" windowHandle="0x2A" timeoutMs=5000
wait_for sessionId="..." condition="windowOpened" ownerHandle="0x1A4F" timeoutMs=5000
wait_for sessionId="..." condition="propertyChanged" elementId="e_prog" propertyName="value"
wait_for sessionId="..." condition="elementRemoved" elementId="e_spinner"
wait_for sessionId="..." condition="structureChanged" timeoutMs=5000
```

## Rules

- Always use `wait_for` after interactions that trigger UI changes; do not assume instant updates.
- Use `explain=true` before increasing `timeoutMs` when a selector-based wait is failing. Fix the selector shape first.
- Prefer `elementId` for state checks such as `textEquals`, `elementEnabled`, and `elementVisible`.
- Use `elementId` plus a child selector for `childAppeared` and `childRemoved`; the `elementId` is the parent element to watch.
- Prefer `path` for repeated controls whose parent chain matters more than the control text alone.
- Polling interval is 250ms, so conditions may be detected up to 250ms after they occur.
- `structureChanged` uses a UIA event subscription for more responsive detection.
- `fallback=true` only affects selector-based polling such as `elementExists`; it does not change direct `elementId` waits.
- A `conditionMet: false` result means the timeout expired, not that the condition can never be met.

## Complex Automation Patterns

### Post-Interaction State Verification

After a button click, wait for a label to show the expected result text:

```
interact sessionId="..." action="click" elementId="e_submit"
wait_for sessionId="..." condition="textEquals" elementId="e_status" expectedValue="Saved" timeoutMs=5000
```

### Selector Triage Before Waiting

When a selector-based wait is flaky, explain the selector before spending another timeout cycle:

```
wait_for sessionId="..." condition="elementExists" path='Pane[automationId=MainPanel] > Button[name=Save]' explain=true
wait_for sessionId="..." condition="elementExists" path='Pane[automationId=MainPanel] > Button[name=Save]' timeoutMs=5000
```

### Dialog Detection And Handling

Detect a dialog opening after an action, then act on it:

```
interact sessionId="..." action="click" elementId="e_delete"
wait_for sessionId="..." condition="windowOpened" timeoutMs=5000
```

After `windowOpened` fires, inspect the returned `changedWindow` metadata first. Use `window list` only when you need broader context or multiple window candidates.

### Cascading Element Readiness

When a combo box selection triggers a dependent panel to load, chain waits:

```
interact sessionId="..." action="select" elementId="e_combo" value="Advanced"
wait_for sessionId="..." condition="elementExists" automationId="advancedPanel" timeoutMs=5000
wait_for sessionId="..." condition="elementEnabled" elementId="e_advBtn" timeoutMs=3000
```

### Batch Integration: Wait Then Assert

Inside a `batch`, combine waits with follow-up queries to verify state programmatically:

```json
[
  { "tool": "interact", "action": "click", "elementId": "${submit}" },
  { "tool": "wait_for", "condition": "elementExists", "automationId": "lblResult", "timeoutMs": 5000 },
  { "tool": "query", "action": "find", "automationId": "lblResult", "save": { "resultText": "items[0].name" } }
]
```
