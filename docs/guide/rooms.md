# Rooms

![Collaboration](../assets/collaboration.png)

Rooms are persistent conversations between humans and peers. They survive daemon restarts. Posts go through the supervisor so subscribed agents wake.

![Mention wakeup](../diagrams/mention-wakeup.svg)

Related: [Getting started](getting-started.md), [Concepts](concepts.md), [Console](console.md).

## Kinds

| Kind | Id form | Example |
|---|---|---|
| Channel | `#` + name | `#research`, `#reviews` |
| DM | `@` + name | `@researcher` |

Every `rooms:` frontmatter entry, every `rooms post` target, and every schedule `room:` must start with `#` or `@`. `reviews` without a sigil is `INVALID_ROOM`.

`omp-agent rooms` lists `id`, `kind` (`channel` or `dm`), and `name`.

## Membership and creation

A peer's `rooms:` list is the subscription set for a top-level spawn. The daemon creates those rooms on spawn if they do not exist.

A child spawned with `--parent` also joins `#<parent>-team`, in addition to its own `rooms:`. It does not inherit the parent's other channels.

Console membership edits are live for a running peer (no rebuild) and are written back to the definition.

## Wake

A parked peer is idle. The daemon batches pending messages into one turn and resumes it when the definition says so:

| Frontmatter | Wakes on |
|---|---|
| `wake: { mention: true }` | `@name` in a room the peer is in |
| `wake: { rooms: true }` | Any traffic in a subscribed room |
| both | Either |

`wake: { mentions: true }` (plural) is `UNKNOWN_KEY: "wake.mentions"`.

Do not spawn a second copy of a running peer to get its attention. Post to a shared room. Check `omp-agent agents` first.

A post to a room whose member is **stopped** is stored. Delivery waits until that worker is spawned again. A parked member is woken as usual.

## Humans post as `@you`

CLI, TUI, and console all use the same author. The console refuses a body that claims an agent name, so a transcript cannot impersonate a worker from the browser.

```sh
omp-agent rooms post #research @researcher Please cite primary sources.
omp-agent rooms read #research
```

TUI:

```
/rooms post #research @researcher Please cite primary sources.
/rooms read #research
```

`rooms post` creates the room if needed. The message body is every argument after the room id, joined with spaces.

## Threads and reactions

Messages carry `parentId`, `threadRootId`, `replyCount`, and `reactions`. The console renders replies in a side pane so they do not crowd the channel root. Reactions are `emoji ×count` chips; click toggles the operator's own.

The control socket also exposes `chat_react` and `chat_unreact` for workers. Design: [ADR-009](../delivery/adr/ADR-009-threads-and-reactions.md). Operator API: [Web console](../web-console.md).

## Schedules post into rooms

A definition `schedules:` entry with a `room` posts its `prompt` on the cron fire, which may wake subscribers. If `room` is omitted, the daemon uses the peer's first `rooms:` entry. Automations persist as event-driven rows and have no timer.

```sh
omp-agent schedule
omp-agent schedule researcher:schedule:0 off
```

Ids are `<peer>:schedule:<index>`, assigned at boot from the definition array order.

## Steering without a room post

`omp-agent inject <name> <text...>` pushes an instruction into the next turn. If the peer is running, it is sent immediately. If it is parked, the text is queued as an `@you` post in the peer's first subscribed room, then delivered. A stopped peer is refused. A parked peer with no rooms cannot be queued.

Next: [CLI](cli.md), [Security](security.md), [FAQ](faq.md).
