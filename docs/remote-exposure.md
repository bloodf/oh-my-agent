# Remote console exposure

Remote mode with the console enabled requires `OMA_CONSOLE_ORIGIN`: the daemon refuses to boot without it, before the pidfile or any listener opens (ADR-012). Set it to the exact external HTTPS origin the console is served behind — no credentials, path, query, or hash. A headless remote daemon (`OMA_CONSOLE=0`) serves no console and needs no origin.

```sh
OMA_REMOTE=1 OMA_CONSOLE_PORT=50561 OMA_CONSOLE_ORIGIN=https://console.example.com omp-agent daemon
export OMA_PROXY_SECRET="$(cat "${OMA_AGENT_DIR:-$HOME/.omp/agent}/oh-my-agent/console-proxy-secret")"
```

Each usable recipe below forwards only to `127.0.0.1:50561`, the console listener. Never forward the credential gateway or its port. Keep `console-proxy-secret` mode `0600`; the trusted, host-local proxy overwrites `X-OMA-Proxy-Secret` before forwarding. Clients still need the operator token.

Every recipe is transport-only until T-1203 ships the one-time-ticket or `__Host-` cookie login boundary. Current static responses propagate the operator token in subresource URLs, so opening any remote browser URL would violate ADR-012 even when proxy logs redact it. API clients may send the operator token in `Authorization`; never put it in a remote URL.

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

Caddy terminates public TLS. No routable daemon bind exists, and no route targets the credential gateway. This recipe is transport-only until T-1203 supplies browser-safe login; do not open the console in a remote browser yet.

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

`tailscale serve` terminates tailnet HTTPS; Caddy supplies real global rate limiting and the trusted header boundary behind it. Neither layer targets the credential gateway. This recipe is transport-only until T-1203 supplies browser-safe login; do not open the console in a remote browser yet.

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

Reach the console at the tunnel's local endpoint, no query string: use `https://oma-console.test:8443`, never `https://oma-console.test:8443?token=...`. This recipe is transport-only until T-1203 supplies browser-safe login; do not open the console in a remote browser yet. API clients may send the operator token in `Authorization`; never put it in a remote URL.

bind-address config refused unconditionally
token required
hierarchy enforced

## CLI URL boundary

With remote mode and console enabled, `omp-agent console` prints the validated `OMA_CONSOLE_ORIGIN` and never a URL containing the long-lived operator token. Loopback mode keeps its token-bearing URL. A headless daemon has no console URL.

## Real-proxy evidence

No recipe is claimed verified against a live proxy.

| Recipe | Date | Version | Result |
|---|---|---|---|
| Caddy with public TLS | UNVERIFIED — real-proxy run not performed | UNVERIFIED — real-proxy run not performed | UNVERIFIED — real-proxy run not performed |
| `tailscale serve` | UNVERIFIED — real-proxy run not performed | UNVERIFIED — real-proxy run not performed | UNVERIFIED — real-proxy run not performed |
| SSH tunnel with loopback Caddy | UNVERIFIED — real-proxy run not performed | UNVERIFIED — real-proxy run not performed | UNVERIFIED — real-proxy run not performed |
| SSH-only tunnel | REJECTED — no external HTTPS origin | N/A | Remote console startup refuses this configuration |
