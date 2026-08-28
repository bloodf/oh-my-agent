# ADR-006 — Quota is an account property; subscription accounts auto-resume unattended

**Status:** Accepted

## Context

Billing attaches to the account, not the agent. Several peers can share one account, so exhausting quota must park every run on that account, not just the peer that noticed. Requiring a human to unpark defeats the promise of unattended progress.

## Decision

The daemon keeps an account registry. Metered accounts warn at 80% of `budget_usd` and park at 100% pending a human bump. Subscription accounts have no dollar cap: on a quota block every run parks and a one-shot timer arms from the verified `blockedUntilMs`, resuming with no human in the loop.

## Consequences

- Resume must deliver, not merely restart: a restarted worker with a full backlog would otherwise idle.
- Re-arming uses the latest active deadline across blocks, not the incoming block's, so an earlier block cannot shorten a later one.
- The resume deadline is a verified upstream value, not a guess.

## Alternatives considered

| Option | Why rejected |
|---|---|
| Per-agent budgets | Peers sharing an account would each think they had a full budget. |
| Park until a human resumes | Defeats the product's central promise of unattended progress. |

## Evidence

| Claim | Source |
|---|---|
| Account registry and resume arming | [`src/daemon/account-registry.ts`](../../../src/daemon/account-registry.ts) |
| Quota state machine | [`src/daemon/quota-state.ts`](../../../src/daemon/quota-state.ts) |
| Upstream produces the block deadline | `ARCHITECTURE.md §10 open question 5` |
