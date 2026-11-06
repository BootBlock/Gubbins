---
name: drivenet-capture
description: "Use this skill to capture screenshots of windows, UI elements, or an arbitrary screen region in a Windows desktop app through Drive.NET. Covers the 'capture' MCP tool with window, element, and screenRegion targeting, the screenRegion escape hatch for acrylic flyouts and popups that composite blank, automatic file fallback for oversized inline captures, element padding for contextual screenshots, optional border and drop shadow, gradient rainbow backdrop for acrylic windows, PNG and JPEG encoding, base64 inline image and file output formats, including workspace-safe `.drive-net` artifact writes. Keywords: Drive.NET, capture, screenshot, image, base64, PNG, JPEG, JPG, window, element, screenRegion, region, popup, flyout, acrylic, blank capture, padding, border, shadow, gradientBackdrop, rainbow, imageFormat, visual evidence, file, photo, .drive-net."
argument-hint: "[goal] [window or element target]"
user-invocable: true
---

# Drive.NET Screenshot Capture

Use this skill when you need to capture visual evidence of a Windows desktop application's state.

## `capture` Tool

Capture screenshots of windows or specific UI elements. Window captures automatically trim invisible non-client resize borders when DWM reports a tighter visible frame.

### Parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `sessionId` | string | Yes | — | Session ID from `session connect`. |
| `target` | string | No | `"window"` | `"window"`, `"element"`, or `"screenRegion"`. |
| `elementId` | string | No | — | Element ID to capture. Required when `target` is `"element"`. |
| `regionX` | int | No | — | Left screen coordinate. Required when `target` is `"screenRegion"`. |
| `regionY` | int | No | — | Top screen coordinate. Required when `target` is `"screenRegion"`. |
| `regionWidth` | int | No | — | Width in pixels (positive). Required when `target` is `"screenRegion"`. |
| `regionHeight` | int | No | — | Height in pixels (positive). Required when `target` is `"screenRegion"`. |
| `format` | string | No | `"base64"` | `"base64"` (returns inline MCP image) or `"file"` (saves to disk). When a `base64` capture would exceed the inline response budget it is auto-saved to a decoded PNG under `.drive-net` and the file path is returned instead. |
| `filePath` | string | No | auto-generated | File path hint. Required when `format` is `"file"` unless auto-generation is acceptable. Drive.NET normalizes the result under the workspace-root `.drive-net` directory. Extension is adjusted to match `imageFormat`. |
| `windowHandle` | string | No | main window | Window handle from `window list`. Defaults to the session's main window. |
| `padding` | int | No | `0` | Pixels of surrounding context to include around an element capture. Ignored for window captures. The capture region is expanded by this many pixels on each side and clamped to virtual screen bounds. |
| `borderThickness` | int | No | `0` | Border thickness in pixels. `0` (default) disables the border — most screenshots do not need one. |
| `borderColor` | string | No | `"#000000"` | Border color as a hex string (e.g. `"#FF0000"`) or a named color. Only applied when `borderThickness` > 0. |
| `shadow` | bool | No | `false` | When `true`, adds a soft drop shadow (strength 55) behind the screenshot. Primarily used for documentation screenshots and examining visual evidence. On GitHub dark theme, inline README rendering can make that dark shadow read like a thick border when the image is scaled down. |
| `gradientBackdrop` | bool | No | `true` | When `true`, places a diagonal rainbow gradient behind windows that contain transparent or semi-transparent pixels (e.g. acrylic). Set to `false` to keep raw alpha. |
| `imageFormat` | string | No | `"png"` | Image encoding format: `"png"` (default, preserves alpha) or `"jpg"`. |

### Base64 Response (default)

The result holds two content blocks. The first is an MCP `image` block, which a client shows to
the model as a picture:

```json
{ "type": "image", "mimeType": "image/png", "data": "iVBORw0KGgo..." }
```

The second is a `text` block that describes the image. It holds no image data:

```json
{
  "mimeType": "image/png",
  "width": 800,
  "height": 600,
  "sizeBytes": 45678
}
```

### File Response

```json
{
  "filePath": "...\\.drive-net\\captures\\capture.png",
  "width": 800,
  "height": 600,
  "sizeBytes": 45678
}
```

### Oversized base64 auto-fallback

When the default `base64` format is used and the encoded image would exceed the inline response
budget, Drive.NET saves a decoded PNG under `.drive-net` and returns the file path instead of an
image block:

