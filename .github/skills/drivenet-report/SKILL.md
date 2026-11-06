---
name: drivenet-report
description: "Use this skill to run Drive.NET's Automation Readiness and Accessibility Compliance analysis report pipeline against a live desktop session and write durable artifacts. Covers the 'report' MCP tool with markdown, json, html, sarif, and plan output under the workspace .drive-net directory, plus optional inline remediation-plan content, window/subtree scoping, content mode control, labeled file names, passing elements summaries, and companion snapshot generation. Keywords: Drive.NET, report, analysis, accessibility, markdown, json, html, sarif, plan, remediation, artifact, findings, score, .drive-net, windowHandle, rootElementId, contentMode, label, saveSnapshot, includePassingElements."
argument-hint: "[goal] [sessionId] [format]"
user-invocable: true
---

# Drive.NET Analysis Reports

Use this skill when you need a durable analysis artifact rather than a transient query, screenshot, or prompt summary. The `report` tool runs the shared Automation Readiness and Accessibility Compliance analysis pipeline against a live session and writes a report beneath the workspace-root `.drive-net` directory.

## `report` Tool

### Parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `sessionId` | string | Yes | - | Session ID from `session connect`. |
| `format` | string | No | `markdown` | `markdown`, `json`, `html`, `sarif`, or `plan`. |
| `filePath` | string | No | auto-generated | Output path. Explicit values are normalized under `.drive-net`. |
| `includeRemediationPlan` | bool | No | `false` | When `true`, include a prioritized remediation plan in the report response as structured data. |
| `windowHandle` | string | No | - | Scope the report to elements under a specific top-level window instead of the session's main window. |
| `rootElementId` | string | No | - | Scope the report to a subtree rooted at a previously resolved element ID. Mutually exclusive with `windowHandle`. |
| `contentMode` | string | No | `inline` | Controls response verbosity: `inline` (full findings), `metadata` (score + file path only), `summary` (score + severity counts). |
| `label` | string | No | - | Human-readable label for the artifact file name (e.g., `post-remediation`). Sanitized to alphanumeric, dash, and underscore. |
| `includePassingElements` | bool | No | `false` | Include a summary of elements that passed all analysis checks. |
| `saveSnapshot` | bool | No | `false` | Save a `.dncsnap` snapshot file alongside the report for later comparison via `snapshot compare`. |

### Response

```json
{
  "filePath": ".../.drive-net/analysis-report-20260320120000000.md",
  "format": "markdown",
  "target": "MyApp",
  "processId": 12345,
  "framework": "winUi",
  "score": 87,
  "scoreTier": "good",
  "totalFindings": 4,
  "scoreBreakdown": {
    "criticalCount": 0,
    "errorCount": 1,
    "warningCount": 2,
    "infoCount": 1,
    "hintCount": 0,
    "totalElements": 42,
    "cleanElements": 38,
    "bonusPoints": 2.0,
    "totalPenalty": 15.0
  }
}
```

### Examples

```
report sessionId="..."
report sessionId="..." format="sarif" filePath="reports/latest.sarif"
report sessionId="..." format="plan"
report sessionId="..." includeRemediationPlan=true
report sessionId="..." windowHandle="0x12D687"
report sessionId="..." rootElementId="e_abc123"
report sessionId="..." contentMode="metadata"
report sessionId="..." label="post-remediation" saveSnapshot=true
report sessionId="..." includePassingElements=true
```

## Usage Guidance

- Use `report` when you need durable findings for review, CI artifacts, or before-and-after comparison work.
- Prefer `markdown` for human review, `json` for downstream tooling, `sarif` for code-scanning workflows, and `plan` when you want a standalone remediation artifact.
- Treat `filePath` as a relative artifact hint, not a way to write outside the workspace. Drive.NET keeps the write under `.drive-net`.
- Keep `filePath` aligned with `format`: `.md` for `markdown` and `plan`, `.json` for `json`, `.html` for `html`, and `.sarif` for `sarif`.
- Run `report` after the UI has reached a stable state; pair it with `wait_for` or a deterministic `batch` when the screen is still changing.
- Report output spans both suites. `DNC022` (small click/touch target) is emitted only under Accessibility Compliance because it maps to WCAG 2.5.8 target size.
- Use `includeRemediationPlan=true` when a caller needs both the normal report metadata and a machine-readable remediation plan in one response.
- Use `contentMode="metadata"` for follow-up reports where you only need the score without re-reading all findings. The full report is still written to disk.
- Use `label` to give report artifacts meaningful names (e.g., `analysis-report-post-remediation.md`) for before/after comparison workflows.
- Use `saveSnapshot=true` to create companion `.dncsnap` files alongside reports, enabling `snapshot compare` for regression tracking.
- Use `windowHandle` or `rootElementId` to focus analysis on a specific window or subtree in multi-window or complex applications.
- Use `includePassingElements=true` when you want to verify which elements are clean, not just which have issues.

## Common Patterns

### Emit A Review Artifact After Reproducing A Problem

```
wait_for sessionId="..." condition="elementExists" automationId="MainPanel"
report sessionId="..." format="markdown" filePath="reports/current-state.md"
```

### Feed Findings Into A Triage Workflow

```
report sessionId="..." format="json" filePath="reports/current-state.json"
```

Use JSON output when another agent, script, or result-processing step will inspect the findings.

### Framework-Aware Severity

Analysis findings are adjusted based on the detected UI framework. For example, missing keyboard access (DNC005) is demoted to Info for Electron targets because web content event handlers may not be visible to UIA. `MissingAutomationId` (DNC001) is not demoted for Electron: Chromium exposes an element's HTML `id` as its AutomationId, so the remediation is a stable, unique HTML id, not one a framework generates at run time. Java/Swing targets demote keyboard access checks when the Java Access Bridge may not be installed. Adjusted findings preserve the original severity alongside the new severity and an explanation of the adjustment reason.