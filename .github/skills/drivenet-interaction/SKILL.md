---
name: drivenet-interaction
description: "Use this skill to interact with UI elements in a Windows desktop app through Drive.NET. Covers the 'interact' MCP tool (click, doubleClick, rightClick, type, clear, sendKeys, keyDown, keyUp, select, toggle, expand, collapse, scrollIntoView, dragTo, mouseDown, mouseUp, hover, mouseMove, pointerPath, moveTo, diagnose, setFocus, highlight, clipboard read/write, fallback re-resolution, effect observation including `contextMenuOpened`, same-process popup replacement diagnostics, and click diagnostics with native/UIA reconciliation) and the 'inspect' MCP tool (exhaustive element info, supported patterns, available actions, current value, toggle/expand state). Keywords: Drive.NET, interact, inspect, click, type, sendKeys, select, toggle, expand, collapse, drag, held drag, mouseDown, mouseUp, mouseMove, pointerPath, keyDown, keyUp, moveTo, hover, smooth mouse, clipboard, highlight, focus, fallback, stale element, effect observation, contextMenuOpened, popup replacement, patterns, actions, value, escalate, confidence, click diagnostics."
argument-hint: "[goal] [action like click/type/select] [target element]"
user-invocable: true
---

# Drive.NET Element Interaction

Use this skill when you need to perform actions on UI elements (click, type, select, etc.) or inspect an element's capabilities before interacting.

## `inspect` Tool

Get exhaustive information about a single element before interacting. Returns supported UIA patterns, available actions, current value, toggle state, and expand/collapse state.

### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `sessionId` | string | Yes | Session ID from `session connect`. |
| `elementId` | string | Yes | Element ID from a previous `query` result. |

### Response Fields

`elementId`, `controlType`, `name`, `automationId`, `runtimeId`, `className`, `boundingRect`, `isEnabled`, `isOffscreen`, `childCount`, `helpText`, `acceleratorKey`, `accessKey`, `itemStatus`, `itemType`, `labeledBy`, `currentValue`, `toggleState`, `expandCollapseState`, `supportedPatterns`, `availableActions`.

### When To Inspect

- Before a risky or unfamiliar interaction, to confirm the element supports the intended action.
- When `interact` fails, to check whether the element is enabled, visible, and on-screen.
- To read the current value or state of a control without modifying it.

## `interact` Tool

Perform UI interactions on elements.

### Parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `sessionId` | string | Yes | — | Session ID from `session connect`. |
| `action` | string | Yes | — | Action to perform (see table below). |
| `elementId` | string | No* | — | Element ID. Required for all actions except `clipboard`, `mouseMove`, `pointerPath`, `mouseDown`, `mouseUp`, `keyDown`, `keyUp`, and window-level `sendKeys`/`type`. |
| `value` | string | No | — | Text for `type`, item name for `select`. |
| `keys` | string | No | — | Key combination for `sendKeys` (e.g. `"Ctrl+S"`, `"Alt+F4"`, `"Enter"`), or the keys to hold or release for `keyDown` and `keyUp` (e.g. `"Ctrl"`, `"Ctrl+Shift"`). |
| `targetElementId` | string | No | — | Drop target element ID for `dragTo`. |
| `clipboardAction` | string | No | — | `"read"` or `"write"` for `clipboard` action. |
| `clipboardText` | string | No | — | Text to write for clipboard `write`. |
| `destinationX` | int | No | — | Destination X screen coordinate for `mouseMove`, `mouseDown`, or `mouseUp`. |
| `destinationY` | int | No | — | Destination Y screen coordinate for `mouseMove`, `mouseDown`, or `mouseUp`. |
| `sourceX` | int | No | — | Source X screen coordinate for `mouseMove`. Omit to start from current cursor position. |
| `sourceY` | int | No | — | Source Y screen coordinate for `mouseMove`. Omit to start from current cursor position. |
| `mouseButton` | string | No | `"none"` or `"left"` | Mouse button for `mouseMove`, `pointerPath`, `mouseDown`, or `mouseUp`: `none`, `left`, `right`, `middle`. `mouseMove` and `pointerPath` default to `none`; `mouseDown` and `mouseUp` default to `left`. For `mouseMove` and `pointerPath`, a button already held stays held; a button that is up is pressed at the start and released at the end. |
| `durationMs` | int | No | `1400` | Duration of the smooth mouse move in milliseconds (range: 50–10000). |
| `motionProfile` | string | No | `"natural"` | Humanized movement profile for `mouseMove`, `pointerPath`, `hover`, and `moveTo`: `steady`, `natural`, `exaggerated`, or `hesitant`. |
| `motionExaggeration` | int | No | profile-dependent | How exaggerated the humanized path should be (range: 0–100). Higher values increase curve width, timing variability, and correction intensity. |
| `highlight` | bool | No | `false` | Flash the element before performing the action. |
| `windowHandle` | string | No | — | Window handle to scope resolution to a specific window. For window-level `sendKeys`/`type` (no `elementId` and no selector fields) it targets that window directly (default: session main window). For **selector-based** interact (selector fields, no `elementId`) it scopes the selector search to that window's UIA root instead of the session root — pass the handle of a secondary window, dialog, or popup (from `window list`) so selectors like `name="Close"` resolve inside it. |
| `dwellMs` | int | No | `500` | Dwell time in milliseconds for `hover` (range: 50–10000). |
| `hoverMode` | string | No | `"default"` | Hover mode: `"default"` (move away then onto the element) or `"transit"` (approach from outside with a realistic boundary crossing). |
| `approachFrom` | string | No | `"top"` | Transit-hover entry direction: `top`, `bottom`, `left`, `right`, `top-left`, `top-right`, `bottom-left`, `bottom-right`. |
| `velocityMs` | int | No | `400` | Transit-hover travel time in milliseconds (range: 50–5000). Lower is faster. |
| `position` | string | No | — | Semantic pointer position for `moveTo`: `outside-left`, `outside-right`, `outside-top`, `outside-bottom`, `center`, `top-left`, `top-right`, `bottom-left`, `bottom-right`, `off-window`. |
| `offsetPx` | int | No | `20` | Pixel offset from the element edge for `moveTo`. |
| `by` | string | No | — | Search criteria JSON for stale-element recovery. Drive.NET first tries the exact selector and then fallback heuristics if needed. |
| `fallback` | bool | No | `false` | Enable stale-element re-resolution and selector fallback recovery. |
| `escalate` | bool | No | `false` | Walk up the ancestor chain when the requested element does not own the UIA patterns required for the action. |
| `requireTargetHit` | bool | No | `false` | Downgrade pointer-action confidence when the hit-test target is too far from the requested element. |
| `expectedEffect` | string | No | — | Verify a post-action effect such as `windowOpened`, `contextMenuOpened`, `sameProcessWindowReplaced`, `windowReplaced`, `popupReplaced`, `externalWindowOpened`, `structureChanged`, `sameWindowSubtreeChanged`, or `elementAppeared`. Use `contextMenuOpened` for right-click flows where the menu may appear either as submenu-like subtree content or as a popup-host window. Use `sameProcessWindowReplaced`, `windowReplaced`, or `popupReplaced` for same-process popup handoff or replacement when one popup host disappears as another becomes visible. |
| `effectTimeoutMs` | int | No | `800` | Timeout for effect observation (range: 100–5000). Default increases to `2000` for `externalWindowOpened`. |
| `clickStrategy` | string | No | `"center"` | Click-point strategy: `center`, `contentCenter`, `topLeft`, `topRight`, `bottomLeft`, `bottomRight`. |
| `collectEvidence` | bool | No | `false` | Capture inline evidence and persist a durable JSON artifact under `.drive-net`. |
| `collectWindowTimeline` | bool | No | `false` | During `hover`, capture a time-series of same-process window bounds over a short observation window. Returns per-sample bounds, stabilisation timing, newly visible, reused, and closed windows, replacement pairings, and bounds provenance when UIA and native popup geometry differ. |
| `timelineDurationMs` | int | No | `500` | Duration in ms for the window-bounds timeline sampling (range: 100–3000). Only used when `collectWindowTimeline=true`. |
| `timelineSampleIntervalMs` | int | No | `25` | Interval in ms between timeline samples (range: 10–200). Only used when `collectWindowTimeline=true`. |

