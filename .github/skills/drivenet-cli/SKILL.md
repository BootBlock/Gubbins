---
name: drivenet-cli
description: "Use this skill to run Drive.NET CLI commands for one-shot desktop automation tasks from the terminal. Covers doctor, discover, pick, desktop, windows/window, find, inspect, interact, tree, wait_for, batch, playback, capture, demo, report, snapshot, test, lifecycle, assert, observe, record, overlay, and scaffold workflows, including window blocker assessment, selector diagnostics via --explain, deterministic target selection, replay helpers, session-start warning mode selection, automation overlay begin/finish workflow and progress, mouseDown, mouseUp, keyDown and keyUp held input, and native-vs-UIA window-bounds provenance in `windows --json`. Keywords: Drive.NET, CLI, command line, terminal, doctor, discover, pick, desktop, windows, blockers, find, inspect, interact, tree, wait_for, batch, playback, capture, demo, report, snapshot, test, lifecycle, assert, observe, record, overlay, scaffold, explain, path, retry, DriveNet.Cli, dotnet run, one-shot, session-start-warning-mode, mouseDown, mouseUp, keyDown, keyUp, pointerPath, boundsSource, boundsNote, appMetadataBounds."
argument-hint: "[CLI command] [target process] [options]"
user-invocable: true
---

# Drive.NET CLI

Use this skill when you need quick one-shot automation or analysis from a terminal instead of a long-lived MCP session. The CLI is the right fit for diagnostics, discovery, direct interaction, waits, reports, snapshots, lifecycle control, assertions, live observation, YAML test execution, and batch flows that should be easy to rerun from PowerShell or CI.

Each process-targeting CLI command opens its own short-lived session internally when it needs to attach to a process.
Separate Drive.NET controller processes can run concurrently against different target processes, but attach is exclusive per target process. If another MCP/CLI/VS Code instance is already attached to the same target process, the later attach fails fast with: *"Process '…' (PID …) is already connected by another Drive.NET MCP/CLI controller."* Disconnect the first controller or target a different process. This most commonly occurs when an IDE MCP session is active against the same app you are testing from the terminal.
By default, that session shows the agent's non-activating automation overlay: one window per agent that lists each command. It waits 1 second only when it newly appears. Because each command's session ends when the command exits, the overlay closes a few seconds after each command unless the agent holds it, so follow the overlay workflow below.

## Overlay Workflow (Every Piece of Work)

1. Before the first command that drives an application, run `DriveNet.Cli.exe overlay --action begin --label "<what the work is>"`. When you know how many commands the work takes, run `overlay --action plan --total <n> --label "<what the work is>"` instead; it holds the overlay in the same way and adds a progress bar.
2. Run the commands. The overlay stays on screen between them, however long you pause to think, build or read output.
3. After the last command, run `DriveNet.Cli.exe overlay --action finish`. Run it also when the work stops early on an error, before you report back.

