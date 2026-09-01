# T-1611 — CLI JSON coverage for every verb

| Epic | Sprint | Status | Map |
|---|---|---|---|
| [EP-16](../epics/EP-16-fidelity-and-hardening.md) | [SP-17](../sprints/SP-17-fidelity-and-hardening.md) | Ready | [asset-map](../asset-map.md) |

## Goal

Every CLI verb's --json output is parsed by one parametrized contract, with the console verb's documented deviation asserted explicitly.

## Read first

- [CLI verbs](../../../src/daemon/cli.ts)
- [CLI integration suite](../../../tests/daemon-cli.test.ts)

## Files this task may change

- `tests/daemon-cli.test.ts`
- `src/daemon/cli.ts`

## Modules and assets in play

| Path | Role | Note |
|---|---|---|
| [`tests/daemon-cli.test.ts`](../../../tests/daemon-cli.test.ts) | Edited | Parametrizes --json parsing across every verb and names the console exception. |
| [`src/daemon/cli.ts`](../../../src/daemon/cli.ts) | Edited | Only changes if the exhaustive test exposes a JSON shape gap. |

## Steps

1. Enumerate every CLI verb in one parametrized --json parsing test instead of sampling status and agents.
2. Assert the console verb's documented output deviation as the sole explicit exception.
3. Fix cli.ts only where the exhaustive contract exposes a real shape gap.

## Acceptance

- [ ] A parametrized test covers all verbs' --json output parsing; the console verb's documented deviation is asserted as the exception.

## Out of scope

- Nothing deferred.

## Depends on

- Nothing.

## Unblocks

- Nothing.
