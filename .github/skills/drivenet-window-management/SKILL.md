---
name: drivenet-window-management
description: "Use this skill to manage windows of a Windows desktop app through Drive.NET. Covers the 'window' MCP tool with actions: list, activePopup, blockers, dismissBlocker, resize, move, minimize, maximize, restore, close, bringToFront. Includes popup-host filters (`className`, `ownerHandle`, `visibleOnly`, `roleFilter`), selecting the current popup with freshness metadata, detecting secondary surfaces by comparing window lists, and native-vs-UIA bounds provenance for popup hosts. Keywords: Drive.NET, window, list, activePopup, blockers, dismissBlocker, resize, move, minimize, maximize, restore, close, bringToFront, dialog, modal, child window, secondary surface, flyout, retarget, className, ownerHandle, visibleOnly, roleFilter, appWindows, popups, boundsSource, boundsNote, nativeWindowRect, appMetadataBounds."
argument-hint: "[goal] [window action like list/resize/bringToFront]"
user-invocable: true
---

# Drive.NET Window Management

Use this skill when you need to list, reposition, resize, or manage the state of application windows, or detect secondary UI surfaces like dialogs and flyouts.

## `window` Tool

### Parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `sessionId` | string | Yes | — | Session ID from `session connect`. |
| `action` | string | Yes | — | `"list"`, `"activePopup"`, `"blockers"`, `"dismissBlocker"`, `"resize"`, `"move"`, `"minimize"`, `"maximize"`, `"restore"`, `"close"`, or `"bringToFront"`. |
| `windowHandle` | string | No | — | Window handle from a `list` result. Required for `resize`, `move`, `minimize`, `maximize`, `restore`, `close`, and `bringToFront`; optional for `dismissBlocker`. Not used by `list`, `activePopup`, or `blockers`. |
| `width` | int | No | — | New width in pixels (for `resize`). A minimized window stays minimized and takes the new size when restored. |
| `height` | int | No | — | New height in pixels (for `resize`). |
| `x` | int | No | — | New X position in screen pixels (for `move`). A minimized window stays minimized and takes the new position when restored. |
| `y` | int | No | — | New Y position in screen pixels (for `move`). |
| `buttonName` | string | No | — | Preferred button caption or automation ID for `dismissBlocker`, for example `"Continue"`. |
| `includeHidden` | bool | No | `false` | When `true`, the `list` action includes hidden and zero-size windows in addition to visible ones. Hidden windows have `isVisible: false`. Useful for discovering popup host windows that an app creates but keeps invisible until triggered. |
| `className` | string | No | — | Exact class-name filter for `list` or `activePopup`. Useful for narrowing popup-host families such as `PopupWindowSiteBridge` or `Pop-upHost`. |
| `ownerHandle` | string | No | — | Owner window handle filter for `list` or `activePopup`. Matches popup or flyout windows owned by the specified parent window. |
| `visibleOnly` | bool | No | `false` | For `list` or `activePopup`, restrict the result to strictly visible windows even when `includeHidden=true`. |
| `roleFilter` | string | No | `"all"` | Role filter for `list`: `"all"` (every window), `"appWindows"` (top-level app windows — drops owned popups, tool windows, and system/IME noise like `Default IME`, `MSCTFIME UI`, `GDI+ Window`, `.NET-BroadcastEventWindow`), or `"popups"` (owned popup/flyout hosts only). Use `appWindows` or `popups` to avoid scanning the firehose that `includeHidden=true` returns. |

### `list` Response

```json
{
  "windows": [
    {
      "windowHandle": "0x12D687",
      "title": "My Application",
      "left": 100, "top": 100,
      "width": 800, "height": 600,
      "right": 900, "bottom": 700,
      "boundsSource": "nativeWindowRect",
      "nativeWindowRect": { "left": 100, "top": 100, "width": 800, "height": 600, "right": 900, "bottom": 700 },
      "isVisible": true,
      "isMinimized": false,
      "isMaximized": false,
      "isModal": false,
      "isTopmost": false,
      "className": "WinUIDesktopWin32WindowClass",
      "ownerHandle": null,
      "dpi": 144,
      "scaleFactor": 1.5,
      "zOrder": 0,
      "addressBarUrl": null
    }
  ]
}
```

