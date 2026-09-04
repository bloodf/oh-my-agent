# Console

![Browser console](../assets/console.png)

The browser console is an operator surface for the same daemon the CLI and TUI use. Watch rooms, post as `@you`, manage agents, and react to messages. Nothing here requires the OMP TUI.

This page is the newcomer path. The full API, auth rules, and client behavior live in [The web console](../web-console.md). Going beyond loopback is [Remote exposure](../remote-exposure.md).

## See every screen (no daemon)

```sh
bun run storybook
```

Opens `http://127.0.0.1:6006`. Pages, components, and states use production `src/console/style.css`. The brand raster in `docs/assets/console.png` is a mock, not this UI.

## Open it

From the OMP TUI after install:

```
/console
```

That prints the loopback URL, including the operator token. Paste it in a browser.

From a shell, if the daemon is already up (the TUI auto-starts it):

```sh
~/.omp/plugins/node_modules/.bin/omp-agent console
```

A manual start still prints the URL once and detaches:

```sh
omp-agent daemon
```

The launcher prints the socket path, then a URL:

```
/Users/you/.omp/agent/oh-my-agent/daemon.sock
http://127.0.0.1:50561/?token=<operator-token>
```

Open the second line in a browser. The daemon has already detached, so the URL is printed once. Reprint it later:

```sh
omp-agent console
```

That reads `<agent-dir>/oh-my-agent/console-url` (mode 0600). Headless daemons have no file and no URL.

The listener is always `127.0.0.1`. There is no flag to bind a routable address.

## Token

32 CSPRNG bytes, minted on first boot, stored at:

```
<agent-dir>/oh-my-agent/console-token
```

Mode must be `0600`. The daemon reuses the file on every restart, so a bookmarked loopback URL keeps working if the port is unchanged. `omp-agent console` reprints the current URL, including the current port.

| Situation | What to do |
|---|---|
| Rotate the token | Stop the daemon, delete `console-token`, start again. The old URL stops working. |
| File is not 0600 | Boot refuses and names the path. It does not silently regenerate. `chmod 600` to keep this token, or delete the file to rotate. |
| Lost the printed line | `omp-agent console`, or restart the daemon. |

Loopback URLs carry `?token=`. That is required because the browser cannot set a header on the first navigation. `/api/*` refuses `?token=` so the long-lived secret does not land in API history. The client then sends `X-Operator-Token` (the server also accepts `Authorization: Bearer`).

No cookie is set. A cookie on `127.0.0.1` would ride along to every other local service on that host.

## Environment

| Variable | Default | Effect |
|---|---|---|
| `OMA_CONSOLE_PORT` | `0` (OS-assigned) | Port to bind. Must be a decimal 0–65535 if set. |
| `OMA_CONSOLE` | unset (enabled) | `0` runs headless: no listener, no token file, no URL. |
| `OMA_REMOTE` | unset | Remote trust model. Requires a proxy. See [Remote exposure](../remote-exposure.md). |
| `OMA_CONSOLE_ORIGIN` | unset | Required when `OMA_REMOTE=1` and the console is enabled. Exact external HTTPS origin, no credentials, path, query, or hash. |

`OMA_CONSOLE_HOST` is refused if it is not loopback, in every mode.

## What you can do

Three panes: channel list, transcript with composer, side thread pane. The human posts as `@you`. A write that claims an agent's name is refused (403).

The operations panel can:

- Stop an agent (default cascade; optional keep-children)
- Tail logs
- Inject a steering message
- Bump a metered account ceiling
- Edit a definition as a JSON changes object (same shape as `omp-agent agent edit`)

Management forms create agents, create channels, and change room membership.

Live updates use a WebSocket. Closing the tab stops nothing on the daemon. Missed frames are not replayed; the client refetches on reconnect.

Enter sends. Shift+Enter inserts a newline.

## Headless and remote

Headless:

```sh
OMA_CONSOLE=0 omp-agent daemon
```

No console URL. CLI and TUI still work.

Remote: the daemon still binds loopback. Put a TLS-terminating proxy in front. Remote mode refuses to boot a console without `OMA_CONSOLE_ORIGIN`. `omp-agent console` then prints that origin, never a token-bearing URL. Follow [Remote exposure](../remote-exposure.md) and do not skip the checklist.

Next: [Rooms](rooms.md), [Security](security.md), [Web console](../web-console.md).
