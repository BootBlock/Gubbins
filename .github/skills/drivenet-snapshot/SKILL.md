---
name: drivenet-snapshot
description: "Use this skill to create and compare Drive.NET analysis snapshots. Covers the 'snapshot' MCP tool with create and compare actions, .dncsnap baseline files, and markdown or json comparison artifacts under the workspace .drive-net directory. Keywords: Drive.NET, snapshot, baseline, compare, regression, .dncsnap, analysis, diff, markdown, json, artifact."
argument-hint: "[create|compare] [sessionId or snapshot paths]"
user-invocable: true
---

# Drive.NET Analysis Snapshots

Use this skill when you need a stable automation baseline that can be compared across builds, UI revisions, or repro attempts. The `snapshot` tool can either create a live snapshot from a session or compare two saved snapshots and write a diff artifact.

## `snapshot` Tool

### Parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `action` | string | Yes | - | `create` or `compare`. |
| `sessionId` | string | No* | - | Required for `create`. |
| `filePath` | string | No | auto-generated | Output path for the created snapshot or comparison artifact. Drive.NET writes under `.drive-net`. |
| `baselinePath` | string | No* | - | Required for `compare`. |
| `currentPath` | string | No* | - | Required for `compare`. |
| `format` | string | No | `markdown` | Comparison format for `compare`: `markdown` or `json`. |

`*` `sessionId` is required only for `create`. `baselinePath` and `currentPath` are required only for `compare`.

### Examples

```
snapshot action="create" sessionId="..."
snapshot action="create" sessionId="..." filePath="snapshots/baseline.dncsnap"
snapshot action="compare" baselinePath="baseline.dncsnap" currentPath="current.dncsnap" format="json" filePath="comparisons/diff.json"
```

## Usage Guidance

- Use `snapshot action="create"` once the UI is in a stable, representative state.
- Use `snapshot action="compare"` when you need measurable regression evidence instead of an anecdotal description of what changed.
- Keep baselines intentionally named and scoped so later comparisons remain understandable.
- Snapshot and comparison outputs are normalized beneath `.drive-net` when Drive.NET writes them.
- Relative `baselinePath` and `currentPath` values first resolve under `.drive-net`, which matches the relative paths typically produced by `snapshot action="create" filePath="snapshots/..."`.
- For `snapshot action="compare"`, keep `filePath` aligned with `format`: `.md` for `markdown`, `.json` for `json`.

## Common Patterns

### Establish A Baseline Before A Change

```
wait_for sessionId="..." condition="elementExists" automationId="MainPanel"
snapshot action="create" sessionId="..." filePath="snapshots/baseline.dncsnap"
```

### Compare A New Build Against The Baseline

```
snapshot action="compare" baselinePath="snapshots/baseline.dncsnap" currentPath="snapshots/current.dncsnap" format="markdown" filePath="comparisons/current-vs-baseline.md"
```

### Pair Snapshots With Reports

When a comparison shows a regression, generate a report from the live session as a human-readable follow-up artifact:

```
snapshot action="compare" baselinePath="snapshots/baseline.dncsnap" currentPath="snapshots/current.dncsnap" format="json"
report sessionId="..." format="markdown" filePath="reports/current-findings.md"
```