```json
{
  "filePath": "...\\.drive-net\\window-capture-....png",
  "width": 986,
  "height": 823,
  "sizeBytes": 512345,
  "format": "file",
  "savedToFileReason": "The inline base64 image would exceed the MCP inline response budget, so Drive.NET saved a decoded image to .drive-net. Read the returned filePath directly."
}
```

Read the returned `filePath` directly.

### Examples

```
capture sessionId="..."
capture sessionId="..." target="element" elementId="e_panel1"
capture sessionId="..." target="element" elementId="e_panel1" padding=20
capture sessionId="..." target="screenRegion" regionX=2028 regionY=149 regionWidth=200 regionHeight=217
capture sessionId="..." format="file" filePath="captures/test.png"
capture sessionId="..." format="file"
capture sessionId="..." windowHandle="0x12D687"
capture sessionId="..." borderThickness=3 borderColor="#336699"
capture sessionId="..." shadow=true imageFormat="jpg"
capture sessionId="..." gradientBackdrop=false shadow=true
capture sessionId="..." target="element" elementId="e_panel1" padding=20 borderThickness=2 shadow=true
```

## Rules

- Use `window bringToFront` before capturing to ensure the window is not obscured by other windows.
- Window captures require a non-minimized target window. Restore the window first if capture reports that the window is minimized.
- Window captures automatically trim invisible non-client resize borders when DWM reports a tighter visible frame, which avoids opaque black edge bands from raw window-rect capture.
- For acrylic/DirectComposition flyouts, context menus, and popups: window capture auto-detects a fully transparent `PrintWindow` result and falls back to a live screen grab, but the guaranteed path is `target="screenRegion"` with the popup's bounds (from `window list` or `query bounds`). `screenRegion` reads the desktop rectangle directly, so it captures whatever is on screen at those coordinates even when window/element capture composites blank.
- Default `base64` format returns inline images that AI agents can view directly.
- Use `file` format for evidence you want to persist, or for larger screenshots.
- When `format` is `"file"`, Drive.NET writes captures under the workspace-root `.drive-net` folder.
- Explicit `filePath` values are normalized into `.drive-net` to avoid arbitrary file writes. Extensions are adjusted to match `imageFormat`.
- Use `padding` on element captures to include surrounding UI context. This is especially useful for documentation screenshots where a tightly cropped element lacks visual context.
- `borderThickness` and `shadow` can be combined. Shadow is rendered first, then the border frames the shadow+image composite.
- For README assets shown on GitHub, prefer `shadow=false` unless you verify the rendered page. GitHub dark theme can make a dark drop shadow read like a heavy border after inline scaling.
- `gradientBackdrop` is enabled by default and composites a rainbow gradient behind windows with transparent or semi-transparent pixels (e.g. acrylic glass). Disable with `gradientBackdrop=false` to preserve raw alpha. The gradient is applied before shadow and border.
- `imageFormat="jpg"` discards alpha and flattens transparency onto white before encoding. Use PNG (default) when alpha matters.
- A capture shows everything on screen. Before you keep or share one, read it for private data: user names and the paths that contain them, project, repository and folder names, other applications' window titles, and log lines, tokens or addresses. For a screenshot that will be published, stage the UI with fictional data before capturing, as the `drivenet-doc-screenshots` skill describes. If private data appears, tell the user which file it is and what it shows, and recapture rather than keep it.

## Complex Capture Patterns

### Before/After Visual Regression

Capture the window before and after an interaction to visually compare state:

```
capture sessionId="..." format="file" filePath="evidence/before.png"
interact sessionId="..." action="click" elementId="e_theme_toggle"
wait_for sessionId="..." condition="elementExists" automationId="themeApplied" timeoutMs=3000
capture sessionId="..." format="file" filePath="evidence/after.png"
```

### Capture Specific Elements for Focused Evidence

When a full window screenshot is too noisy, target a specific element:

```
capture sessionId="..." target="element" elementId="e_errorPanel"
```

### Multi-Window Capture

For apps with multiple windows, capture each by handle:

```
window sessionId="..." action="list"
capture sessionId="..." windowHandle="0x1A4F" format="file" filePath="evidence/main.png"
capture sessionId="..." windowHandle="0x2B5E" format="file" filePath="evidence/dialog.png"
```

### Capturing an Acrylic Flyout or Popup

When window/element capture of a WinUI acrylic flyout, context menu, or ComboBox dropdown comes
back blank, read the popup's bounds and grab that desktop rectangle directly:

```
window sessionId="..." action="list" roleFilter="popups"
capture sessionId="..." target="screenRegion" regionX=2028 regionY=149 regionWidth=200 regionHeight=217 format="file"
```
