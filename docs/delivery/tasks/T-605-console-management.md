# T-605 — Create agents and channels from the UI

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-06](../epics/EP-06-web-console.md) | [SP-07](../sprints/SP-07-web-console.md) | Blocked | [asset-map](../asset-map.md) |

## Goal

An operator can stand up an agent or channel, and manage membership, without editing files.

## Read first

- [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- [Peer store](../../../docs/delivery/tasks/T-501-peer-store.md)
- [Console client](../../../docs/delivery/tasks/T-603-console-client.md)

## Files this task may change

- `src/console/app.ts`
- `src/daemon/console-api.ts`
- `src/daemon/peer-store.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| `src/console/app.ts` (to be created) | Edited | Forms and membership controls. |
| `src/daemon/console-api.ts` (to be created) | Edited | Write routes. |
| `src/daemon/peer-store.ts` (to be created) | Edited | Writing a definition, not only reading one. |

## Steps

1. Write a created agent as a definition file in the private store, so the UI and a hand-written file produce the same thing and neither becomes a second source of truth.
2. Validate through `parsePeerDefinition` before writing, and surface the parse error in the form rather than writing a file the daemon will later refuse.
3. Let an operator add or remove an agent from a channel, updating its subscriptions.
4. Say plainly in the UI when a change needs a rebuild: a live worker's definition is fingerprinted and policy files never mutate under a running process.

## Acceptance

- [ ] An agent created in the UI appears as a definition file and loads on the next daemon start.
- [ ] An invalid definition is refused with the parser's own error, and no file is written.
- [ ] Adding an agent to a channel makes it receive the next message there.
- [ ] Removing it stops delivery without disturbing the channel's other members.

## Out of scope

- Nothing deferred.

## Depends on

- T-501
- T-603

## Unblocks

- Nothing.
