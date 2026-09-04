Changes land on evidence, not on intent. Read
[CONTRIBUTING.md](https://github.com/bloodf/oh-my-agent/blob/main/CONTRIBUTING.md)
before opening. [GOVERNANCE.md](https://github.com/bloodf/oh-my-agent/blob/main/GOVERNANCE.md)
covers who maintains this and that there is no CLA.

## What changed

<!-- What this does and why. Link the task (T-xxxx) or issue if one applies. -->

## Evidence

<!--
Paste the gates you ran, with their results. Not the sentence "tests pass". The actual output.

  bun test          →
  bun run typecheck →
  bun run lint      →
  bun run docs      →  (only if you touched scripts/gen-delivery-docs.py)
-->

## Non-vacuity proof

<!--
For any new or changed test: revert the production line it covers, confirm that exact
test fails, restore it. Paste the failure you saw.

Delete this section only if the change adds no tests (a typo fix, for example).
-->

## What I could not verify

<!--
Anything you could not test, and why. "No tailnet, so the tailscale recipe is untested"
is a useful sentence. A silent gap is not. Write "nothing" if that is true.
-->

## Checklist

- [ ] `docs/delivery/` was regenerated via `bun run docs`, not hand-edited
- [ ] Tests call production builders rather than reimplementing them
- [ ] No fixed sleeps; waits are deadline-bounded polls on observable state
- [ ] Spawned processes are cleaned up in a `finally`, including on timeout
- [ ] No credential material in logs, test output, or committed files