Without step 1 the overlay disappears and appears again between bursts of commands, and each new appearance costs the 1-second warning again. If you forget step 3, the overlay closes when the agent exits or after 10 minutes without a Drive.NET command (the user's idle limit). `overlay` commands are not listed on the overlay and start no session.
`lifecycle --action launch` also uses the same warning configuration before Drive.NET launches a target app that may take focus.

For iterative crash triage against an application under test, prefer a long-lived MCP session over repeated one-shot CLI commands. MCP `session status` on a terminated session preserves the durable `crashEvidence` block for the crashed target process, including correlated dumps, crash logs, and Windows Application event entries when available.

## Running The CLI

From source:
```bash
dotnet run --project src/DriveNet.Cli -- <command> [options]
```

From a published executable:
```bash
DriveNet.Cli.exe <command> [options]
```

## Validated Integration Workflow

When you need high-confidence validation of CLI behavior against real desktop targets, use the repository's integration path instead of ad hoc manual checks.

```bash
dotnet build tests/DriveNet.TestApp.WinForms/DriveNet.TestApp.WinForms.csproj -c Release
dotnet build tests/DriveNet.TestApp.WinUI/DriveNet.TestApp.WinUI.csproj -c Release -p:Platform=x64
dotnet test tests/DriveNet.Tests.Integration/DriveNet.Tests.Integration.csproj -c Release -p:Platform=x64
```

- Build the desktop test apps first because the integration fixture launches their executables directly.
- Run the integration project in `Release`; its MCP client starts `DriveNet.Server` with `dotnet run -c Release --no-build`.
- The WinUI target should be built with `-p:Platform=x64` to match the validated integration path.

## Shared Conventions

- Process-targeting commands require exactly one of `--process-name` (`-n`) or `--process-id` (`-p`).
- Use `pick` when several matching processes exist and you want one exact PID before a later command attaches.
- Different VS Code or terminal controller processes can automate different target processes at the same time, but the same target process can only be attached by one Drive.NET controller at a time.
- Batch same-process work into one `batch` command whenever possible so the attach cost happens only once.
- Use `playback` as the CLI replay entry point for recorded batch JSON, YAML suites, and YAML manifests.
- Process-targeting commands also accept `--session-start-warning-mode overlay|toast|persistent` to choose the warning UI. `overlay` is the default. The `toast` mode shows a 1-second top-centre countdown before each command's session, the `persistent` mode keeps the bottom-right warning card visible for the lifetime of the command's session, and providing a mode also enables the warning unless `--no-session-start-warning` is present.
- With the `toast` or `persistent` mode, after the first user-visible warning has already been shown, continuation CLI commands can pass `--continuation` (alias: `--no-session-start-warning`) to skip the repeated warning for that command. The default `overlay` mode does not need it.
- In text mode with the `toast` or `persistent` mode, one-shot process-targeting commands print a reuse hint after attach so terminal users get nudged toward `batch`, `playback`, or `--continuation`.
- Process-targeting commands also accept `--session-start-warning` to force the warning back on for a specific command.
- Selector-based commands accept either flat selectors (`--automation-id`, `--name`, `--control-type`, `--class-name`) or a hierarchical `--path`; do not mix them in the same command.
- Use `--match-index` only when duplicate matches are expected and stable in order.
- `find` and `wait_for` support `--explain` for diagnostics-first selector debugging without spending time on a real action or wait.
- Add `--json` to any command for machine-readable output instead of terminal tables.
- `inspect`, `interact`, selector-based `capture`, and selector-resolved `wait_for` conditions require the selector to resolve to exactly one element.
- `batch` runs all steps inside one short-lived session so saved element IDs and `${name}` variables remain valid across the whole command.
- Artifact-writing commands such as `capture --output`, `report`, and `snapshot` normalize output beneath the workspace-root `.drive-net` directory.
- Use the CLI for the failing step itself, but prefer MCP session workflows when you need durable post-crash inspection of a dead target process.

## Commands

### `doctor`

Check whether the current Windows session can access UI Automation.

```bash
DriveNet.Cli.exe doctor
DriveNet.Cli.exe doctor --json
```

Reports `uiAutomationAccessible`, OS description, process architecture, whether the session is interactive, and any recent persisted crash evidence for Drive.NET Helper or Drive.NET Companion. Use this first when diagnosing environment or privilege problems, or when Helper/Companion crashed on a previous run and you need the saved crash log, WER dump paths, or correlated Windows Application log entries.

### `discover`

List running processes with visible windows.

| Option | Description |
|---|---|
| `--filter` | Filter by process name substring. |
| `--dotnet-only` | Only include .NET processes. |
| `--include-windows` | Include all visible top-level windows owned by each process. |
| `--hierarchical` | Group child processes beneath parents and include ancestor context. |
| `--json` | JSON output. |

```bash
DriveNet.Cli.exe discover
DriveNet.Cli.exe discover --dotnet-only
DriveNet.Cli.exe discover --filter WinForms --json
DriveNet.Cli.exe discover --filter SpectraWrite --include-windows --hierarchical --json
```

- Use `--include-windows` when you need exact HWNDs and titles before connecting, capturing, or comparing window inventories.
- Use `--hierarchical` when multi-process apps spawn helper processes or separate visible windows under one parent app.

### `pick`

Resolve a deterministic process candidate and emit the exact `--process-id` suggestion for later commands.

```bash
DriveNet.Cli.exe pick --process-name DriveNet.TestApp.WinForms --newest --json
DriveNet.Cli.exe pick --process-name firefox --window-title-regex "Profile Manager" --index 1
```

Use `pick` before `capture`, `interact`, `demo mouse-move`, or any repeated manual CLI flow when a plain process-name match is ambiguous.

### `desktop`

Query desktop-wide monitor layout, the current foreground window, and cross-process visible-window state without attaching to a process.

```bash
DriveNet.Cli.exe desktop --action monitors
DriveNet.Cli.exe desktop --action foregroundWindow --json
DriveNet.Cli.exe desktop --action topLevelWindows --json
```

Use `desktop` when the workflow needs monitor bounds, DPI scale, the current foreground window, or a cross-process snapshot of all visible top-level windows before targeting a specific application.

### `windows`

List or manage visible windows for a target process.

| Option | Description |
|---|---|
| `--process-name`, `-n` | Target process name. |
| `--process-id`, `-p` | Target process ID. |
| `--action` | `list` (default), `blockers`, `dismissBlocker`, `resize`, `move`, `minimize`, `maximize`, `restore`, `close`, or `bringToFront`. |
| `--window-handle` | Required for actions other than `list` and `blockers`, optional for `dismissBlocker`. |
| `--button-name` | Preferred button caption or automation ID for `dismissBlocker`. When omitted, Drive.NET picks the button that closes the dialog without acting on its content, or fails and lists the buttons if there is none. |
| `--width`, `--height` | Required for `resize`. A minimized window stays minimized and takes the new size when restored. |
| `--x`, `--y` | Required for `move`, in screen pixels. A minimized window stays minimized and takes the new position when restored. |
| `--json` | JSON output. |

```bash
DriveNet.Cli.exe windows -n DriveNet.TestApp.WinForms
DriveNet.Cli.exe windows -n DriveNet.TestApp.WinForms --action blockers --json
DriveNet.Cli.exe windows -n DriveNet.TestApp.WinForms --action dismissBlocker --button-name Continue --json
DriveNet.Cli.exe windows -p 12345 --json
DriveNet.Cli.exe windows -n DriveNet.TestApp.WinForms --action bringToFront --window-handle 0x2A
```

Output includes window handle, state, bounds, title, and in `--json` mode the same native-vs-UIA-vs-DWM-vs-app-metadata bounds provenance exposed by the MCP `window list` tool (`boundsSource`, `boundsNote`, `nativeWindowRect`, optional `uiaBoundingRect`, optional `boundsDeltaFromNative`, optional `dwmExtendedFrameBounds`, optional `appMetadataBounds`). On reused popup hosts, `boundsSource` can be `uiaBoundingRect`, `dwmExtendedFrameBounds`, or `appMetadata` when the native rect still exposes the hidden-popup origin sentinel rather than the anchored popup position. When `suspectReusedPopup` is `true` and `appMetadataBounds` is absent, inspect app-emitted `helpText` or `itemStatus` directly for authoritative popup geometry. For `--action blockers`, the command returns a focused blocking-window assessment and exits with code `1` when a blocking window is present. `--action resize`, `move`, `minimize`, `maximize`, `restore` and `close` read the window back and report what they observed, and exit with code `1` when the window did not take the requested position or size, reach the expected state, or close. `move` and `resize` return `windowState`, `boundsKind` and `bounds`.

For popup-hosted drags, diff `windows --json` before and after `mouseUp`. If the same popup host moved while held but comes back hidden at its anchor after release, the app rejected or reverted the drop during its own release or capture handling.

### `find`

Find UI elements matching selectors.

| Option | Description |
|---|---|
| `--process-name`, `-n` | Target process name. |
| `--process-id`, `-p` | Target process ID. |
| `--automation-id` | Match AutomationId. |
| `--name` | Match element name. |
| `--control-type` | Match UIA control type such as `Button` or `Edit`. |
| `--class-name` | Match native class name. |
| `--path` | Hierarchical selector path. Cannot be combined with flat selectors. |
| `--match-index` | 1-based match position after filtering. |
| `--scope` | `descendants` (default), `children`, or `subtree`. |
| `--window-handle` | Restrict the search root to one specific top-level window handle instead of the session main window. |
| `--explain` | Return selector diagnostics instead of listing matches. |
| `--fallback` | Try alternative selector strategies when the primary selector yields no results. |
| `--json` | JSON output. |

```bash
DriveNet.Cli.exe find -n MyApp --automation-id SubmitButton
DriveNet.Cli.exe find -n MyApp --path 'Pane[automationId=MainPanel] > Button[name=Save]' --match-index 2 --json
DriveNet.Cli.exe find -n MyApp --path 'Pane[automationId=MainPanel] > Button[name=Save]' --explain
DriveNet.Cli.exe find -n MyApp --window-handle 0x1A4F --automation-id ConfirmButton --json
DriveNet.Cli.exe find -n MyApp --automation-id SaveButton --fallback --json
```

- Prefer `--automation-id` when available.
- Use `--path` when repeated siblings make flat selectors ambiguous.
- Equivalent duplicate matches with the same selector-visible identity and bounds are collapsed before `find` prints or returns them.
- Run `--explain` before a risky `inspect` or `interact` when the selector is uncertain.

If all you need is a fresh element id after a visual refresh, rerun `find` with a stable selector such as `--automation-id`; do not dump a full tree just to reacquire one control.

### `inspect`

Inspect one uniquely matched element with verbose detail. Use the same selectors as `find`, but the selector must resolve to exactly one element.

```bash
DriveNet.Cli.exe inspect -n MyApp --automation-id SubmitButton
DriveNet.Cli.exe inspect -p 12345 --name "Open" --control-type MenuItem --json
```

If the selector matches more than one element, run `find` with `--explain` first and tighten the selector.

### `interact`

Perform one action against a uniquely matched element, or use the clipboard, mouseDown, mouseUp, mouseMove, pointerPath, keyDown, or keyUp without attaching to an element.

```bash
DriveNet.Cli.exe interact -n MyApp --action click --automation-id SubmitButton
DriveNet.Cli.exe interact -n MyApp --action type --automation-id SearchBox --value "fictional query"
DriveNet.Cli.exe interact -n MyApp --action hover --automation-id SubmitButton --dwell-ms 1000
DriveNet.Cli.exe interact --action clipboard --clipboard-action read
DriveNet.Cli.exe interact --action mouseDown --mouse-button left
DriveNet.Cli.exe interact --action mouseUp --destination-x 920 --destination-y 460 --mouse-button left
DriveNet.Cli.exe interact --action mouseMove --destination-x 500 --destination-y 300
DriveNet.Cli.exe interact --action mouseMove --source-x 100 --source-y 200 --destination-x 800 --destination-y 600 --mouse-button left --duration-ms 1000
DriveNet.Cli.exe interact --action mouseMove --destination-x 900 --destination-y 420 --duration-ms 800 --motion-profile exaggerated --motion-exaggeration 85
DriveNet.Cli.exe interact --action pointerPath --waypoints '[{"x":400,"y":300},{"x":900,"y":420,"durationMs":600}]' --mouse-button left
DriveNet.Cli.exe interact --action keyDown --keys Ctrl
DriveNet.Cli.exe interact --action keyUp --keys Ctrl
DriveNet.Cli.exe interact -n MyApp --action hover --automation-id SubmitButton --dwell-ms 1000 --motion-profile hesitant --motion-exaggeration 70
DriveNet.Cli.exe interact -n MyApp --action hover --automation-id SubmitButton --hover-mode transit --approach-from left --velocity-ms 300 --dwell-ms 1000
DriveNet.Cli.exe interact -n MyApp --action moveTo --automation-id SubmitButton --position outside-right --offset-px 24 --duration-ms 400 --motion-profile steady
```

Use `--target-*` selector options for `dragTo`, `--highlight` to flash the source element before the action, and `--dwell-ms` to control hover duration. `mouseDown` and `mouseUp` are useful for held-button workflows such as crosshair pickers or multi-step drags; when you omit coordinates, Drive.NET uses the current cursor position. `--motion-profile` and `--motion-exaggeration` tune the humanized pointer path for `mouseMove`, `hover`, and `moveTo`: `steady` stays straighter, `natural` is the default, `exaggerated` adds broader arcs and correction, and `hesitant` introduces more uneven cadence. With `--mouse-button left`, `mouseMove` and `pointerPath` press and release the button when it is up, and keep it held after `mouseDown`, so a drag can span several commands until `mouseUp`. `keyDown` and `keyUp` hold a modifier such as `Ctrl` around a drag. A CLI command has no session, so a button or key it holds stays held after the process exits until `mouseUp` or `keyUp`. `--hover-mode transit` plus `--approach-from` and `--velocity-ms` gives the CLI the same authentic boundary-crossing hover path as MCP `interact`. `--position` and `--offset-px` make `moveTo` useful for parking the pointer outside a control without raw coordinates. For top-edge appbar elements, Drive.NET automatically uses a horizontal approach path to avoid crossing the popup zone below; for neighbouring flyout panels, the smooth exit path ensures clean `WM_MOUSELEAVE` triggering for popup handoff.

Generic held-button drags are supported, but popup-hosted flyouts can still apply app-specific release or capture logic on `mouseUp`. Prefer one MCP session or a `batch` flow when you need to compare `windows --json` before and after release and re-query popup content against the popup `--window-handle`.

Standalone CLI `interact` returns a lightweight hover result rather than the richer MCP observation blocks. Use MCP `interact` when you need `sameWindowEffect`, `effectObservation`, `replacedWindowPairs`, or `windowTimeline` diagnostics.

Use `--secret` to read `--value` from stdin instead of passing it on the command line (avoids logging sensitive text). Use `--fallback` to try alternative selector strategies when the primary selector yields no results.

### `tree`

Render the UI Automation tree for a process root or a specific matched subtree.

| Option | Description |
|---|---|
| Process + selector options | Same as `find`. |
| `--max-depth` | Maximum traversal depth (0-25, default: 3). |
| `--max-nodes` | Maximum returned nodes before the tree is truncated in-band (1-5000, default: 250). |
| `--detail` | `summary` (default) or `verbose`. |
| `--annotate-probable-artifacts` | Annotate framework/provider artifacts like WinUI TitleBar placeholders. |
| `--view` | UI Automation view to walk: `control` (default), `content`, or `raw`. `raw` also returns the elements a provider excludes from the accessibility views; pair it with `--detail verbose`. |
| `--json` | JSON output. |

```bash
DriveNet.Cli.exe tree -n MyApp --max-depth 2
DriveNet.Cli.exe tree -n MyApp --max-depth 4 --max-nodes 150 --json
DriveNet.Cli.exe tree -n MyApp --automation-id MainTabs --max-depth 4 --detail verbose
DriveNet.Cli.exe tree -n MyApp --json
```

When no selector is given, the tree starts from the process root. When a selector is given, it must match exactly one element which becomes the subtree root.

JSON tree output now includes `queryRoot`, `nodeCount`, `truncated`, `maxNodes`, and `continuationHints`. When `truncated` is `true`, rerun `tree` against one of the hinted subtree `elementId` roots instead of re-dumping the whole window.

### `wait_for`

Wait for a UI or window condition against a target process.

```bash
DriveNet.Cli.exe wait_for -n MyApp --condition elementExists --automation-id SuccessLabel
DriveNet.Cli.exe wait_for -n MyApp --condition elementExists --path 'Pane[automationId=MainPanel] > Button[name=Save]' --match-index 2
DriveNet.Cli.exe wait_for -n MyApp --condition elementExists --automation-id SuccessLabel --explain
DriveNet.Cli.exe wait_for -n MyApp --condition textEquals --automation-id StatusText --expected-value "Saved"
DriveNet.Cli.exe wait_for -n MyApp --condition windowOpened --timeout-ms 10000 --json
```

- The command exits with `0` when the condition is met and `1` on timeout or unmet conditions.
- Use `--explain` when a selector-based wait is timing out and you need diagnostics before spending the timeout budget again.
- Prefer `--path` for repeated controls whose parent chain matters.

### `batch`

Execute a JSON array of `query`, `interact`, `wait_for`, and `assert` steps inside one short-lived process session.

On Windows PowerShell, prefer `--steps-file` for multi-step flows. If you use inline JSON with `--steps`, wrap the whole JSON array in single quotes.

```bash
DriveNet.Cli.exe batch -n MyApp --steps-file .\login-flow.json --json
DriveNet.Cli.exe batch -n MyApp --steps-file .\wizard.json --start-delay-ms 1000 --json
DriveNet.Cli.exe batch -n MyApp --steps '[{"tool":"query","action":"explain","path":"Pane[automationId=MainPanel] > Button[name=Submit]"},{"tool":"query","action":"find","automationId":"SubmitButton","saveAs":"submit"},{"tool":"interact","action":"click","elementId":"${submit}"}]'
```

| Option | Description |
|---|---|
| `--steps` | Inline JSON array of batch steps. |
| `--steps-file` | Path to a UTF-8 JSON file containing batch steps. |
| `--stop-on-error` | Stop on first failing step (default: true). |
| `--delay-between-ms` | Delay between steps in ms. |
| `--start-delay-ms` | Delay before the first step in ms. |
| `--end-delay-ms` | Delay after the last step in ms. |

Exactly one of `--steps` or `--steps-file` is required.

The CLI batch contract matches the MCP `batch` tool contract, including `saveAs`, `save`, `${name}` substitution, `when`, `retry`, `continueOnError`, per-step `delayBeforeMs` / `delayAfterMs`, `keyDown` and `keyUp`, and `pointerPath`.

Query batch steps also support `action: "resolve"` when you want one fresh element id or a fast ambiguity error instead of a larger `find` result.

### `playback`

Replay recorded batch JSON or YAML assets from one CLI entry point.

| Option | Description |
|---|---|
| `--input` | Path to the replay file (batch JSON, YAML suite, or YAML manifest). Required. |
| `--format` | Format hint: `auto` (default), `batch_json`, `yaml_suite`, or `yaml_manifest`. |
| `--stop-on-error` | Stop on first failed batch step (default: true). |
| `--delay-between-ms` | Delay between batch steps in ms. |
| `--start-delay-ms` | Delay before the first batch step in ms. |
| `--end-delay-ms` | Delay after the last batch step in ms. |
| `--fail-fast` | Stop YAML playback on first test failure. |
| `--result-json` | Write structured JSON results for YAML replay. |
| `--junit-xml` | Write JUnit XML results for YAML replay. |
| `--json` | JSON output. |

```bash
DriveNet.Cli.exe playback --input .\recorded-batch.json --process-name MyApp --json
DriveNet.Cli.exe playback --input tests\definitions\companion\querying.yaml --result-json .\artifacts\querying-results.json
DriveNet.Cli.exe playback --input tests\definitions\companion\manifest.yaml --fail-fast --junit-xml .\artifacts\results.xml
```

Use `playback` when you want the simplest CLI rerun path for what `record` produced. Batch JSON playback keeps one session alive across the full file, so it is also a clean way to avoid repeated attach overhead in terminal-driven workflows.

### `capture`

Capture a window or one matched element. Window captures automatically trim invisible non-client resize borders when DWM reports a tighter visible frame. Supports optional border, drop shadow, and PNG (default) or JPEG encoding.

| Option | Description |
|---|---|
| Process + selector options | Same as `find`. |
| `--format` | Capture output format: `file` (default) or `base64`. Base64 is most useful with `--json`. |
| `--output`, `-o` | Output file path when `--format file` is selected. Always normalized under the workspace-root `.drive-net` directory. Extension adjusted to match `--image-format`. |
| `--window-handle` | Specific window handle to capture (ignored when selectors are given). |
| `--padding` | Pixels of surrounding context around an element capture. Ignored for window captures. |
| `--border-thickness` | Border thickness in pixels. `0` (default) disables the border. |
| `--border-color` | Border color as a hex string (e.g. `'#FF0000'`) or a named color. Default: `'#000000'`. |
| `--shadow` | Add a soft drop shadow behind the screenshot. On GitHub dark theme, inline README rendering can make that dark shadow read like a thick border when the image is scaled down. |
| `--image-format` | Image encoding: `png` (default, preserves alpha) or `jpg`. |
| `--json` | JSON output. |

```bash
DriveNet.Cli.exe capture -n MyApp
DriveNet.Cli.exe capture -n MyApp --automation-id SubmitButton --json
DriveNet.Cli.exe capture -n MyApp --automation-id SubmitButton --padding 20 -o submit-btn.png
DriveNet.Cli.exe capture -n MyApp --format base64 --json
DriveNet.Cli.exe capture -p 12345 --window-handle 0x1A4F2 -o evidence/dialog.png
DriveNet.Cli.exe capture -n MyApp --border-thickness 3 --border-color "#336699"
DriveNet.Cli.exe capture -n MyApp --shadow --image-format jpg -o evidence/screenshot.jpg
```

When no selector or window handle is given, the command captures the main window. Window captures automatically trim invisible non-client resize borders when DWM reports a tighter visible frame. Use `--format base64 --json` when a workflow needs the inline image payload and metadata instead of a file write. `--border-thickness` and `--shadow` can be combined; shadow is rendered first, then the border frames the result. For README assets shown on GitHub, prefer omitting `--shadow` unless you verify the rendered page. `--image-format jpg` flattens transparency onto white; file extensions are adjusted automatically. A capture shows everything on screen. Before you keep or share one, read it for private data: user names and the paths that contain them, project, repository and folder names, other applications' window titles, and log lines, tokens or addresses. For a screenshot that will be published, stage the UI with fictional data before capturing, as the `drivenet-doc-screenshots` skill describes. If private data appears, tell the user which file it is and what it shows, and recapture rather than keep it.

### `report`

Run the shared Automation Readiness and Accessibility Compliance analysis pipeline against a live process target and write a report artifact.

```bash
DriveNet.Cli.exe report -n MyApp
DriveNet.Cli.exe report -n MyApp --format sarif --output reports/latest.sarif --json
DriveNet.Cli.exe report -n MyApp --format plan
DriveNet.Cli.exe report -n MyApp --remediation
DriveNet.Cli.exe report -n MyApp --label before-fix
DriveNet.Cli.exe report -n MyApp --label after-fix --save-snapshot
```

Use this when you need durable findings rather than a transient tree dump or screenshot. Use `--format plan` when the remediation plan itself is the primary artifact, or `--remediation` when you want the standard report plus a companion remediation-plan artifact.
`--remediation` cannot be combined with `--format plan`.

Reports span both suites. `DNC022` (small click/touch target) is reported only under Accessibility Compliance because it maps to WCAG 2.5.8 target size.

Use `--label` to tag output filenames (e.g. `analysis-report-before-fix.md`). Combine `--save-snapshot` with `--label` to capture a `.dncsnap` baseline alongside the report for later comparison.

### `snapshot`

Create a live analysis snapshot or compare two existing snapshots.

```bash
DriveNet.Cli.exe snapshot create -n MyApp --output snapshots/latest.dncsnap --json
DriveNet.Cli.exe snapshot compare --baseline baseline.dncsnap --current current.dncsnap --format json --output comparisons/diff.json
```

Use `snapshot create` to capture a stable baseline, then `snapshot compare` to quantify regressions or improvements across runs.

### `lifecycle`

Launch, stop, or inspect a target application's process state directly from the terminal.

| Option | Description |
|---|---|
| `--action` | `launch`, `stop`, or `status`. Required. |
| `--executable-path` | Absolute path to the executable to launch. |
| `--arguments` | Command-line arguments for the launched process. |
| `--working-directory` | Working directory for the launched process. |
| `--startup-wait-ms` | Maximum wait for a main window after launch (default: 5000). |
| `--single-instance` | Policy for existing instances: `reuse` or `restart`. |
| `--process-name` | Process name for single-instance family matching. |
| `--process-id` | Process ID (required for `stop` and `status`). |
| `--grace-period-ms` | Wait time before force-kill on `stop` (default: 5000), shared by `WM_CLOSE` to every visible window and then `WM_QUERYENDSESSION`/`WM_ENDSESSION` to every top-level window. The JSON output reports `stoppedBy`, each attempt in `attempts`, and a `warning` after a forced kill. |
| `--json` | JSON output. |

```bash
DriveNet.Cli.exe lifecycle --action launch --executable-path C:\Apps\MyApp\MyApp.exe --startup-wait-ms 10000
DriveNet.Cli.exe lifecycle --action launch --executable-path C:\Apps\MyApp\MyApp.exe --arguments=--debug --working-directory C:\Apps\MyApp
DriveNet.Cli.exe lifecycle --action launch --executable-path C:\Apps\MyApp\MyApp.exe --single-instance reuse --process-name MyApp
DriveNet.Cli.exe lifecycle --action launch --executable-path C:\Apps\MyApp\MyApp.exe --no-session-start-warning
DriveNet.Cli.exe lifecycle --action status --process-id 12345 --json
DriveNet.Cli.exe lifecycle --action stop --process-id 12345 --grace-period-ms 3000
```

Use `lifecycle` when the terminal workflow must own process startup or shutdown instead of assuming the app is already running. The `launch` action accepts `--session-start-warning` and `--no-session-start-warning` for the pre-launch safety notice.

### `assert`

Evaluate declarative UI assertions against one process target.

```bash
DriveNet.Cli.exe assert -n MyApp --clauses-file .\status-assertions.json --json
DriveNet.Cli.exe assert -n MyApp --clauses '[{"automationId":"lblStatus","condition":"textEquals","expected":"Saved"}]'
```

Use `assert` when a scripted or CI flow should fail immediately on unmet UI expectations instead of leaving verification to an external parser.

### `observe`

Subscribe to live UIA events and stream them until timeout or `Ctrl+C`.

```bash
DriveNet.Cli.exe observe -n MyApp --event-types structureChanged,propertyChanged
DriveNet.Cli.exe observe -n MyApp --event-types focusChanged --timeout-ms 10000 --json
```

Use `observe` when polling is wasteful and you need to watch the app react to real-time UI changes.

### `test`

Run a YAML manifest or single YAML suite through the built-in UI test runner.

```bash
DriveNet.Cli.exe test --suite tests/definitions/companion/querying.yaml
DriveNet.Cli.exe test --manifest tests/definitions/companion/manifest.yaml --result-json .\artifacts\companion-results.json
```

Use `--result-json` whenever an agent or script will inspect the run afterward.

For VS Code extension testing, spawn the Extension Development Host via F5 and use `attach_only: true` with `process_name: Code` and `window_title_regex: '\[Extension Development Host\]'` in the suite's `app` block. Do not use `lifecycle launch` for VS Code: its single-instance lock prevents a second instance, even with a unique `--user-data-dir`. Ensure no other Drive.NET session is attached to the same `Code` PID before running the test. See [docs/yaml-test-runner.md — Testing VS Code / Electron Extensions](../../../docs/yaml-test-runner.md#testing-vs-code--electron-extensions) for a full YAML pattern.

### `record`

Record live interactions into batch JSON or YAML test suites.

```bash
DriveNet.Cli.exe record --action start --process-name MyApp
DriveNet.Cli.exe record --action stop --recording-id rec:abc123 --output recorded.json
DriveNet.Cli.exe record --action start --process-name MyApp --format yaml_suite --suite-name "Login Flow"
```

Use `record` when you want to capture a reproducible workflow first, then refine the generated batch or YAML output afterward. Replay the result with `playback --input ...`.

### `overlay`

Hold, show progress on, move, or close the automation overlay of the agent that runs the command.

```bash
DriveNet.Cli.exe overlay --action begin --label "Verify the settings page"
DriveNet.Cli.exe overlay --action plan --total 12 --label "Fill in the order form"
DriveNet.Cli.exe overlay --action step
DriveNet.Cli.exe overlay --action move --corner topLeft --monitor 1
DriveNet.Cli.exe overlay --action status --json
DriveNet.Cli.exe overlay --action finish
```

`begin` shows the overlay and holds it on screen between commands until `finish`. `plan` declares how many commands the work will take and holds the overlay in the same way, and each later command fills one step; `--total 0` clears the plan but keeps the hold. `step` advances by one, or sets `--completed`. `move` takes `bottomRight`, `topRight`, `bottomLeft`, `topLeft`, or `auto`, but a position the user dragged the overlay to, or a corner fixed in the Helper's settings, wins. `finish` ends the hold and closes the overlay now. `status` reports `held` in its JSON. `overlay` calls are not listed and do not count as steps. The command fails when `DriveNet.Overlay.exe` is missing beside the CLI or cannot start. See the `drivenet-overlay` skill.

### `demo`

Run built-in visual verification flows directly from the CLI.

| Option | Description |
|---|---|
| `--duration-ms` | Demo move duration in ms (default: 2500). |
| `--mouse-button` | Button to hold: `none` (default), `left`, `right`, `middle`. |
| `--source-x-percent` | Horizontal start position as a window-width percentage (default: 12). |
| `--source-y-percent` | Vertical start position as a window-height percentage (default: 24). |
| `--destination-x-percent` | Horizontal destination as a window-width percentage (default: 88). |
| `--destination-y-percent` | Vertical destination as a window-height percentage (default: 72). |
| `--window-handle` | Specific window handle to demo against. |
| `--timings` | Emit phase timings for attach, prepare, move, and total. |
| `--json` | JSON output. |

```bash
DriveNet.Cli.exe demo mouse-move --process-name DriveNet.TestApp.WinForms
DriveNet.Cli.exe demo mouse-move --process-id 12345 --duration-ms 3200 --mouse-button left
DriveNet.Cli.exe demo mouse-move --process-name MyApp --source-x-percent 10 --source-y-percent 20 --destination-x-percent 90 --destination-y-percent 80 --timings
```

`demo mouse-move` restores and foregrounds the target window, derives a safe in-window path from the live bounds, and then replays the humanised pointer motion so you can visually inspect it without hand-computing coordinates.

### `scaffold`

Generate a starter YAML accessibility test suite targeting a named process.

```bash
DriveNet.Cli.exe scaffold --process-name MyApp
DriveNet.Cli.exe scaffold --process-name MyApp --min-score 80 --output tests/a11y-suite.yaml
```

Use `scaffold` when bootstrapping accessibility CI for a new app. The generated YAML defines a connect step, a report step with the chosen minimum-score threshold, and placeholder interact/assert steps you can customise.
