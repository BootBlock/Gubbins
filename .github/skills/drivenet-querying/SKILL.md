---
name: drivenet-querying
description: "Use this skill to find, resolve, enumerate, and explain UI elements in a Windows desktop app through Drive.NET. Covers the 'query' MCP tool with actions: find, resolve, explain, tree, properties, bounds, children, parent, and gridData, including hierarchical path selectors, window-handle roots, fallback, all-window search, and popup-host bounds provenance. Keywords: Drive.NET, query, find, resolve, explain, tree, properties, bounds, children, parent, gridData, automationId, controlType, className, path, matchIndex, selector, UI Automation, UIA, popup, boundsSource, appMetadataBounds."
argument-hint: "[goal] [target element automationId, path, or controlType]"
user-invocable: true
---

# Drive.NET Element Querying

Use this skill when you need to find UI elements, understand why a selector does or does not match, traverse the element tree, read properties, or extract grid data from a connected Windows desktop application.

## `query` Tool

### Parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `sessionId` | string | Yes | - | Session ID from `session connect`. |
| `action` | string | Yes | - | `find`, `resolve`, `explain`, `tree`, `properties`, `bounds`, `children`, `parent`, or `gridData`. |
| `by` | string | No | - | JSON search criteria for `find` or `resolve`, such as `{"automationId":"txtUsername"}` or `{"controlType":"Edit","name":"Username"}`. |
| `path` | string | No | - | Hierarchical selector path for `find` or `explain`, such as `Pane[automationId=MainPanel] > Button[name=Save]`. |
| `matchIndex` | int | No | - | 1-based match position after selector filtering. |
| `elementId` | string | No | - | Element ID from a previous query. Required for `properties`, `parent`, and `gridData`. Optional for `children` and `tree`. |
| `rootElementId` | string | No | - | Search root for `find`, `resolve`, or `explain` instead of the session root. |
| `windowHandle` | string | No | - | Top-level window handle to use as the query root for `find`, `explain`, `tree`, or `children`. |
| `maxDepth` | int | No | `3` | Max tree depth for `tree` (0-25). |
| `maxNodes` | int | No | `250` | Maximum number of returned nodes for `tree` before the response is truncated in-band (1-5000). |
| `detail` | string | No | `summary` | `summary` or `verbose`. |
| `annotateArtifacts` | bool | No | `false` | For `tree`, annotate probable framework/provider artefacts such as offscreen WinUI placeholders without changing tree membership. |
| `view` | string | No | `control` | For `tree`, the UI Automation view to walk: `control`, `content`, or `raw`. `raw` also returns the elements a provider excludes from the accessibility views, which no other view can reach; pair it with `detail=verbose` to read each element's `accessibilityView`. |
| `scope` | string | No | `descendants` | `descendants`, `children`, or `subtree`. |
| `maxResults` | int | No | engine default | Maximum results for `find` or `explain` (1-5000). |
| `fallback` | bool | No | `false` | For `find` and `resolve`, try alternative selector strategies if the primary selector returns no matches. |
| `searchAllWindows` | bool | No | `false` | For `find`, `resolve`, and `tree`, search across all visible windows for the session process instead of one rooted surface. |

## Actions

### `find`

Search for elements matching either a `by` JSON selector or a hierarchical `path`.

```
query sessionId="..." action="find" by='{"automationId":"txtUsername"}'
query sessionId="..." action="find" by='{"automationId":"SubmitButton"}'
query sessionId="..." action="find" path='Pane[automationId=MainPanel] > Button[name=Save]' matchIndex=2
query sessionId="..." action="find" by='{"controlType":"Edit"}' scope="children" rootElementId="e_panel1"
query sessionId="..." action="find" by='{"automationId":"CloseButton"}' windowHandle="0x1A4F"
```

`find` returns an object with `queryRoot` plus `elements`. Inspect `queryRoot` when you need to confirm whether the search ran from the session root, a specific element, or a specific window handle.

Equivalent duplicate matches that share the same selector-visible identity and bounds are collapsed automatically. When this happens, the response also includes `duplicatesCollapsed`.

### `resolve`

Resolve exactly one fresh element id from a selector without dumping a larger result set.

```
query sessionId="..." action="resolve" by='{"automationId":"ThemeComboBox"}'
query sessionId="..." action="resolve" path='Pane[automationId=MainPanel] > Button[name=Save]' matchIndex=2
query sessionId="..." action="resolve" by='{"name":"Reset position","controlType":"MenuItem"}' searchAllWindows=true
```

`resolve` returns `queryRoot`, `elementId`, and `element` when the selector is unique. If the selector resolves to zero or many elements, it returns a focused error instead of forcing a full tree walk.

When `searchAllWindows=true`, `queryRoot.source` becomes `allWindows` and `queryRoot.windowsSearched` lists the visible windows that were searched with per-window match counts.

### `explain`

Return structured selector diagnostics without acting on the UI. Use this before a click, inspect, or wait when the selector is uncertain.