### Actions

| Action | Description | Required Extra |
|---|---|---|
| `click` | Left-click | — |
| `doubleClick` | Double-click | — |
| `rightClick` | Right-click (context menu) | — |
| `type` | Clear then type text | `value` |
| `clear` | Clear the element's text | — |
| `sendKeys` | Send keyboard shortcut or append text | `keys` |
| `keyDown` | Hold keys (e.g. `Ctrl`) through SendInput until `keyUp`; no focus change | `keys` |
| `keyUp` | Release held keys in reverse order | `keys` |
| `select` | Select an item by name (combo box, list) | `value` |
| `toggle` | Toggle a checkbox or toggle control | — |
| `expand` | Expand a collapsible element | — |
| `collapse` | Collapse a collapsible element | — |
| `scrollIntoView` | Scroll the element into the visible area | — |
| `dragTo` | Drag element to a target | `targetElementId` |
| `mouseDown` | Press and hold a mouse button at the current cursor position or optional coordinates | optional `destinationX`, `destinationY`, `mouseButton` |
| `mouseUp` | Release a mouse button at the current cursor position or optional coordinates | optional `destinationX`, `destinationY`, `mouseButton` |
| `hover` | Move away, enter the element, and dwell | optional `dwellMs`, `hoverMode`, `approachFrom`, `velocityMs`, `motionProfile`, `motionExaggeration` |
| `mouseMove` | Smoothly move the cursor; with `mouseButton`, a held button stays held, an up button is pressed and released | `destinationX`, `destinationY` |
| `pointerPath` | Move through waypoints as one gesture, pressing and releasing a button once | `waypoints` (JSON array of `{x, y, durationMs?, dwellMs?}`) |
| `moveTo` | Move the pointer to a semantic position relative to the element | `position` plus optional motion settings |
| `diagnose` | Capture element metadata, window inventory, and cursor state in one call | — |
| `setFocus` | Set keyboard focus | — |
| `highlight` | Flash/highlight the element | — |
| `clipboard` | Read or write system clipboard | `clipboardAction` (+ `clipboardText` for write) |

### Key Combination Format

Use `+` as separator: `"Ctrl+S"`, `"Shift+Tab"`, `"Alt+F4"`, `"Enter"`, `"Escape"`.

### Examples

```
interact sessionId="..." action="click" elementId="e_btn1"
interact sessionId="..." action="type" elementId="e_txt1" value="Hello World"
interact sessionId="..." action="sendKeys" elementId="e_txt1" keys="Ctrl+A"
interact sessionId="..." action="sendKeys" keys="Ctrl+Shift+K"
interact sessionId="..." action="sendKeys" keys="Enter" windowHandle="0x1A4F"
interact sessionId="..." action="type" value="console.log('hello')"
interact sessionId="..." action="mouseDown" mouseButton="left"
interact sessionId="..." action="mouseUp" destinationX=920 destinationY=460 mouseButton="left"
interact sessionId="..." action="select" elementId="e_combo1" value="Option B"
interact sessionId="..." action="dragTo" elementId="e_src" targetElementId="e_dest"
interact sessionId="..." action="mouseMove" destinationX=500 destinationY=300
interact sessionId="..." action="mouseMove" destinationX=800 destinationY=600 sourceX=100 sourceY=200 mouseButton="left" durationMs=1000
interact sessionId="..." action="mouseMove" destinationX=920 destinationY=460 motionProfile="exaggerated" motionExaggeration=85
interact sessionId="..." action="mouseMove" destinationX=920 destinationY=460 mouseButton="left"
interact sessionId="..." action="keyDown" keys="Ctrl"
interact sessionId="..." action="keyUp" keys="Ctrl"
interact sessionId="..." action="pointerPath" waypoints='[{"x":400,"y":300},{"x":920,"y":460,"durationMs":600}]' mouseButton="left"
interact sessionId="..." action="hover" elementId="e_btn1" dwellMs=1000
interact sessionId="..." action="hover" elementId="e_btn1" motionProfile="hesitant" motionExaggeration=75
interact sessionId="..." action="hover" elementId="e_btn1" hoverMode="transit" approachFrom="left" velocityMs=300
interact sessionId="..." action="moveTo" elementId="e_btn1" position="outside-right" offsetPx=24
interact sessionId="..." action="click" elementId="e_text1" escalate=true
interact sessionId="..." action="click" elementId="e_btn1" clickStrategy="contentCenter" requireTargetHit=true
interact sessionId="..." action="click" elementId="e_btn1" expectedEffect="windowOpened" effectTimeoutMs=1000
interact sessionId="..." action="rightClick" elementId="e_header" expectedEffect="contextMenuOpened" effectTimeoutMs=1000
interact sessionId="..." action="hover" elementId="e_item1" expectedEffect="sameProcessWindowReplaced" effectTimeoutMs=1000
interact sessionId="..." action="hover" elementId="e_item1" expectedEffect="popupReplaced" effectTimeoutMs=1000
interact sessionId="..." action="click" name="Close" windowHandle="0x2B5E"
interact sessionId="..." action="click" elementId="stale-id" fallback=true by='{"automationId":"SubmitButton"}'
interact sessionId="..." action="click" elementId="e_btn1" collectEvidence=true
interact sessionId="..." action="hover" elementId="e_item1" collectWindowTimeline=true
interact sessionId="..." action="hover" elementId="e_item1" collectWindowTimeline=true timelineDurationMs=1000 timelineSampleIntervalMs=50
interact sessionId="..." action="diagnose" elementId="e_btn1"
interact sessionId="..." action="clipboard" clipboardAction="read"
```

