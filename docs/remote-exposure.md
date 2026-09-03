# Remote console exposure

Remote mode with the console enabled requires `OMA_CONSOLE_ORIGIN`: the daemon refuses to boot without it, before the pidfile or any listener opens (ADR-012). Set it to the exact external HTTPS origin the console is served behind — no credentials, path, query, or hash. A headless remote daemon (`OMA_CONSOLE=0`) serves no console and needs no origin.

```sh
OMA_REMOTE=1 OMA_CONSOLE_PORT=50561 OMA_CONSOLE_ORIGIN=https://console.example.com omp-agent daemon
export OMA_PROXY_SECRET="$(cat "${OMA_AGENT_DIR:-$HOME/.omp/agent}/oh-my-agent/console-proxy-secret")"
```

Each usable recipe below forwards only to `127.0.0.1:50561`, the console listener. Never forward the credential gateway or its port. Keep `console-proxy-secret` mode `0600`; the trusted, host-local proxy overwrites `X-OMA-Proxy-Secret` before forwarding. Clients still need the operator token.

Remote browser access is supported. The browser keeps the operator token in `sessionStorage` and sends it only in request headers. For proxied remote traffic, `console-api.ts` checks that token on `/api/*` HTTP requests, including `POST /api/session` and `POST /api/ws-ticket`. Successful session authentication mints a ticket bound to `/`; the authenticated shell mints separate tickets for `/style.css` and `/app.js`; successful WebSocket-ticket authentication mints a ticket bound to `/api/events`. Static shell/asset loads and the WebSocket upgrade present those tickets instead of the operator token. Every ticket has a 30-second TTL, and `consumeTicket` deletes it before checking its path or expiry, so first presentation consumes it even when refused. `app.js` removes the root ticket from browser history. A remote API 401 revokes browser session: `app.js` blocks later API work and reconnects, closes live WebSockets, and invokes `__showOperatorAuth`, which clears stored token and returns to token entry. `tests/console-client.test.ts` checks token-free browser URLs and session revocation; `tests/remote-exposure.test.ts` checks server-side token and ticket boundaries.

## Threat model

This model covers one operator exposing one installation. It does not provide tenant identities, tenant isolation, delegated administration, or a safe shared token for mutually untrusted users. Multi-tenant operation is out of scope.

