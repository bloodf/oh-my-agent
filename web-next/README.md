# oh-my-agent console (Next.js, server-rendered)

A second console for the same daemon, rendered on the server. Pages fetch
the daemon's console API with the operator token held server-side; the
browser talks only to this origin. Message and plan bodies are rendered as
Markdown on the server, so a page without diagrams ships no mermaid.

```sh
bun run console:next:dev      # http://127.0.0.1:4388, against the running daemon
bun run console:next:build
bun run console:next:start
```

The daemon is found through `~/.omp/agent/oh-my-agent/console-url`
(`PI_CODING_AGENT_DIR` respected), or `OMA_CONSOLE_URL`.

Status and parity gaps: see `docs/web-console.md`.