For `click`, `doubleClick`, and `rightClick`, the response can include `targetElement`, click-point diagnostics, hit-test evidence, and optional `sameWindowEffect` or `effectObservation` metadata. Successful stale-element recovery adds `retriedAfterStaleElement: true`. Heuristic fallback recovery adds `fallbackUsed`, `fallbackConfidence`, and `originalSelectorDiagnostic`.

Set `detail` to choose how much a `click`, `doubleClick`, `rightClick` or `hover` returns. `minimal` returns `success`, `message`, the click or hover point and `effectType`, plus any sign that the action reached a different element. `standard` (the default) returns every diagnostic once: `windowInteractionMode` for the session's window on the first pointer action and when its mode changes, and window classification lists as handles. Other actions always return the full response. `full` repeats everything and adds `otherProcessAppearedElements`. Use `minimal` for long runs of clicks and `full` to investigate one that misbehaves.

Popup-host hit-test evidence can also include `nativeWindowHandle`, `nativeClassName`, `reconciliation`, and `hitRelation="popupHostAncestor"` when the click lands inside the requested popup target bounds but UIA resolves the popup host bridge rather than the leaf element.

When popup handoff is detected, the inline or explicit effect block can also include `openedSameProcessWindows`, `reusedSameProcessWindows`, `closedSameProcessWindows`, and `replacedWindowPairs` so agents can diagnose same-process popup replacement even when the visible window count stays flat. Auto-observation can classify those replacements as `popupReplaced` or `windowReplaced`, while the legacy explicit effect name `sameProcessWindowReplaced` remains supported.

When `expectedEffect="contextMenuOpened"`, Drive.NET also returns `contextMenuCandidates` when it can identify menu-like subtree elements after the right-click.

When `collectWindowTimeline=true`, each sampled window entry can also include `boundsSource`, `nativeWindowRect`, `uiaBoundingRect`, `boundsDeltaFromNative`, `dwmExtendedFrameBounds`, optional `appMetadataBounds`, and `suspectReusedPopup` so popup animation diagnostics preserve native-vs-UIA-vs-DWM-vs-app-metadata provenance. When a reused popup host is corrected to `boundsSource="appMetadata"`, the hover payload, `primaryCandidateWindow`, replacement diagnostics, and timeline sample `bounds` all use the corrected popup screen rect while the raw sentinel host rectangle remains preserved in `nativeWindowRect`.

If the target process exits during an interaction, the response can also append `processExited`, `terminationReason`, optional exit-code fields, and `crashEvidence` when Drive.NET can correlate target-app dumps, crash logs, or Windows Application event entries.

## Rules

