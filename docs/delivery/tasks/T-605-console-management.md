# T-605 — Create agents and channels from the UI

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-06](../epics/EP-06-web-console.md) | [SP-07](../sprints/SP-07-web-console.md) | Done | [asset-map](../asset-map.md) |

## Goal

An operator can stand up an agent or channel, and manage membership, without editing files.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [Peer store](../../../docs/delivery/tasks/T-501-peer-store.md)
- [Console client](../../../docs/delivery/tasks/T-603-console-client.md)
- [Definition staleness](../../../docs/delivery/tasks/T-505-definition-staleness.md)
- [Supervisor room filtering](../../../src/daemon/supervisor.ts)

## Files this task may change

- `src/console/app.js`
- `src/daemon/console-api.ts`
- `src/daemon/peer-store.ts`
- `src/daemon/supervisor.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/console/app.js`](../../../src/console/app.js) | Edited | Forms and membership controls (the client is plain JS; T-603). |
| [`src/daemon/console-api.ts`](../../../src/daemon/console-api.ts) | Edited | Write routes, including the reaction-toggle route the T-603 client already calls. |
| [`src/daemon/peer-store.ts`](../../../src/daemon/peer-store.ts) | Edited | Writing a definition, not only reading one. |
| [`src/daemon/supervisor.ts`](../../../src/daemon/supervisor.ts) | Edited | Live membership: the running peer's cached room set. |
| [`src/rooms/store.ts`](../../../src/rooms/store.ts) | Read | Durable subscriptions; T-402 owns it. |

## Steps

1. Write a created agent as a definition file in the private store, so the UI and a hand-written file produce the same thing and neither becomes a second source of truth.
2. Validate through `parsePeerDefinition` before writing, and surface the parse error in the form rather than writing a file the daemon will later refuse.
3. Let an operator add or remove an agent from a channel, updating both the durable subscription and the definition.
4. Apply the change to the *running* peer, not only to disk. `Supervisor.register` copies rooms into a private `Set` and `post()` filters against that copy, so a membership edit that stops at SQLite leaves a live agent deaf to its new channel and still woken by its old one.
5. Expose that as a single supervisor operation which re-reads membership and re-registers the peer, rather than letting the API mutate a private field: two writers to the same cached set is the defect this task exists to avoid.
6. Reuse T-505's fingerprint check for definition edits. Membership alone needs no rebuild, but any other change does, and a live worker's policy files never mutate under a running process.
7. Say plainly in the UI which changes took effect immediately and which need a rebuild.

## Acceptance

- [x] An agent created in the UI appears as a definition file and loads on the next daemon start.
- [x] An invalid definition is refused with the parser's own error, and no file is written.
- [x] Adding a *running* agent to a channel makes it receive the very next message there, with no restart.
- [x] Removing a running agent stops delivery on the next post, and does not disturb the channel's other members.
- [x] A definition edit that changes policy is reported as needing a rebuild rather than silently applied to a live worker.
- [x] The membership tests drive `Supervisor.post()`, not `RoomStore.post()`, since only the supervisor path proves a live peer was actually woken.

Evidence:

| Claim | Anchor |
|---|---|
| Management routes with hardened write path | [`src/daemon/console-api.ts`](../../../src/daemon/console-api.ts) |
| Store writes: safe names, path-keyed conflicts, atomic landings | [`src/daemon/peer-store.ts`](../../../src/daemon/peer-store.ts) |
| Console suites, API and browser, cover forms and membership | [`tests/console-api.test.ts`](../../../tests/console-api.test.ts) |

## Out of scope

- Nothing deferred.

## Depends on

- T-501
- T-505
- T-603

## Unblocks

- T-801
