---
name: drivenet-doc-screenshots
description: "Use this skill to capture screenshots for product documentation, stage them safely under `.drive-net`, and promote approved images into the repository's real docs asset folder. Covers Drive.NET `capture` and `window` usage, element padding for contextual screenshots, optional border and drop shadow, gradient rainbow backdrop for acrylic windows, PNG and JPEG encoding, repo inspection to find the right markdown image location, and workspace installation of the skill under `.github/skills`. Keywords: Drive.NET, documentation screenshot, docs image, markdown, capture, window, padding, border, shadow, gradientBackdrop, rainbow, acrylic, imageFormat, .drive-net, copy, asset folder, screenshot promotion, install skill, .github/skills."
argument-hint: "[screen or element] [docs page] [asset folder]"
user-invocable: true
---

# Drive.NET Documentation Screenshot Capture

Use this skill when the end goal is not just a screenshot, but a checked-in documentation image.

## Workflow

1. Inspect the repository's existing markdown files and image references before capturing anything. Reuse the established docs asset folder instead of inventing a new one.
2. Connect to the running app, bring the target window to the front, and wait for the UI state you want to document.
3. Capture into `.drive-net` first with `format="file"`. Treat `.drive-net` as a staging area, not the final docs location.
4. Review the staged PNG. If the full window is noisy, recapture with `target="element"` or a specific `windowHandle`.
5. Copy or move the approved PNG from `.drive-net` into the repository's actual docs asset folder, then update markdown image references if the caller asked for docs edits.

## Capture Rules

- Use `window bringToFront` before `capture` so the target is not obscured.
- Restore minimized windows before capturing.
- Window captures automatically trim invisible non-client resize borders when DWM reports a tighter visible frame, which avoids opaque black edge bands from raw window-rect capture.
- Prefer `target="element"` when the docs only need one control, panel, or dialog region.
- To document a WinUI acrylic flyout, context menu, or dropdown that captures blank via window/element targeting, read its bounds (`window list roleFilter="popups"`) and use `target="screenRegion"` with those coordinates — it grabs the desktop rectangle directly so the popup renders correctly.
- Use `padding` (e.g. `padding=20`) on element captures to include surrounding UI context. Documentation screenshots almost always benefit from a few pixels of visual context around a focused element.
- Border is off by default and most screenshots do not need one. Use `borderThickness` (e.g. `borderThickness=2`) and optional `borderColor` only when the screenshot needs a visible border to stand out on a white page.
- Use `shadow=true` to add a drop shadow (strength 55) that gives depth on white doc backgrounds. Shadow is primarily used for documentation screenshots and examining visual evidence.
- GitHub README caveat: on GitHub dark theme, inline markdown images are composited onto a dark page background and often downscaled. A dark drop shadow can then read like a thick black border around the window. For README assets, prefer `shadow=false` unless the rendered GitHub page looks correct.
- `gradientBackdrop` is enabled by default and places a rainbow gradient behind acrylic or transparent window regions. Pass `gradientBackdrop=false` when you want to preserve raw alpha or when the app window is fully opaque.
- Prefer `imageFormat=\"png\"` (default) for docs assets since PNG preserves sharp text and transparency. Use `imageFormat=\"jpg\"` only when file size is a priority and transparency is not needed.
- Prefer stable filenames that describe the UI state, such as `login-dialog.png` or `workspace-fix-banner.png`.
- Keep screenshots free of private data. Stage the UI with fictional data before capturing; see **Private Data** below.
- Do not assume `docs/images` is correct. Inspect the repo and follow the existing asset pattern.
- Use standard Markdown image syntax for docs: `![alt text](path/to/image.png)`. Do not use HTML `<img>` or `<p>` tags.

### Private Data

A documentation screenshot publishes the desktop it was taken on. Once the image is committed, everything in it is as public as the docs, and a README image is usually mirrored wherever the README is published.

Private data is anything that belongs to the person or the machine taking the capture rather than to the product. It is wider than personal data:

- user names, including inside paths such as `C:\Users\<name>\...`;
- project, repository, workspace and folder names, and the layout of a source tree;
- window titles of other applications, and browser tab titles and address bars, wherever they appear: process lists, target pickers, window lists, title bars;
- log lines, file names, command lines, clipboard content, email addresses, tokens, IP addresses and host names.

Stage the state before capturing. Do not rely on noticing private data afterwards:

1. Fill lists from fictional data made for the capture: fictional project and workspace names (Contoso, Fabrikam, Northwind) under a neutral root, such as a drive letter mapped with `subst`, and a scratch data directory when the app supports one.
2. For a list of running processes or windows, launch the apps you want shown and apply a filter that matches only them. Never capture an unfiltered list of the real desktop.
3. Choose a page that does not show machine paths, or stage those paths too. An install location, a log path or a settings page usually contains the user name.
4. Navigate the staged app through UI Automation patterns rather than pointer clicks, and keep its window in front while you do. `interact action="select"` on a navigation list, with the item's name as `value`, selects the item through its selection pattern, and element-targeted `type` sets a box's value directly. `click` uses an element's Invoke pattern when it has one, but sends a real pointer click to a Windows Forms button or to an element without Invoke, and `select` does the same for an item with neither pattern. A pointer click lands in whatever window covers that point of the screen.

Before promoting a capture:

1. Open the staged image and read every row, title bar, status bar and log line in it.
2. If any private data appears, discard the capture, restage the UI, and capture again. Do not crop or blur a committed image instead: the original stays in version history.
3. If a private image was already committed or published, replace it, and tell the user that the old image remains in the history of every repository and mirror it reached.
4. Tell the user which file was affected and what it showed, and do not keep a capture with private data in it on your own judgement.

