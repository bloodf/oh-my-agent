# T-1620 — A default staff team, ready on first boot, on the operator's model

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-16](../epics/EP-16-fidelity-and-hardening.md) | [SP-17](../sprints/SP-17-fidelity-and-hardening.md) | Done | [asset-map](../asset-map.md) |

## Goal

A fresh install has four working peers without writing a definition: staff-pm, staff-backend, staff-frontend, and staff-qa ship with the package, are seeded once into the user store, run on OMP's default model when they declare none, and can be pointed at any model the daemon's credentials reach from the TUI, the CLI, or the console.

## Read first

- [Peer store roots](../../../src/daemon/peer-store.ts)
- [Model resolution for a worker](../../../src/daemon/materializer.ts)
- [The scoped gateway's registry, reused for the catalog](../../../src/daemon/inference-gateway.ts)

## Files this task may change

- `src/defaults/agents/staff-pm.md`
- `src/defaults/agents/staff-backend.md`
- `src/defaults/agents/staff-frontend.md`
- `src/defaults/agents/staff-qa.md`
- `src/daemon/default-peers.ts`
- `src/daemon/default-model.ts`
- `src/daemon/runtime.ts`
- `src/daemon/inference-gateway.ts`
- `src/shared/protocol.ts`
- `src/shared/protocol-schemas.ts`
- `src/daemon/socket.ts`
- `src/daemon/cli.ts`
- `src/daemon/console-api.ts`
- `src/extension/commands.ts`
- `web/src/console/CreateAgentDialog.tsx`
- `tests/default-peers.test.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`src/defaults/agents/staff-pm.md`](../../../src/defaults/agents/staff-pm.md) | New | Staff product manager: scope, sequencing, acceptance criteria; #product and #team. |
| [`src/defaults/agents/staff-backend.md`](../../../src/defaults/agents/staff-backend.md) | New | Staff backend engineer: services, data, APIs, tests with non-vacuity; #backend and #team. |
| [`src/defaults/agents/staff-frontend.md`](../../../src/defaults/agents/staff-frontend.md) | New | Staff frontend engineer: accessible, fast interfaces against the published API; #frontend and #team. |
| [`src/defaults/agents/staff-qa.md`](../../../src/defaults/agents/staff-qa.md) | New | Staff QA engineer: verifies every criterion against the real system; #qa and #team. |
| [`src/daemon/default-peers.ts`](../../../src/daemon/default-peers.ts) | New | Seeds the shipped peers into the user store once; a marker keeps edits and deletions. |
| [`src/daemon/default-model.ts`](../../../src/daemon/default-model.ts) | New | OMP's default model role as a provider/id, thinking suffix dropped. |
| [`src/daemon/runtime.ts`](../../../src/daemon/runtime.ts) | Edited | Seeds on the launcher's boot, hands the default to a model-less worker on both paths, reports the effective model, and lists the catalog. |
| [`src/daemon/inference-gateway.ts`](../../../src/daemon/inference-gateway.ts) | Edited | listRoutableModels: the registry the scoped gateway builds, as a catalog. |
| [`src/shared/protocol.ts`](../../../src/shared/protocol.ts) | Edited | models_list, additive. |
| [`src/shared/protocol-schemas.ts`](../../../src/shared/protocol-schemas.ts) | Edited | models_list validators. |
| [`src/daemon/socket.ts`](../../../src/daemon/socket.ts) | Edited | models_list handler over an optional context capability. |
| [`src/daemon/cli.ts`](../../../src/daemon/cli.ts) | Edited | omp-agent models. |
| [`src/daemon/console-api.ts`](../../../src/daemon/console-api.ts) | Edited | GET /api/models. |
| [`src/extension/commands.ts`](../../../src/extension/commands.ts) | Edited | The model picker lists the catalog with the default marked and stores the bare selector. |
| [`web/src/console/CreateAgentDialog.tsx`](../../../web/src/console/CreateAgentDialog.tsx) | Edited | A datalist of the catalog and the default as the placeholder. |
| [`tests/default-peers.test.ts`](../../../tests/default-peers.test.ts) | New | The shipped definitions parse; seeding is offered once; the default model resolves from config.yml. |

## Steps

1. Write the four definitions with `spawns: "*"` and no model, so nothing depends on a task agent or a provider the operator has not set up.
2. Seed them once per user store from the real launcher only, recording every name offered so an edit or a deletion survives the next boot.
3. Resolve OMP's default model role at boot and hand it to the worker factory only for a peer that declares none; a declared model is never overridden.
4. Expose the catalog the scoped gateway already knows how to build as `models_list`, and offer it from every surface that edits a model.

## Acceptance

- [x] A launcher boot of an empty store lists the four staff peers running, each on the OMP default, and `agents` names that model.
- [x] A second boot seeds nothing; an edited or deleted seed is left as the operator left it.
- [x] `models_list` answers the catalog and the default; the TUI picker offers it and stores the bare selector when the marked default is chosen.

Evidence:

| Claim | Anchor |
|---|---|
| Shipped definitions parse; seeding once; edits and deletions kept; default model from config.yml | [`tests/default-peers.test.ts`](../../../tests/default-peers.test.ts) |
| Seeded peers boot on the default; a declared model is not overridden; models_list over the real socket | [`tests/daemon-main.test.ts`](../../../tests/daemon-main.test.ts) |
| The catalog names what the credential scope can reach | [`tests/inference-gateway.test.ts`](../../../tests/inference-gateway.test.ts) |
| The picker lists the catalog and stores the bare selector | [`tests/extension.test.ts`](../../../tests/extension.test.ts) |
| omp-agent models in text and JSON | [`tests/daemon-cli.test.ts`](../../../tests/daemon-cli.test.ts) |
| GET /api/models with and without a catalog | [`tests/console-api.test.ts`](../../../tests/console-api.test.ts) |

## Out of scope

- A thinking level for the default: the role's suffix is dropped because the worker gateway routes by provider/id only.

## Depends on

- T-1619

## Unblocks

- Nothing.
