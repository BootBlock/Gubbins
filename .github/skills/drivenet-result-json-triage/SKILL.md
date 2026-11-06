---
name: drivenet-result-json-triage
description: "Use this skill to inspect Drive.NET YAML test runner `test --result-json` output, identify the first real failure, distinguish command execution errors from expectation failures, and propose the smallest next debugging step. Keywords: Drive.NET, result-json, YAML test runner, test triage, failure analysis, commandSuccess, failureReason, commandError, saved variables, step result, CLI."
argument-hint: "[result-json path] [failed suite or test] [question]"
user-invocable: true
---

# Drive.NET Result JSON Triage

Use this skill when a Drive.NET YAML test run already produced a `--result-json` file and you need to explain what failed or decide what to do next.

## Triage Order

1. Read `summary.runFailed`, `summary.failedSuiteCount`, and the lifecycle failure counts before assuming the failure came from a test step.
2. Find the first failing suite and inspect `setupError`, `teardownError`, and `finallyError` first.
3. Only if the suite has no lifecycle error, find the first failed test inside it and read that test's `failureReason` before reading every step.
4. Find the first step where `passed` is `false`.
5. Compare `commandSuccess` and `passed`:
   - `commandSuccess: false` means the tool call itself failed.
   - `commandSuccess: true` with `passed: false` means the command ran, but the expectation was wrong.
6. Inspect `commandError`, `result`, `saved`, and `attemptCount` together before suggesting a fix.

## What To Extract

For the failing step, capture:

- `tool`
- `action`
- `args`
- `expect`
- `save`
- `commandSuccess`
- `failureReason`
- `commandError`
- `result`
- `saved`

For a suite-level failure with no failed step, capture:

- `name`
- `setupError`
- `teardownError`
- `finallyError`
- `summary.runFailed`

Also inspect the test-level `variables` block. It often explains whether an earlier selector or handle was saved incorrectly.

## Common Interpretations

- Empty `items` with `commandSuccess: true`: the selector ran correctly, but the UI state or expectation is wrong.
- Missing `saved` value: the JSON path likely did not match the actual result shape.
- `summary.runFailed: true` with `failed: 0`: a suite lifecycle phase failed even though no test body failed.
- `commandError` mentioning ambiguous selectors: add a stronger selector or save a prior `elementId`.
- `wait_for` timing out with a useful `details` payload: the condition was close, but the state never reached the expected value.
- `capture` succeeding while a later assertion fails: use the image as evidence, not proof that the later selector is correct.

## Recommended Response Shape

When reporting back to the user or another agent:

1. Name the failing suite and test.
2. If setup, teardown, or finally failed, name that lifecycle phase instead of inventing a failing step.
3. Quote the first failing step's tool and action only when a step actually failed.
4. State whether the failure is a suite lifecycle error, a command error, or an assertion mismatch.
5. Point to the exact field in `result`, `commandError`, or the suite error field that proves it.
6. Suggest one minimal next change.

## Repository References

- [docs/yaml-test-runner.md](../../../docs/yaml-test-runner.md)
- [tests/definitions/companion/manifest.yaml](../../../tests/definitions/companion/manifest.yaml)
- [tests/definitions/companion/connected.yaml](../../../tests/definitions/companion/connected.yaml)
- [tests/definitions/companion/navigation.yaml](../../../tests/definitions/companion/navigation.yaml)
