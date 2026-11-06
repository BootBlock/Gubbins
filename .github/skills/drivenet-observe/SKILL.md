---
name: drivenet-observe
description: "Use this skill to subscribe to live UI change events with Drive.NET. Covers the 'observe' MCP tool for subscribe, drain, and unsubscribe, including eventTypes filtering, subtree scoping with elementId, bounded event queues, and patterns for combining observation with interact or wait_for when polling would be wasteful. Keywords: Drive.NET, observe, subscribe, drain, unsubscribe, structureChanged, propertyChanged, focusChanged, invoked, event queue, subtree, UI events, live observation."
argument-hint: "[goal] [what UI event to watch] [optional subtree]"
user-invocable: true
---

# Drive.NET UI Observation

Use this skill when you need to react to live UI events instead of repeatedly polling with `query` or `wait_for`.

## `observe` Tool

`observe` manages a subscription lifecycle: `subscribe` starts capturing events, `drain` returns queued events since the last drain, and `unsubscribe` removes the subscription.

### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `action` | string | Yes | `subscribe`, `drain`, or `unsubscribe`. |
| `sessionId` | string | For `subscribe` | Session ID from `session connect`. |
| `eventTypes` | string | For `subscribe` | Comma-separated event types: `structureChanged`, `propertyChanged`, `focusChanged`, `invoked`. |
| `elementId` | string | No | Optional subtree root for a scoped subscription. |
| `subscriptionId` | string | For `drain`/`unsubscribe` | Subscription ID returned by `subscribe`. |

## Event Types

| Event Type | Use Case |
|---|---|
| `structureChanged` | Child added or removed, list content refreshed, popup subtree changed. |
| `propertyChanged` | Value, enabled state, expand or collapse state, or name changed. |
| `focusChanged` | Focus moved to a new control or window. |
| `invoked` | Button or invoke-pattern activation occurred. |

## Examples

```text
observe action="subscribe" sessionId="session-1" eventTypes="structureChanged,propertyChanged"
observe action="subscribe" sessionId="session-1" eventTypes="focusChanged" elementId="e_form"
observe action="drain" subscriptionId="sub:a1b2c3..."
observe action="unsubscribe" subscriptionId="sub:a1b2c3..."
```

## Rules

- Max 10 active subscriptions per session.
- Each subscription uses a bounded queue of 1000 events. Oldest events are dropped when the queue is full.
- Subscriptions are automatically cleaned up when the session disconnects.
- Use `elementId` to scope observation to the smallest useful subtree so event noise stays manageable.
- Call `drain` periodically if the UI is busy; do not let the queue fill indefinitely.
- Prefer `observe` when you need to inspect what changed, and prefer `wait_for` when you only need a yes or no gate on one condition.

## Common Patterns

### Watch A List Refresh After A Click

```text
observe action="subscribe" sessionId="session-1" eventTypes="structureChanged" elementId="e_resultsList"
interact sessionId="session-1" action="click" elementId="e_refresh"
observe action="drain" subscriptionId="sub:a1b2c3..."
observe action="unsubscribe" subscriptionId="sub:a1b2c3..."
```

### Capture Property Changes During A Toggle

```text
observe action="subscribe" sessionId="session-1" eventTypes="propertyChanged" elementId="e_settingsPane"
interact sessionId="session-1" action="toggle" elementId="e_enableFeature"
observe action="drain" subscriptionId="sub:a1b2c3..."
```

### Follow Focus Through Keyboard Navigation

```text
observe action="subscribe" sessionId="session-1" eventTypes="focusChanged"
interact sessionId="session-1" action="sendKeys" elementId="e_firstField" keys="Tab"
observe action="drain" subscriptionId="sub:a1b2c3..."
```