When a window's UIA bounds differ materially from its native HWND geometry, `list` also includes `uiaBoundingRect` and `boundsDeltaFromNative`. When bounds come from a non-native source, `boundsNote` explains why (e.g. appMetadata popup parking, UIA-sourced bounds, DWM extended frame bounds); it is `null` for the common `nativeWindowRect` case. When native bounds look like a hidden popup sentinel and UIA is also origin-like, `list` includes `dwmExtendedFrameBounds` when DWM compositor bounds are available and differ. If native, UIA, and DWM all stay sentinel-style for a visible popup host, Drive.NET searches the popup subtree for app-emitted metadata such as `helpText="...; popup=x,y,w,h"`; when found, `boundsSource` becomes `appMetadata` and `appMetadataBounds` contains the parsed popup rect. Use these fields for popup-host diagnostics instead of assuming the flat `left/top/width/height` values came from UIA.

For browser windows, `addressBarUrl` contains the current address bar URL text when readable via UI Automation; it is `null` for non-browser windows.

### Examples

```
window sessionId="..." action="list"
window sessionId="..." action="list" roleFilter="popups"
window sessionId="..." action="list" roleFilter="appWindows"
window sessionId="..." action="list" includeHidden=true className="Pop-upHost" ownerHandle="0x12D687" visibleOnly=true
window sessionId="..." action="activePopup" includeHidden=true className="Pop-upHost" ownerHandle="0x12D687"
window sessionId="..." action="blockers"
window sessionId="..." action="dismissBlocker" buttonName="Continue"
window sessionId="..." action="resize" windowHandle="0x12D687" width=1024 height=768
window sessionId="..." action="move" windowHandle="0x12D687" x=0 y=0
window sessionId="..." action="minimize" windowHandle="0x12D687"
window sessionId="..." action="maximize" windowHandle="0x12D687"
window sessionId="..." action="restore" windowHandle="0x12D687"
window sessionId="..." action="bringToFront" windowHandle="0x12D687"
window sessionId="..." action="close" windowHandle="0x12D687"
window sessionId="..." action="list" includeHidden=true
```

## Detecting Secondary Surfaces

When an interaction opens a dialog, flyout, or settings pane, determine whether it is a new top-level window or an in-shell panel:

1. Snapshot `window list` **before** triggering the surface.
2. Trigger the open action (click a button, menu item, etc.).
3. Compare `window list` **after** the trigger.
4. **New window appeared**: query it directly via the new window handle.
5. **No new window**: the surface is hosted inside the main window — search for in-shell root markers (title text, search box, close button) using `query find`.
6. After dismissing the surface, verify the close post-condition (window removed or in-shell markers gone).

## Rules

