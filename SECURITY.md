# Security policy

`oh-my-agent` runs autonomous agents that hold provider credentials, spend real money,
and can be exposed beyond loopback. Security reports are taken seriously.

## Reporting a vulnerability

**Do not open a public issue for a vulnerability.**

Use GitHub's private reporting:
[Report a vulnerability](https://github.com/bloodf/oh-my-agent/security/advisories/new).

Please include:

- What an attacker can do, and what they need first (local user? loopback access?
  a valid operator token? a compromised proxy?).
- Reproduction steps or a proof-of-concept.
- The commit or version you tested.

You will get an acknowledgement. If the report is valid, you will be credited in the
release notes unless you prefer otherwise.

This project is maintained without a support contract, so no response-time guarantee is
offered. Reports are handled as promptly as the maintainer can manage.

## Supported versions

Only the latest release and `main` receive fixes. There are no backports to earlier versions.

## Security model

The trust model is written down and enforced by tests, not by convention:

- [`docs/remote-exposure.md`](docs/remote-exposure.md) — the threat model, what each
  mechanism enforces, and the operator checklist.
- [`ADR-012`](docs/delivery/adr/ADR-012-remote-exposure.md) — the remote exposure decision.
- [`tests/remote-exposure.test.ts`](tests/remote-exposure.test.ts) — the assertions
  behind those claims.

Load-bearing properties, each covered by tests:

| Property | Enforcement |
|---|---|
| No listener ever binds a routable address | Refused unconditionally at boot, in every mode |
| Remote `/api/*` requires the operator token | Constant-time comparison; unregistered bearers refused |
| Static assets and the WebSocket upgrade | One-time, path-bound tickets with a 30s TTL, minted only after token auth |
| Forwarded identity | Trusted only when the per-install proxy shared secret verifies |
| Long-lived tokens in remote URLs | Never; remote mode requires an explicit external HTTPS origin |
| Worker authority | Scoped bearers reach worker methods only; operator surfaces refuse them |
| Parentage in remote mode | Enforced against caller identity, not cooperative metadata |
| Credential gateway | Loopback-always; operator auth grants console/control authority, never provider credentials |

### Out of scope

- **Multi-tenancy.** One operator per daemon. There is no user model and no
  cross-operator isolation. Do not treat the operator token as a per-user credential.
- **The daemon terminating TLS.** By design (ADR-012). TLS terminates at a proxy;
  the daemon stays on loopback.
- **Sandboxing in-process workers.** The in-process backend is explicitly not sandboxed.
  Use the default RPC subprocess backend when isolation matters.

### Known gaps

One of the three documented proxy recipes in `docs/remote-exposure.md` still carries an
`UNVERIFIED` row: `tailscale serve` needs one dated end-to-end run against a real proxy.
The Caddy and SSH-tunnel recipes were run end to end on 2026-09-03 against real
Caddy-terminated TLS from a separate operator machine, on an internal CA rather than
public ACME; public ACME issuance and renewal remain unproven. This is tracked as T-1202
and is stated in the doc rather than glossed over.

## Handling credentials

If you are contributing: never commit tokens, never add a test that reads a real
credential, and never log token material. The suite asserts that audit output, logs, and
the persisted state file contain no credential material — keep it that way.
