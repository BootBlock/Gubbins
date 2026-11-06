---
name: drivenet-assert
description: "Use this skill to validate UI state with Drive.NET's 'assert' MCP tool. Covers selector clauses, labels, count and regex assertions, propertyEquals, helpText and itemStatus checks, matchIndex targeting, windowHandle scoping, and batch-gated verification patterns. Keywords: Drive.NET, assert, assertion, exists, count, textEquals, textContains, textMatches, propertyEquals, helpText, itemStatus, matchIndex, label, verification, validation, batch."
argument-hint: "[goal] [selector] [expected UI state]"
user-invocable: true
---

# Drive.NET UI Assertions

Use this skill when you need pass/fail verification of desktop UI state without hand-rolling comparisons from raw `query` output.

## `assert` Tool

Evaluate one or more assertion clauses against a connected session.

### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `sessionId` | string | Yes | Session ID from `session connect`. |
| `clauses` | string | Yes | JSON array of assertion clauses. |

### Clause Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `automationId` | string | No* | Match by Automation ID. |
| `name` | string | No* | Match by accessible name. |
| `controlType` | string | No* | Match by control type such as `Button` or `Edit`. |
| `className` | string | No* | Match by class name. |
| `path` | string | No* | Hierarchical selector path such as `Pane[automationId=MainPanel] > Button[name=Save]`. |
| `elementId` | string | No* | Match by cached element ID from a previous query. |
| `windowHandle` | string | No | Scope the clause to one top-level window. |
| `matchIndex` | int | No | 0-based match position when multiple elements match. |
| `condition` | string | No | Condition to evaluate. Defaults to `exists`. |
| `expected` | string, boolean or number | No | Expected value for comparison-style conditions. A boolean or a number is converted to its text form, so `false` and `"false"` mean the same thing. |
| `property` | string | No | Property name used by `propertyEquals`. |
| `label` | string | No | Human-readable label for the clause result. |

`*` Each clause must include at least one selector field.

### Conditions

| Condition | Description | `expected` required |
|---|---|---|
| `exists` | At least one matching element exists. | No |
| `notExists` | No matching elements exist. | No |
| `count` | Exact match count equals `expected`. | Yes |
| `countGreaterThan` | Match count is greater than `expected`. | Yes |
| `countLessThan` | Match count is less than `expected`. | Yes |
| `propertyEquals` | Element `property` value equals `expected`. | Yes |
| `textEquals` | Element text equals `expected`. | Yes |
| `textContains` | Element text contains `expected`. | Yes |
| `textMatches` | Element text matches a .NET regex pattern. | Yes |
| `isEnabled` | Element enabled state matches `expected` or defaults to `true`. | No |
| `isVisible` | Element off-screen state matches `expected` or defaults to `true`. | No |
| `helpTextEquals` | Element HelpText equals `expected`. | Yes |
| `helpTextContains` | Element HelpText contains `expected`. | Yes |
| `itemStatusEquals` | Element ItemStatus equals `expected`. | Yes |
| `itemStatusContains` | Element ItemStatus contains `expected`. | Yes |

### Examples

```text
assert sessionId="session-1" clauses=[{"automationId":"btnSave","condition":"exists","label":"save button exists"}]
assert sessionId="session-1" clauses=[{"automationId":"lblStatus","condition":"textEquals","expected":"Saved","label":"status text"},{"path":"List > ListItem","condition":"countGreaterThan","expected":"0","label":"results present"}]
assert sessionId="session-1" clauses=[{"automationId":"txtSearch","condition":"propertyEquals","property":"value","expected":"fictional query","label":"search value"}]
assert sessionId="session-1" clauses=[{"automationId":"detailsPane","condition":"helpTextContains","expected":"fictional token","label":"details help text"}]
assert sessionId="session-1" clauses=[{"automationId":"nodeOrders","condition":"itemStatusEquals","expected":"Expanded","label":"orders expanded"}]
assert sessionId="session-1" clauses=[{"path":"Button[name=OK]","matchIndex":0,"condition":"isEnabled","expected":"false","label":"ok disabled"}]
```

### Rules

- Use `assert` instead of `query` plus manual string parsing when the workflow only needs pass/fail verification.
- Spell every clause field exactly as one of `automationId`, `name`, `nameContains`, `nameStartsWith`, `nameRegex`, `controlType`, `className`, `helpText`, `path`, `matchIndex`, `elementId`, `windowHandle`, `condition`, `expected` (or its alias `expectedValue`), `property` and `label`. A misspelt name, a name in the wrong case, and a value of the wrong JSON type are all errors that name the field, never a silently dropped clause.
- Assert a disabled or off-screen element with `expected` set to `false` or `"false"`. `isEnabled` and `isVisible` accept only `true`, `false`, `1` and `0`.
- Write a boolean UIA property as `"True"` or `"False"` under `propertyEquals`, which compares the property text exactly.
- Add `label` to every clause that matters so failure output is readable in agent logs and CI.
- Remember that `matchIndex` here is 0-based. This differs from `query` path resolution, which uses 1-based `matchIndex`.
- Prefer `helpTextEquals`, `helpTextContains`, `itemStatusEquals`, and `itemStatusContains` over generic `propertyEquals` when those dedicated accessibility properties are what you actually care about.
- Use `textMatches` when UI text has stable shape but variable values, such as timestamps or generated identifiers.
- Combine several clauses in one call when the UI state should be evaluated atomically.
- If the assertion must gate a larger multi-step workflow, use an `assert` step inside `batch` so the batch itself is the source of truth for pass/fail.

## Common Patterns

### Verify Save Completed

```text
assert sessionId="session-1" clauses=[{"automationId":"lblStatus","condition":"textEquals","expected":"Saved","label":"save status"},{"automationId":"btnSave","condition":"isEnabled","expected":"true","label":"save re-enabled"}]
```

### Verify A Dialog Stayed Closed

```text
assert sessionId="session-1" clauses=[{"name":"Error","controlType":"Window","condition":"notExists","label":"no error dialog"}]
```

### Verify Repeated Rows Exist Without Reading The Whole Grid

```text
assert sessionId="session-1" clauses=[{"path":"DataGrid[name=Results] > DataItem","condition":"countGreaterThan","expected":"2","label":"results rows"}]
```