- Always `list` first to get window handles before other window actions.
- Use `activePopup` when the process keeps reused popup hosts around and you need the best current popup candidate with freshness metadata in one call.
- `resize` requires both `width` and `height`; `move` requires both `x` and `y`. Both read the window back and return `bounds` and `windowState`, with `success: false` when the window did not take the requested geometry. On a minimized window they set the rectangle it takes when restored (`boundsKind: "restored"`) and leave it minimized.
- Use `className`, `ownerHandle`, and `visibleOnly` together to isolate popup or flyout families when historical popup hosts remain listed as hidden windows.
- Use `roleFilter="popups"` to list only owned popup/flyout hosts, or `roleFilter="appWindows"` to list only real app windows. Both drop system/IME noise (`Default IME`, `MSCTFIME UI`, `GDI+ Window`, `.NET-BroadcastEventWindow`) that `includeHidden=true` otherwise returns.
- Check `isModal` in the list response — modal dialogs block interaction with other windows.
- Use `blockers` when you want a focused summary of blocking modal windows and suggested recovery actions.
- Use `dismissBlocker` for one-shot blocker recovery. If you know the preferred button text or automation ID, pass it as `buttonName`; otherwise Drive.NET clicks the button that closes the dialog without acting on its content, preferring Cancel, Close, OK, Continue and No in that order (on a Win32 `#32770` dialog it recognises Cancel by AutomationId `2` in any language). When no such button exists it clicks nothing and fails with a message listing the buttons to pass as `buttonName`.
- `dismissBlocker` reports `success: true` only when the blocker closed within 2 seconds of the click; otherwise `success` is `false` and the message says the blocker is still open.
- When the session window renders Chromium content, `blockers` also reports a modal web dialog (`role="dialog"` with `aria-modal="true"`) as a blocker with `classification: "contentDialog"`, `ownerRelationship: "contentOfSessionRoot"`, the session window's `windowHandle` and a `dialogElementId`. Top-level window blockers are listed first.
- Use `bringToFront` before `capture` to ensure the window is visible. The result includes `foregroundOutcome` (`foregroundConfirmed`, `foregroundTransient`, or `foregroundLost`) and, when focus was stolen, a `competingWindow` block identifying the window that took focus.
- Use `restore` to un-minimize a window before interacting with its elements.
- `minimize`, `maximize`, and `restore` report the observed `windowState` and the `expectedState`, and `close` reports `closeOutcome` (`closed`, `hidden`, or `stillOpen`) and `isEnabled`. `success` is `false` when the window did not change state or did not close, so read it before assuming the window is gone.
- When `close` returns `closeOutcome: "stillOpen"` with `isEnabled: false`, the application opened a prompt over the window: find it with `blockers` and answer it with `dismissBlocker`. With `isEnabled: true`, run `list` again after a short delay if the application may still be closing.
- When popup-host geometry looks suspicious, compare `nativeWindowRect`, `uiaBoundingRect`, `dwmExtendedFrameBounds`, and `appMetadataBounds` first. Drive.NET usually reports the native window rect as authoritative, but on reused popup hosts it can prefer `uiaBoundingRect`, `dwmExtendedFrameBounds`, or `appMetadata` when the popup subtree exposes better geometry.
- For popup-hosted drag workflows, snapshot `list` before the release and again after `mouseUp`. If the same popup host moved while held but returns hidden at its anchor after release, the app's own popup release or capture logic rejected or reverted the drop.
- When `boundsSource` is `appMetadata`, Drive.NET used popup geometry parsed from app-emitted UIA metadata because the raw Win32/UIA/DWM path stayed on the hidden-popup sentinel.
- When `suspectReusedPopup` is `true` and `appMetadataBounds` is absent, use app-emitted `helpText` or `itemStatus` for authoritative popup geometry.
- If the rest of the workflow should stay on a different top-level window in the same process, follow `window list` with `session retarget`. Pass `alias` on retarget to name the window for quick switching later.

## Complex Window Patterns

### Multi-Window Application Testing

For apps that spawn multiple windows (e.g., MDI or tool windows), snapshot the window list before and after an action:

1. Call `window list` and store the set of handles.
2. Perform the action that opens a new window (e.g., click a menu item).
3. Call `wait_for condition=windowOpened`.
4. Call `window list` again and diff against the snapshot to find the new handle.
5. Use `query find` with the new window's elements to interact, or `session retarget` if subsequent operations should use that window as the default root.

### Responsive Layout Testing

Resize the window to test responsive breakpoints:

```
window sessionId="..." action="resize" windowHandle="0x1A4F" width=320 height=480
window sessionId="..." action="resize" windowHandle="0x1A4F" width=1920 height=1080
```

After each resize, use `query find` or `capture` to verify the UI adapted correctly.

### Dialog and Modal Flow

When interacting with modal dialogs, always handle them before attempting to interact with the parent window:

```
window sessionId="..." action="list"
window sessionId="..." action="blockers"
window sessionId="..." action="dismissBlocker" buttonName="Continue"
```

Check `isModal: true` — if a modal is present, interact with it first. Closing a modal restores focus to the parent.

If the modal will host several follow-up steps, retarget the session to that modal window before querying and interacting repeatedly.

When the target process exits, `window list` returns an empty `windows` array plus `processExited` metadata instead of leaving callers to infer a dead session from follow-up failures.