- Use `inspect` before interacting when there is any doubt about the element's capabilities.
- Use `highlight: true` to visually confirm which element will be acted on.
- `type` clears existing text then types. Use `sendKeys` to append or send shortcuts.
- Use `scrollIntoView` before clicking offscreen elements.
- After reconnecting a session, all element IDs must be reacquired.
- For context menus or ambiguous hit targets, prefer `rightClick` with `expectedEffect="contextMenuOpened"` and inspect the returned click diagnostics plus any `contextMenuCandidates`, `openedSameProcessWindows`, or `replacedWindowPairs`.
- Use `mouseDown` and `mouseUp` for held-button workflows such as crosshair pickers or multi-step drags. When you omit coordinates, Drive.NET uses the current cursor position.
- `mouseMove` with `mouseButton="left"` is a whole drag when the button is up (pressed at the start, released at the end). After `mouseDown` the button stays held through each move, so a drag spans several calls until `mouseUp`; the response says which with `buttonHandling` (`pressedAndReleased` or `keptHeld`).
- Hold a modifier during a drag with `keyDown` and `keyUp` (`keys="Ctrl"`). Cancel a held drag with window-level `sendKeys` (`keys="Escape"`) before `mouseUp`. The session releases any button or key still held when it ends.
- Generic held-button drags are proven on plain WinUI pointer surfaces, but popup-hosted flyouts or detached popup windows may still apply app-specific release or capture logic on `mouseUp`. Always verify the post-release popup visibility, bounds, or app state instead of assuming the drop persisted.
- For popup-hosted drags, capture the popup `windowHandle` first, query against that window, and compare `window list` before and after release.
- Use `motionProfile` to set the baseline feel of `mouseMove`, `hover`, and `moveTo`: `steady` stays straighter, `natural` is the default, `exaggerated` uses broader arcs and correction, and `hesitant` introduces more uneven cadence.
- Use `motionExaggeration` to adjust how much drift, timing variation, and corrective motion Drive.NET adds on top of the selected profile.
- For selector-based interact (selector fields instead of `elementId`), pass `windowHandle` to scope resolution to a secondary window, dialog, or popup — the same window root `query find` uses. A selector that targets a secondary window resolves to nothing under the session root, so scope it with `windowHandle` (the zero-match error hints this when no handle was supplied).
- When a selector matches more than one element, interact returns `matchCount` and a `candidates` array instead of acting; set `matchIndex` (1-based) to pick one, or narrow the selector — no need to re-run `query find`.
- `sendKeys` and `type` can be used without `elementId` or selector fields to send keystrokes directly to the foreground window — useful for browser content or other surfaces with no UIA element tree.
- When using window-level `sendKeys` or `type`, pair with `window bringToFront` to ensure the correct window has focus.
- Coordinates in `mouseMove`, `hover`, and `boundingRect` use the same DPI-aware screen coordinate space.
- Pointer actions include click or hover diagnostics such as `clickPoint`, `clickResolution`, `elementAtClickPoint`, and hit-test evidence.
- Use `escalate: true` when the target element does not own the needed UIA pattern (for example a TextBlock inside a clickable container).
- Use `fallback=true` with a `by` selector when a cached element ID may go stale. Drive.NET first tries the exact `by` selector and only then falls back to heuristic recovery.
- Use `hoverMode="transit"` for controls that depend on authentic pointer-entry sequences.
- Use `moveTo` with an `outside-*` or `off-window` position when you need to leave a hover target cleanly.
- Use `requireTargetHit=true` when you need to distinguish reliable clicks from host-surface misses.
- When `hitRelation="popupHostAncestor"`, inspect `preActionHitTest.reconciliation`, `nativeWindowHandle`, and `nativeClassName` before treating the click as a miss. That combination usually means the click reached the correct popup host but UIA resolved the host bridge rather than the leaf control.
- Use `expectedEffect="contextMenuOpened"` for right-click flows where the menu might appear as either subtree content or a popup window. Use `expectedEffect="windowOpened"` when any newly visible same-process window is sufficient, `expectedEffect="sameProcessWindowReplaced"` for the legacy replacement contract, `expectedEffect="windowReplaced"` for a generic dedicated replacement signal, and `expectedEffect="popupReplaced"` when you specifically expect popup-host handoff.
- Use `expectedEffect` and `collectEvidence` when debugging whether an interaction actually caused the UI change you expected.
- Use `collectWindowTimeline=true` during `hover` to observe popup window animation — the timeline reveals when a tooltip or flyout window stabilises its position.
- After a hover that opens a popup, check `primaryCandidateWindow` (the newly visible window closest to the hover point) and pass its `windowHandle` to `query` to inspect popup content.
- `reusedSameProcessWindows` in the hover response reveals hidden popup host windows that became visible — common in WinUI 3 and WPF apps.
- Check `closedSameProcessWindows` and `replacedWindowPairs` when a popup seems to morph or hand off to another host window instead of simply opening a net-new HWND.
- When `sameWindowEffect` reports `uiChangeObserved=true` but the top-level `uiChangeObserved` was initially `false`, Drive.NET promotes the top-level field to `true`. This happens when the initial before/after snapshot comparison misses a delayed popup transition that the 800ms polling window catches.
- When timeline or hover geometry looks suspicious, compare `boundsSource`, `nativeWindowRect`, `uiaBoundingRect`, and `dwmExtendedFrameBounds` rather than assuming the raw UIA rect is authoritative. When `suspectReusedPopup` is `true`, fall back to app-emitted `helpText` or `itemStatus` for authoritative popup position.
- When `expectedEffect` is omitted, auto-observation defers in-app UI changes while continuing to poll for cross-process windows. This detects browser launches even when no other app windows were visible before the click.
- If an interaction response includes `processExited: true`, do not keep retrying the dead session. Call `session status` with the same `sessionId` to retrieve the durable `crashEvidence` block, then relaunch or `reconnect` only after you have captured the failure context.

