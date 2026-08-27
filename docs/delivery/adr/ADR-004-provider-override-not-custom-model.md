# ADR-004 — Worker config emits a provider override, never a custom model entry

**Status:** Accepted

## Context

Routing a worker's turns through the gateway looked like a job for a `models:` block. It is not: `finalizeCustomModel` builds config models with no `transport` field, so a custom model cannot carry `pi-native` transport.

## Decision

Generated worker config emits a provider override only. The worker keeps selecting its real `provider/id`, and the override points that provider at the loopback gateway.

## Consequences

- Worker turns actually traverse the gateway instead of dialing the provider directly.
- `apiKey` resolves from the environment, so no token is written to disk.
- A future OMP change to custom-model transport handling would need this revisited.

## Alternatives considered

| Option | Why rejected |
|---|---|
| Custom `models:` entry pointing at the gateway | Config models carry no transport, so turns bypass the gateway and hit the real provider. |

## Evidence

| Claim | Source |
|---|---|
| Config models are built without a transport field | [`node_modules/@oh-my-pi/pi-coding-agent/src/config/custom-models.ts:124-148`](../../../node_modules/@oh-my-pi/pi-coding-agent/src/config/custom-models.ts) |
| Env is consulted before literal fallback | [`node_modules/@oh-my-pi/pi-coding-agent/src/config/model-config-values.ts:70-74`](../../../node_modules/@oh-my-pi/pi-coding-agent/src/config/model-config-values.ts) |