| Boundary or asset | Threat | Enforcing mechanism | Suite check |
|---|---|---|---|
| Remote-mode activation | Accidental proxy deployment silently changes trust rules. | `bootDaemon` enables remote enforcement only when `OMA_REMOTE=1` and logs active trust model. | `boot trust model logging` checks exact `trust model: remote` and `trust model: loopback` lines. |
| Listener reachability | Flag or host override exposes plaintext daemon listener. | Before `claimPidfile`, `bootDaemon` checks `OMA_CONSOLE_HOST`, `OMA_CONTROL_HOST`, and `OMA_CREDENTIAL_GATEWAY_HOST`; every non-loopback value is refused in every mode. | `bind-address config refused unconditionally` checks all three variables, stderr reason, absent pidfile, and flag-off refusal. |
| Room contents and operator authority | Unauthenticated caller reads rooms or exercises kill authority and other operator-only controls. | On proxied remote HTTP, `console-api.ts` serves unauthenticated `/` only as a 401 token-entry bootstrap and requires operator token for `/api/*` requests. After successful session authentication, one-time, path-bound, 30-second tickets authenticate full shell/assets and `/api/events` WebSocket upgrade. Separately, `socket.ts` resolves control-socket bearers to identities and requires operator identity for methods outside `workerMethods`; `kill` is outside that allowlist. | `remote mode authentication` checks anonymous shell/API and control-socket refusal. `remote console ticket authentication` checks token-authenticated minting plus ticket path, lifetime, and single-use enforcement. `remote mode control-socket hierarchy enforced` checks missing and unregistered bearer refusal, operator success, worker `chat_read` success, and worker refusal on representative operator-only `status`. |
| Credentials used through gateway | Remote operator controls workers that can use gateway-held credentials, or credential gateway itself becomes remotely reachable. | `credential-gateway.ts` binds its listener to `127.0.0.1`; `bootDaemon` also refuses non-loopback `OMA_CREDENTIAL_GATEWAY_HOST` before opening listeners. Proxy recipes forward only to console listener. Operator authentication grants console/control authority, not a provider credential. | `bind-address config refused unconditionally` checks gateway host refusal. `remote mode authentication` and `remote mode control-socket hierarchy enforced` check console and control authority boundaries. |
| Worker bearer scope | Scoped worker bearer becomes operator authority. | `main.ts` registers each active worker bearer as `{ kind: "worker", peerName }` in the control identity map. `socket.ts` resolves presented bearers against that map, permits worker identities only on `workerMethods`, and in remote mode refuses worker access to operator-only methods as unauthorized. | `a scoped worker token keeps its own surface in remote mode` proves worker `chat_read` succeeds while operator-only `status` returns unauthorized. |
| Forwarded identity | Direct loopback caller forges `X-Forwarded-*` to choose remote origin or audit source. | Remote boot loads or mints `console-proxy-secret` and enforces mode `0600`. `normalizeRequestUrl` honors forwarded scheme and host only when `X-OMA-Proxy-Secret` matches; forwarded source is accepted only for such normalized remote request. Proxy secret alone never authenticates operator. | `operator token file permissions`, `forwarded request URL normalization`, `forwarded identity`, and `records truthful sources without trusting unauthenticated forwarding` check secret mode, missing/wrong secret handling, proxy-secret-only refusal, and audit source. |
| Transport outside host | Network observer reads or alters console traffic. | External proxy must terminate HTTPS and inject proxy secret; daemon stays loopback-only and implements no TLS. | Focused suite checks daemon loopback bind and proxy-secret gate only. Live TLS, DNS, Caddy, Tailscale, and SSH rows remain `UNVERIFIED`. |
| Long-lived token disclosure in URLs | Browser history, referrers, or proxy logs retain operator token. | `OMA_CONSOLE_ORIGIN` accepts only HTTPS origin without credentials, path, query, or hash, and persisted/announced remote URL contains no operator token. `console-api.ts` authenticates remote `/api/*` requests with operator token in headers, then uses random tickets bound to one shell, asset, or WebSocket path with 30-second TTL; first presentation deletes each ticket before path and expiry checks. `app.js` removes root ticket with `history.replaceState`. | `tests/remote-exposure.test.ts`: `external console origin` and `remote console ticket authentication`. `tests/console-client.test.ts:2313-2372` checks keyboard token entry, `sessionStorage`, and token-free browser URLs. |
| Browser-session revocation | Refused operator credential leaves browser attempting work with stale authority. | Server returns 401 on failed remote `/api/*` operator-token checks. `app.js` converts first remote API 401 to `authenticationRequired`, closes sockets, blocks later requests and reconnects, and calls `__showOperatorAuth` to clear `sessionStorage`. | `tests/remote-exposure.test.ts`: `remote mode authentication`. `tests/console-client.test.ts:2456-2624` checks refused reconnect-ticket recovery plus blocked queued socket work and stale HTTP requests. |
| Parentage | Worker creates peer outside its authenticated ownership. | In remote mode, `socket.ts` accepts worker `agent_spawn` only when `params.parent` equals authenticated `peerName`; omitted or foreign parent is refused before dispatch. | `tests/remote-exposure.test.ts`: `remote worker spawn parent must match its authenticated identity` checks omitted and foreign parent refusal and proves a self-parent request reaches ordinary spawn validation. |
| Connection audit | Authenticated connections disappear from operator view, or audit state becomes unbounded or unsafe write target. | Remote `socket.ts` shares recorder with console API, logs connect/disconnect identity, class, source, and time, persists only live connections, caps them at 32, and refuses connection 33. Persistence uses `0600`, exclusive no-follow temporary file plus atomic rename; recorder creation refuses a state directory not owned by current user or group/world-writable. | `authenticated connection audit` checks log fields, live CLI output, close removal, 32-entry cap, secret omission, symlink/file collisions, file mode, and unsafe-directory refusal. |

Operator token protects room contents and operator-only authority, including authority to control workers that use gateway credentials. Proxy TLS protects transport outside the host. Proxy shared secret authenticates forwarded metadata, not operator. Neither token nor proxy turns this single-operator system into multi-tenant service.

## Before enabling remote mode

