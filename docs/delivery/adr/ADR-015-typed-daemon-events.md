# ADR-015 — Daemon state changes are typed frames; snapshots are for reconnect

**Status:** Accepted

## Context

The console WebSocket carries only message and reaction frames, while its poller diffs rooms only. Agent state, budgets, schedules, membership, and definitions stay stale until manual refetch. The unread-heal gap from T-1105 and reaction-removal staleness share one cause: no typed event stream.

## Decision

Add one frame taxonomy for agent, definition, membership, channel, budget, and schedule events, emitted at daemon state transitions. The console refreshes only the panel affected by each frame. A snapshot refetch on socket open remains the healing path after reconnect.

## Consequences

- The console API poller shrinks to room diffing because daemon transitions own non-room event emission.
- Every frame type gets a schema and a suite assertion.
- The TUI remains snapshot-based; live event subscription is not part of this decision.

## Alternatives considered

| Option | Why rejected |
|---|---|
| Per-panel polling | The existing rooms poller already produced two staleness bugs; more pollers multiply that failure mode. |
| Full-snapshot push on any change | Large payloads and repaint flicker add cost; incremental frames plus reconnect snapshots match the client pattern already proven. |

## Evidence

| Claim | Source |
|---|---|
| Console WebSocket and room poller | [`src/daemon/console-api.ts`](../../../src/daemon/console-api.ts) |
| Daemon state transition owner | [`src/daemon/supervisor.ts`](../../../src/daemon/supervisor.ts) |
