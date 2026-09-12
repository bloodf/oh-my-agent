---
name: lavish
description: Turn a plan, comparison, diagram, table, code diff, report, or prototype into a rich HTML artifact the operator reviews and annotates in Lavish Editor, then poll for their feedback. Use when the answer is easier to grasp as a page than as prose.
license: MIT
metadata:
  author: Kun Chen (kunchenguid)
  upstream: https://github.com/kunchenguid/lavish-axi
  argument-hint: <what the artifact should show>
---

# Lavish Editor

Lavish Editor opens an HTML file you wrote in the operator's browser so they can pinpoint elements and selected text, edit Mermaid whiteboards, and send feedback back to you. It is an AXI: a CLI you run, no setup.

This copy is a stub on purpose. The current workflow, design guidance, and playbooks live in the CLI, so they cannot go stale here:

- `npx -y lavish-axi --help` for commands and the review loop
- `npx -y lavish-axi design` for design direction and the whiteboard opt-in snippet
- `npx -y lavish-axi playbook <id>` for one artifact type (`npx -y lavish-axi playbook` lists ids)

If `lavish-axi` is on your PATH, use it in place of `npx -y lavish-axi`.

## Inside oh-my-agent

- Write the artifact under your workspace (the channel's working directory) as `<topic>.html`, then run `npx -y lavish-axi <file>`. The daemon sets `LAVISH_AXI_NO_OPEN=1` for you: no browser opens on the operator's machine. The session appears in the console's **Artifacts** view, where the operator opens it.
- Post one line in the room where the work lives naming the file and what to review, so the operator knows it is waiting.
- Then run `npx -y lavish-axi poll <file>` in the foreground and wait. It stays silent until feedback arrives; never kill it, never background it. Apply the feedback, then `npx -y lavish-axi poll <file> --agent-reply "<what you changed>"`.
- When the operator ends the session, stop polling and report in the room. Do not reopen it uninvited.

## Request

$ARGUMENTS

If the request above is non-empty, build that artifact. If it is empty, infer what to visualize from the conversation.