1. Set `OMA_REMOTE=1`. If console is enabled, set `OMA_CONSOLE_ORIGIN` to exact external HTTPS origin with no credentials, path, query, or hash. `OMA_CONSOLE=0` is only origin-free remote configuration.
2. Leave `OMA_CONSOLE_HOST`, `OMA_CONTROL_HOST`, and `OMA_CREDENTIAL_GATEWAY_HOST` unset or loopback. Daemon stderr is exactly: `daemon: <VARIABLE>=<ADDRESS> is not a loopback address. The daemon never binds a routable address in any mode, with or without OMA_REMOTE; expose it through a reverse proxy that forwards to the loopback listener (ADR-012).`
3. Verify `console-token` is non-empty and belongs only to this installation; do not copy or share it. The daemon cannot detect token provenance: it reuses any non-empty stored value and mints a new random value only when the file is absent or empty. Rotate by stopping the daemon, deleting the file, and restarting. `loopback default` checks reuse across boots; `operator token file permissions` checks the `0600` gate. Neither test establishes that an operator-supplied stored value is unique or unshared.
4. Verify `console-token` and `console-proxy-secret` are exactly mode `0600`. Boot refuses either loose file with `<PATH> has mode <MODE>, not 0600: any local process can read the console token. Run 'chmod 600 <PATH>' to keep this token, or delete the file to rotate it.`
5. Verify proxy terminates valid TLS, injects `X-OMA-Proxy-Secret` from `console-proxy-secret`, overwrites any client-supplied value, forwards only to loopback console listener, redacts auth material, and enforces recipe rate limit. A successful proxied request must produce an `audit:` line with `"class":"console-proxied"`; ordinary API success alone does not prove secret injection.
6. Read daemon boot log before exposure. Required enforcement line is exactly `trust model: remote`. Missing origin refuses with `OMA_CONSOLE_ORIGIN is required when OMA_REMOTE=1 and the console is enabled; set it to the external HTTPS origin the console is served behind, or set OMA_CONSOLE=0 for a headless remote daemon.` Unsafe audit storage refuses with `Refusing unsafe audit state directory: <PATH> must be owned by this user and not group- or world-writable`.

On Linux, check files without printing secrets:

```sh
state_dir="${OMA_AGENT_DIR:-$HOME/.omp/agent}/oh-my-agent"
test -s "$state_dir/console-token"
test "$(stat -c '%a' "$state_dir/console-token")" = 600
test "$(stat -c '%a' "$state_dir/console-proxy-secret")" = 600
```

On macOS, replace each `stat -c '%a'` with `stat -f '%Lp'`.

## Audit commands

Run these on daemon host. They read bounded `connection-audit.json`; they do not contact proxy and do not prove TLS.

```sh
omp-agent audit
omp-agent --json audit
```

Expected first line is `trust model: remote`. Each live row contains authenticated identity, connection class, source, and connection time. Short HTTP requests also leave `audit:` connect/disconnect lines on daemon stderr but normally finish too quickly to remain in live `omp-agent audit` output. Operator token, proxy secret, and one-time tickets are excluded from both surfaces.

Use live audit while remote browser WebSocket remains open:

```sh
omp-agent --json audit
```

Confirm one `operator` / `console-proxied` row and expected client IP. Close browser, rerun, and confirm row disappears. A full 32-connection audit refuses next authenticated console connection instead of serving traffic without recording it.

## Proxy recipes


The Caddy examples require the real `rate_limit` handler, not a header-only imitation:

```sh
xcaddy build --with github.com/mholt/caddy-ratelimit
```

Their access-log filter redacts `?token=` and deletes operator-auth headers. Keep Caddy's `log_credentials` global option disabled (the default).

## Caddy with public TLS

Set `console.example.com` to a DNS name pointing at this host, allow inbound TCP 443, then run the custom Caddy binary with `OMA_PROXY_SECRET` in its service environment and `OMA_CONSOLE_ORIGIN=https://console.example.com` on the daemon.

```caddyfile
{
	order rate_limit before reverse_proxy
}

console.example.com {
	rate_limit {
		zone console {
			key {http.request.remote.host}
			events 120
			window 1m
		}
	}

	reverse_proxy 127.0.0.1:50561 {
		header_up X-OMA-Proxy-Secret "{$OMA_PROXY_SECRET}"
	}

	log {
		output file /var/log/caddy/oma-console.json
		format filter {
			wrap json
			fields {
				request>uri query {
					replace token REDACTED
				}
				request>headers>Authorization delete
				request>headers>X-Operator-Token delete
			}
		}
	}
}
```

