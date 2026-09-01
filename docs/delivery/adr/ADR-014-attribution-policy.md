# ADR-014 — Console speaks as the human; workers speak as themselves; nobody else speaks

**Status:** Accepted

## Context

Console posts and reactions accept caller-supplied attribution, so any non-peer label is accepted and stopped-agent names can be impersonated. Worker chat methods on the control socket likewise take caller-supplied author or actor values that are not bound to the authenticated connection. ADR-011's cooperative-metadata problem repeats one layer down.

## Decision

The console derives HUMAN_AUTHOR server-side and ignores client-supplied attribution. Worker calls to chat_send, chat_react, and chat_unreact have their attribution overwritten with the authenticated connection identity's peer name. The operator token keeps full attribution override as the human's privileged credential, and that privilege is documented.

## Consequences

- Console POST stops honoring its author parameter; this is additive-safe because that value was only intended to represent the human label.
- A worker can no longer post or react as another peer, so room transcripts retain enforceable authorship.
- Attribution is enforced from connection identity prepared by T-1004, not trusted payload metadata.

## Alternatives considered

| Option | Why rejected |
|---|---|
| Bind only the console, leave the socket | Workers impersonating peers makes room transcripts meaningless and was never a designed capability. |
| Reject mismatched attribution instead of overwriting | An LLM worker that mislabels itself enters an error loop; overwriting is lossless and loggable. |

## Evidence

| Claim | Source |
|---|---|
| Console handlers accept caller-supplied attribution | [`src/daemon/console-api.ts`](../../../src/daemon/console-api.ts) |
| Worker chat methods accept payload attribution | [`src/daemon/socket.ts`](../../../src/daemon/socket.ts) |