## Taking Effective Screenshots

Good documentation screenshots are not just evidence — they sell the product. Every screenshot should make the reader want to try what they see.

### Prepare Interesting State

- **Never screenshot empty or default views.** An empty list, a blank tree, or a "no data" placeholder tells the reader nothing. Navigate the app to a state that shows populated, real-looking content first.
- **Fill dashboards with data.** If the screenshot shows a workspace list, ensure several workspaces are configured with visible health badges. If it shows analysis results, connect to a target that produces findings.
- **Expand hierarchies.** When capturing tree views, expand at least 2-3 levels deep and select a node so the property/detail panel is populated, not empty.
- **Trigger visual feedback.** Show score badges, colour-coded status indicators, severity-grouped findings, or filter results rather than a neutral starting state.
- **Select something.** When the UI has a main/detail layout, select an item so both panes show content. A split view with an empty detail pane wastes half the screenshot.

### Choose the Right Scope

- **Full window** for hero/overview screenshots that show the complete product surface.
- **Element with padding** for feature-specific shots where the full window is noisy — capture just the relevant panel or dialog with enough surrounding context to orient the viewer.
- **Multiple focused captures** over one cluttered window when a feature spans several UI areas.

### Use Effects Deliberately

- **Shadow** (strength 55) works well for window-level captures destined for light-background docs or standalone viewing — it lifts the screenshot off the page. Also useful when examining visual evidence.
- **GitHub dark-theme caution**: inline README images are shown against a dark background and frequently downscaled. That can compress a black shadow into what looks like a heavy border. When the target audience will view the image on GitHub, verify the rendered README first and prefer `shadow=false` if the outline looks too harsh.
- **Border** is off by default and most screenshots do not need one. Use it only when the screenshot background blends with the page background (e.g. a dark-themed app on a dark docs theme). A thin `borderThickness=1` with a subtle colour like `#404040` frames without distracting.
- **Combine shadow + border** for polished hero screenshots. Apply shadow first, then border — Drive.NET renders them in that order automatically.
- **Gradient backdrop** is on by default. For acrylic or semi-transparent windows, a diagonal rainbow fills in behind transparent pixels so the screenshot is visually complete instead of showing a blank or checkerboard background. Disable with `gradientBackdrop=false` when the target window is fully opaque or when raw alpha is needed.
- **Skip effects** when the screenshot will be embedded in a coloured callout or card that already provides visual separation.

### Markdown Image References

Use standard Markdown syntax for embedding screenshots in docs:

```markdown
![Helper workspace dashboard showing managed workspaces with health status](docs/images/helper-workspaces.png)
```

Do not use HTML `<img>` tags, `<p align="center">`, or inline `width` attributes. Let the rendering platform handle image sizing.

### Contextual Captions

When inserting screenshots into documentation that is actively being written or updated, add a brief descriptive sentence immediately before the image reference that explains what the screenshot shows and why it is relevant to the reader. Screenshots should not float standalone without surrounding text.

Good:

```markdown
The Workspaces dashboard shows all managed workspaces with health status badges:

![Helper workspace dashboard showing managed workspaces with health status](docs/images/helper-workspaces.png)
```

Bad — image floats with no visible context:

```markdown
![Helper workspace dashboard showing managed workspaces with health status](docs/images/helper-workspaces.png)
```

The caption should be plain prose, not a heading. Keep it to one or two sentences. The alt text on the image itself is for accessibility and may repeat some of the caption wording — that is fine.

## Minimal MCP Pattern

```text
window sessionId="..." action="bringToFront"
capture sessionId="..." format="file" filePath="docs-staging/login-dialog.png"
```

### Element With Context and Border

```text
window sessionId="..." action="bringToFront"
capture sessionId="..." target="element" elementId="e_settingsPanel" padding=20 borderThickness=2 format="file" filePath="docs-staging/settings-panel.png"
```

### Window With Shadow

```text
window sessionId="..." action="bringToFront"
capture sessionId="..." shadow=true format="file" filePath="docs-staging/main-window.png"
```

### README Window Without Shadow

```text
window sessionId="..." action="bringToFront"
capture sessionId="..." shadow=false gradientBackdrop=true format="file" filePath="docs-staging/readme-main-window.png"
```

Drive.NET normalizes the staged file beneath the workspace `.drive-net` directory even when you provide a custom `filePath` hint.

## Promotion Guidance

- Check nearby markdown files for existing image references before choosing a destination.
- Prefer the same docs asset folder used by adjacent pages.
- Treat `.drive-net` screenshots as transient artifacts until the image is approved.
- After approval, copy or move the PNG into the checked-in docs asset folder and keep the markdown link relative to the page's existing convention.

## Installation In Another Workspace

- Keep the skill in its own folder: `.github/skills/drivenet-doc-screenshots/SKILL.md`.
- Bundled installs copy every `drivenet-*` skill folder into the target workspace's `.github\skills` directory.
- To install all bundled Drive.NET skills into a workspace, run `Install-DriveNet.ps1 -WorkspaceRoot <workspace> -NonInteractive` or `copilot\Install-DriveNetSkill.ps1 -WorkspaceRoot <workspace>`.
- If you are copying manually, copy the entire `drivenet-doc-screenshots` folder into the target workspace's `.github\skills` directory. Do not copy only the markdown file.

## Repository References

- [docs/tools/capture.md](../../../docs/tools/capture.md)
- [docs/README.md](../../../docs/README.md)
- [src/DriveNet.Server/Deployment/Install-DriveNetSkill.ps1](../../../src/DriveNet.Server/Deployment/Install-DriveNetSkill.ps1)