Caddy terminates public TLS. No routable daemon bind exists, and no route targets the credential gateway. Open remote browser at `https://console.example.com` without query string, enter operator token in prompt, then confirm URL never contains `token=` and `omp-agent audit` shows live `operator` / `console-proxied` WebSocket.

bind-address config refused unconditionally
token required
hierarchy enforced

## `tailscale serve`

Put a rate-limiting, header-injecting Caddy boundary on loopback first, and set `OMA_CONSOLE_ORIGIN` on the daemon to the tailnet HTTPS name `tailscale serve` publishes (e.g. `https://daemon-host.your-tailnet.ts.net`):

```caddyfile
{
	order rate_limit before reverse_proxy
}

http://127.0.0.1:8443 {
	rate_limit {
		zone console {
			key oma-tailnet-console
			events 120
			window 1m
		}
	}

	reverse_proxy 127.0.0.1:50561 {
		header_up X-OMA-Proxy-Secret "{$OMA_PROXY_SECRET}"
	}

	log {
		output file /var/log/caddy/oma-console-tailnet.json
		format filter {
			wrap json
			fields {
				request>uri query {
					replace token REDACTED
				}
				request>headers>Authorization delete
				request>headers>X-Operator-Token delete
			}
		}
	}
}
```

Start Caddy with `OMA_PROXY_SECRET` in its environment, then publish only that loopback proxy:

```sh
tailscale serve --bg http://127.0.0.1:8443
tailscale serve status
```

`tailscale serve` terminates tailnet HTTPS; Caddy supplies global rate limiting and trusted header boundary behind it. Neither layer targets credential gateway. Open published HTTPS URL without query string, authenticate in prompt, and confirm live `operator` / `console-proxied` WebSocket through `omp-agent audit`.

bind-address config refused unconditionally
token required
hierarchy enforced

## SSH tunnel with loopback Caddy

SSH alone has no HTTPS origin, so remote mode's console preflight (ADR-012) refuses it unpaired. The outer SSH transport is encrypted, but encryption alone is not the security boundary: Caddy remains the TLS/auth proxy boundary in front of the daemon, same as every other recipe. Topology: browser or API client at `https://oma-console.test:8443` -> SSH encrypted local port forward -> remote `127.0.0.1:8443` Caddy with `tls internal` -> daemon `127.0.0.1:50561`. ADR-012's rejection of SSH as the only story stands unchanged: this recipe pairs SSH with the same Caddy boundary every other recipe uses, it does not replace it.

This recipe needs three terminals: two on the remote host, one on the operator machine. Nothing backgrounds; each command below runs in the terminal it is assigned to, and the last command in each of the three stays foregrounded for the session. No PID files, no job control.

### Remote terminal 1: daemon

Start the daemon here, in the foreground, with the origin set to the tunnel's local endpoint, not the remote host's own address. The daemon never needs the proxy secret; do not export it in this terminal.

```sh
OMA_REMOTE=1 OMA_CONSOLE_PORT=50561 OMA_CONSOLE_ORIGIN=https://oma-console.test:8443 omp-agent daemon
```

### Remote terminal 2: Caddy

Enforce mode `0600` before reading:

```sh
proxy_secret="${OMA_AGENT_DIR:-$HOME/.omp/agent}/oh-my-agent/console-proxy-secret"
chmod 600 "$proxy_secret"
export OMA_PROXY_SECRET="$(cat "$proxy_secret")"
mkdir -p "$HOME/.local/state/caddy"
```

Write the Caddyfile, bound to loopback only, with a self-signed local CA:

```caddyfile
{
	order rate_limit before reverse_proxy
}

https://oma-console.test:8443 {
	bind 127.0.0.1
	tls internal

	rate_limit {
		zone console {
			key oma-ssh-console
			events 120
			window 1m
		}
	}

	reverse_proxy 127.0.0.1:50561 {
		header_up X-OMA-Proxy-Secret "{$OMA_PROXY_SECRET}"
	}

	log {
		output file {$HOME}/.local/state/caddy/oma-console-ssh.json
		format filter {
			wrap json
			fields {
				request>uri query {
					replace token REDACTED
				}
				request>headers>Authorization delete
				request>headers>X-Operator-Token delete
			}
		}
	}
}
```