```
query sessionId="..." action="explain" path='Pane[automationId=MainPanel] > Button[name=Save]' matchIndex=2
query sessionId="..." action="explain" by='{"automationId":"SubmitButton"}'
query sessionId="..." action="explain" path='Button[name=OK]' windowHandle="0x1A4F"
```

### `tree`

Return an object with `queryRoot` and a nested `tree` array of element info objects with children. The response also includes `nodeCount`, `truncated`, `maxNodes`, and `continuationHints` when the subtree is larger than the returned budget. Use `elementId` to scope to a smaller subtree.

```
query sessionId="..." action="tree"
query sessionId="..." action="tree" maxDepth=5 detail="verbose"
query sessionId="..." action="tree" maxDepth=4 maxNodes=150
query sessionId="..." action="tree" elementId="e_panel1" maxDepth=2
query sessionId="..." action="tree" windowHandle="0x1A4F" maxDepth=2
```

When `truncated` is `true`, pick one of the returned `continuationHints[*].elementId` values and rerun `query action="tree"` against that subtree instead of retrying the whole window.

When `searchAllWindows=true`, `tree` returns `windowTrees` instead of one merged tree so you can inspect each visible window independently while the overall node budget stays bounded.

A `windowHandle`-rooted tree query can report a popup provider that hides content from a recursive walk. The check compares the walk against a flat descendant search, which enumerates the window a second time, so it runs only when the handle names a popup surface (a popup-styled window, or one whose class name marks it as a popup, flyout, or menu host) and the walk reached every node. An ordinary window pays nothing for it. A walk that `maxDepth` cut short skips the check as well, because a shorter walk and a flat search disagree for a reason the provider did not cause; raise `maxDepth` until no node reports children the walk did not return, and the check runs again. When the check runs and the flat search finds at least three more elements than the walk, the response includes a `popupTreeDiagnostic` block with `treeNodeCount` (the nodes the walk reached, before `maxNodes` bounds the response), `searchableDescendantCount`, and guidance to use `find` or `resolve` for element discovery on that popup.

When a browser session has its accessibility runtime disabled (e.g. Firefox with `accessibility.force_disabled = 1`), `tree` responses include a `browserAccessibilityDiagnostic` block explaining why page content is not queryable. `find` queries against such a browser short-circuit to empty results with the same diagnostic, preventing unreliable chrome-only matches from being returned.

### `bounds`

Return element coordinates in screen and window-relative spaces, plus click-point diagnostics.

```
query sessionId="..." action="bounds" elementId="e_abc123"
```

`bounds` returns `screenBounds`, `screenBoundsSource`, `uiaBoundingRect`, optional `popupRelativeBounds`, `windowRelativeBounds`, `hostWindow`, `clickablePoint`, and `clickResolution`.

- `screenBoundsSource` is `nativeWindowRect`, `uiaBoundingRect`, `dwmExtendedFrameBounds`, `appMetadata`, or `mixed`.
- `uiaBoundingRect` is the raw UIA bounding rectangle when available.
- `popupRelativeBounds` is included when Drive.NET detects popup-relative UIA coordinates and translates them to produce `screenBounds`.
- `hostWindow` includes `source`, authoritative `bounds`, `boundsSource`, `nativeWindowRect`, optional `uiaBoundingRect`, optional `boundsDeltaFromNative`, optional `dwmExtendedFrameBounds`, optional `appMetadataBounds`, and `suspectReusedPopup` so popup-rooted descendant queries preserve their popup-host association.
- When a popup descendant exposes an intermediate bridge handle instead of the popup HWND, Drive.NET normalizes that handle up to the top-level popup host before populating `hostWindow`.
- When native bounds look sentinel-like and UIA is also origin-like, Drive.NET tries DWM compositor bounds as a revalidation source. If DWM returns anchored bounds, `boundsSource` becomes `dwmExtendedFrameBounds`.
- When native, UIA, and DWM all still report sentinel-style coordinates for a visible popup, Drive.NET marks `suspectReusedPopup=true` and searches the popup subtree for app-emitted metadata such as `helpText="...; popup=x,y,w,h"`. When found, `hostWindow.boundsSource` becomes `appMetadata` and `appMetadataBounds` contains the parsed popup rect.

### `properties`

Return verbose single-element detail, including `runtimeId`, `className`, `helpText`, supported patterns, and other diagnostic properties. Compare `runtimeId` across two queries to tell an element the app kept from one it recreated: element ids are new on each query, and a recreated element keeps its name and automation id.

```
query sessionId="..." action="properties" elementId="e_abc123"
```

### `children` and `parent`

Navigate the element tree around a known element.

```
query sessionId="..." action="children" elementId="e_abc123"
query sessionId="..." action="parent" elementId="e_abc123"
```

`children` also returns `queryRoot` so callers can verify the effective root.

### `gridData`

Read table or grid content from controls that support the Grid or Table UIA pattern.