## Complex Interaction Patterns

### Right-Click Context Menu

```
interact sessionId="..." action="rightClick" elementId="e_listItem" expectedEffect="contextMenuOpened"
query sessionId="..." action="find" by='{"controlType":"MenuItem","name":"Delete"}'
interact sessionId="..." action="click" elementId="e_menuDelete"
```

### Keyboard-Driven Form Navigation

```
interact sessionId="..." action="setFocus" elementId="e_firstField"
interact sessionId="..." action="sendKeys" elementId="e_firstField" keys="Tab"
interact sessionId="..." action="sendKeys" elementId="e_submit" keys="Enter"
```

### Stale-Element Recovery

```
interact sessionId="..." action="click" elementId="e_oldButton" fallback=true by='{"automationId":"SubmitButton"}'
```

### Hover-Open Then Leave

```
interact sessionId="..." action="hover" elementId="e_infoIcon" hoverMode="transit" approachFrom="top"
wait_for sessionId="..." condition="childAppeared" elementId="e_infoIcon" automationId="TooltipPopup" timeoutMs=3000
interact sessionId="..." action="moveTo" elementId="e_infoIcon" position="outside-right"
```

### Hover Flyout Handoff Between Neighbouring Panels

When hovering directly from one flyout-triggering element to a neighbouring one (e.g., appbar chips), Drive.NET uses a smooth exit path and then re-approaches horizontally to trigger a clean `WM_MOUSELEAVE` / `PointerExited` on the old popup before entering the new target. The effect observation polling detects the popup replacement even when the initial before/after window snapshot misses the asynchronous transition.

```
interact sessionId="..." action="hover" elementId="e_panel2" expectedEffect="popupReplaced"
```

Key behaviors:
- For top-edge elements (near y=0), the settle point approaches horizontally from the left of the target rather than vertically, keeping the approach path inside the appbar band and outside the popup zone below.
- Smooth mouse movement (not `SetCursorPos` teleport) is used to exit the previous hover region, ensuring WinUI popup windows receive reliable `WM_MOUSELEAVE`.
- The `sameWindowEffect` polling (800ms window) catches delayed popup transitions and promotes `uiChangeObserved` to `true` at the top level, even when the initial snapshot comparison saw identical windows.
- Same-handle popup hosts that reposition (bounds change without handle change) are detected as replacement pairs in `replacedWindowPairs`.

### Diagnostic Click With Evidence

```
interact sessionId="..." action="click" elementId="e_btn1" clickStrategy="contentCenter" requireTargetHit=true expectedEffect="windowOpened" collectEvidence=true
```
