# SP-13 — Beyond loopback

**Status:** Ready

*Derived from the tasks below.*

## Theme

Remote exposure of the console and control socket under one declared trust model: proxy TLS, operator token, enforced hierarchy.

## Tasks

| Task | Epic | Title | Status |
|---|---|---|---|
| [T-1201](../tasks/T-1201-exposure-policy.md) | [EP-12](../epics/EP-12-remote-exposure.md) | Remote-mode surface and bind refusal | Ready |
| [T-1202](../tasks/T-1202-tls-termination.md) | [EP-12](../epics/EP-12-remote-exposure.md) | Proxy recipes and behind-proxy correctness | Blocked |
| [T-1203](../tasks/T-1203-remote-console-auth.md) | [EP-12](../epics/EP-12-remote-exposure.md) | Operator-token flow in the console client | Blocked |
| [T-1204](../tasks/T-1204-authoritative-hierarchy.md) | [EP-12](../epics/EP-12-remote-exposure.md) | Hierarchy enforcement flips in remote mode | Blocked |
| [T-1205](../tasks/T-1205-exposure-runbook.md) | [EP-12](../epics/EP-12-remote-exposure.md) | Threat model and operator checklist | Blocked |
| [T-1206](../tasks/T-1206-authenticated-connection-audit.md) | [EP-12](../epics/EP-12-remote-exposure.md) | Authenticated-connection audit surface | Blocked |