```
query sessionId="..." action="gridData" elementId="e_grid1"
```

## Selector Strategy

- Prefer `by` with `automationId` first. It is usually the most stable selector.
- Combine `controlType` and `name` inside `by` when `automationId` is absent.
- Use `path` only when sibling repetition or container context matters.
- Use `matchIndex` only when duplicate matches are expected and their order is stable.
- Use `scope="children"` and `rootElementId` to keep searches narrow and deterministic.
- Use `windowHandle` for modal dialogs or secondary top-level windows when you do not want to retarget the whole session.
- Use `searchAllWindows=true` for popup or flyout discovery when you do not know the right secondary window handle yet.
- Popup discovery and popup-window-scoped queries are the supported way to inspect flyout content. If a popup moved during a held drag but disappears or returns to its anchor after `mouseUp`, rerun `window list` and popup-rooted `find` or `resolve`; the app may have reverted the drop during its own release or capture handling.
- Check `queryRoot` in `find`, `tree`, and `children` responses before acting on results from a secondary window.
- When `hostWindow.boundsSource` is `uiaBoundingRect` for a popup host, Drive.NET rejected a misleading hidden-popup native sentinel rect in favor of a materially different anchored UIA rect.
- When `hostWindow.boundsSource` is `dwmExtendedFrameBounds`, Drive.NET used DWM compositor bounds because both native and UIA reported sentinel or origin-like coordinates for a reused popup host.
- When `hostWindow.boundsSource` is `appMetadata`, Drive.NET used popup geometry parsed from app-emitted UIA metadata because the raw Win32/UIA/DWM path stayed on the hidden-popup sentinel.
- For popup `windowHandle` roots with `boundsSource="appMetadata"`, `find`, `resolve`, `tree`, and `children` normalize popup-root and popup-descendant `boundingRect` values into corrected screen-space coordinates before returning them.
- When `hostWindow.suspectReusedPopup` is `true` and `hostWindow.appMetadataBounds` is absent, use app-emitted `helpText` or `itemStatus` for authoritative popup geometry.
- When `screenBoundsSource` is `mixed`, inspect `popupRelativeBounds` and `hostWindow` together. Drive.NET translated the raw UIA rect using the popup host bounds because the provider looked origin-relative instead of screen-relative.
- `searchAllWindows` is mutually exclusive with rooted queries such as `rootElementId`, `elementId`, and `windowHandle`.
- `fallback=true` is available for `find` and `resolve`. When combined with `searchAllWindows`, fallback is tried per-window when the initial cross-window search yields no results.
- Element IDs are session-scoped and transient; re-query or `resolve` again after reconnects or meaningful UI refreshes.

## Diagnostics-First Workflow

1. Start with `query action="find"` using `by='{"automationId":"..."}'`.
2. If that fails or returns too many matches, run `query action="explain"` against the same selector.
3. When the selector is stable and you only need one fresh element id, switch to `query action="resolve"`.
4. If the selector is still weak, switch to `path` or narrow the search with `rootElementId` and `scope="children"`.
5. Use `tree` only on the smallest useful subtree, not the entire window. If it still truncates, pivot to a hinted subtree root.
6. Use `inspect` after the selector is stable and the target is unique.

## Name Mismatch Heuristics

- If searching for a noun such as `Settings` fails, try an action-oriented accessible name such as `Open settings`.
- UIA control types differ from framework names: `TextBox` maps to `Edit`, and `Label` or `TextBlock` maps to `Text`.
- If a control exists but cannot be found by name, explain or dump a focused subtree around the expected container to discover the actual names.

## Complex Query Patterns

### Batch Element Discovery

When automating a form, discover all needed elements in a single batch to reduce round-trips:

```json
[
  { "tool": "query", "action": "find", "automationId": "txtName", "saveAs": "name" },
  { "tool": "query", "action": "find", "automationId": "txtEmail", "saveAs": "email" },
  { "tool": "query", "action": "find", "automationId": "btnSubmit", "saveAs": "submit" }
]
```

### Selector Triage Before Interaction

Use `explain` before you commit a batch or a direct interaction to a brittle selector:

```json
[
  { "tool": "query", "action": "explain", "path": "Pane[automationId=MainPanel] > Button[name=Save]" },
  { "tool": "query", "action": "resolve", "path": "Pane[automationId=MainPanel] > Button[name=Save]", "saveAs": "save" }
]
```

### Reading Grid Data For Assertions

After populating a data grid, read its contents to verify row counts and cell values:

```
query sessionId="..." action="find" by='{"automationId":"dgResults"}'
query sessionId="..." action="gridData" elementId="e_grid"
```

### Hierarchy Exploration

When you do not know the structure, start shallow and drill down:

```
query sessionId="..." action="tree" maxDepth=1
query sessionId="..." action="children" elementId="e_mainPanel"
query sessionId="..." action="tree" elementId="e_tabControl" maxDepth=3 detail="verbose"
```