Start Caddy in this same terminal, in the foreground, as an unprivileged user-level process (port 8443 needs no root); it inherits `OMA_PROXY_SECRET` from the export above:

```sh
caddy run --config ./Caddyfile --adapter caddyfile
```

### Operator terminal: CA trust and tunnel

Map the tunnel hostname locally before trusting the CA or opening the tunnel:

```sh
echo "127.0.0.1 oma-console.test" | sudo tee -a /etc/hosts
```

`oma-console.test` is deliberately not `localhost`: the daemon's loopback carve-out only fires for actual loopback names, and this recipe exercises the same remote-mode origin/token hardening a real DNS name gets, while `/etc/hosts` still resolves it straight into the tunnel.

`tls internal` mints a CA local to that Caddy instance; the operator machine must trust it once. Once Caddy (remote terminal 2) is running, verify the SSH host key fingerprint, then copy the CA off the remote host:

```sh
scp user@remote-host:~/.local/share/caddy/pki/authorities/local/root.crt ./oma-remote-ca.crt
```

Trust it on the operator machine only, never distribute it further:

```sh
# macOS
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ./oma-remote-ca.crt

# Debian/Ubuntu
sudo cp ./oma-remote-ca.crt /usr/local/share/ca-certificates/oma-remote-ca.crt
sudo update-ca-certificates
```

Now open the tunnel in this same terminal, in the foreground; it occupies this terminal for the session:

```sh
ssh -N -L 127.0.0.1:8443:127.0.0.1:8443 user@remote-host
```

Reach console at tunnel endpoint with no query string: use `https://oma-console.test:8443`, never `https://oma-console.test:8443?token=...`. Enter operator token in browser prompt, confirm root ticket disappears from URL, then confirm live `operator` / `console-proxied` WebSocket through `omp-agent audit`.

bind-address config refused unconditionally
token required
hierarchy enforced

## CLI URL boundary

With remote mode and console enabled, `omp-agent console` prints the validated `OMA_CONSOLE_ORIGIN` and never a URL containing the long-lived operator token. Loopback mode keeps its token-bearing URL. A headless daemon has no console URL.

## Real-proxy evidence

No recipe is claimed verified against live proxy on this machine. Caddy, Tailscale, and SSH infrastructure was not available for this run.

| Recipe | Date | Version | Result |
|---|---|---|---|
| Caddy with public TLS | UNVERIFIED — real-proxy run not performed | UNVERIFIED — real-proxy run not performed | UNVERIFIED — real-proxy run not performed |
| `tailscale serve` | UNVERIFIED — real-proxy run not performed | UNVERIFIED — real-proxy run not performed | UNVERIFIED — real-proxy run not performed |
| SSH tunnel with loopback Caddy | UNVERIFIED — real-proxy run not performed | UNVERIFIED — real-proxy run not performed | UNVERIFIED — real-proxy run not performed |
| SSH-only tunnel | REJECTED — no external HTTPS origin | N/A | Remote console startup refuses this configuration |

To fill each `UNVERIFIED` row, operator must run that recipe on real infrastructure and record UTC date, exact tool version, and result:

1. **Caddy with public TLS:** run custom `xcaddy` build plus Caddy recipe on public DNS; from a second machine verify trusted HTTPS certificate, rate-limit behavior, header injection evidenced by `console-proxied` audit source, browser login, no `token=` URL, one-time static loads, WebSocket connect, and audit removal on close. Record `caddy version`.
2. **`tailscale serve`:** run Caddy boundary and `tailscale serve` from two tailnet devices; repeat TLS, login, URL, WebSocket, source, cap, and close checks. Record `tailscale version` and `caddy version`.
3. **SSH tunnel with loopback Caddy:** run all three terminals on distinct operator and remote hosts; verify SSH host key, trusted Caddy local CA, HTTPS endpoint, browser login, no token URL, WebSocket, source, cap, and close checks. Record `ssh -V` and `caddy version`.

Do not replace `UNVERIFIED` with `PASS` from unit tests, loopback curl, config inspection, or this document. Those prove daemon behavior only, not real proxy transport.
