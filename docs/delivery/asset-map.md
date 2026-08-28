# Asset map

Every module the delivery tree names, the task that owns it, and the tasks that read it. Use this to find the owning task before editing a file, so two tasks do not edit the same module from different directions.

`Exists` is computed when this file is generated: `not yet` means the module is specified but unwritten.

| Path | Exists | Owned by | Read by |
|---|---|---|---|
| `.github/workflows/ci.yml` | yes | [T-701](tasks/T-701-ci-workflow.md) | — |
| `ARCHITECTURE.md` | yes | — | [T-703](tasks/T-703-root-readme-and-metadata.md) |
| `LICENSE` | yes | [T-703](tasks/T-703-root-readme-and-metadata.md) | — |
| `README.md` | yes | [T-703](tasks/T-703-root-readme-and-metadata.md) | — |
| `agents/example-researcher.md` | yes | [T-501](tasks/T-501-peer-store.md) | — |
| `agents/example-reviewer.md` | yes | [T-501](tasks/T-501-peer-store.md) | — |
| `biome.json` | yes | [T-702](tasks/T-702-biome-lint.md) | — |
| `node_modules/@oh-my-pi/pi-ai/src/auth-broker/remote-store.ts` | yes | — | [T-303](tasks/T-303-client-integration.md) |
| `package.json` | yes | [T-001](tasks/T-001-package-scaffold.md), [T-502](tasks/T-502-daemon-entry-point.md), [T-702](tasks/T-702-biome-lint.md), [T-703](tasks/T-703-root-readme-and-metadata.md), [T-804](tasks/T-804-authoring-skills.md) | [T-701](tasks/T-701-ci-workflow.md) |
| `scripts/gen-delivery-docs.py` | yes | — | [T-701](tasks/T-701-ci-workflow.md) |
| `skills/omp-agent-authoring/SKILL.md` | yes | [T-804](tasks/T-804-authoring-skills.md) | — |
| `skills/omp-orchestration/SKILL.md` | yes | [T-804](tasks/T-804-authoring-skills.md) | — |
| `skills/omp-subagent-authoring/SKILL.md` | yes | [T-804](tasks/T-804-authoring-skills.md) | — |
| `src/console/app.js` | yes | [T-603](tasks/T-603-console-client.md), [T-605](tasks/T-605-console-management.md) | — |
| `src/console/index.html` | yes | [T-603](tasks/T-603-console-client.md) | — |
| `src/console/style.css` | yes | [T-603](tasks/T-603-console-client.md) | — |
| `src/daemon/account-registry.ts` | yes | [T-404](tasks/T-404-account-registry.md) | [T-405](tasks/T-405-supervisor.md), [T-506](tasks/T-506-metered-budget-wiring.md) |
| `src/daemon/boot.ts` | yes | [T-510](tasks/T-510-broker-hosting-resolution.md) | [T-502](tasks/T-502-daemon-entry-point.md) |
| `src/daemon/console-api.ts` | yes | [T-602](tasks/T-602-console-api.md), [T-605](tasks/T-605-console-management.md) | [T-603](tasks/T-603-console-client.md) |
| `src/daemon/credential-gateway.ts` | yes | [T-301](tasks/T-301-credential-gateway.md), [T-302](tasks/T-302-shared-disable-recovery.md), [T-303](tasks/T-303-client-integration.md) | [T-004](tasks/T-004-broker-contract.md), [T-510](tasks/T-510-broker-hosting-resolution.md), [T-502](tasks/T-502-daemon-entry-point.md) |
| `src/daemon/db.ts` | yes | [T-508](tasks/T-508-daemon-persistence.md), [T-802](tasks/T-802-daemon-hierarchy.md) | — |
| `src/daemon/main.ts` | yes | [T-502](tasks/T-502-daemon-entry-point.md), [T-508](tasks/T-508-daemon-persistence.md), [T-802](tasks/T-802-daemon-hierarchy.md) | — |
| `src/daemon/materializer.ts` | yes | [T-201](tasks/T-201-materialization-engine.md), [T-205](tasks/T-205-worker-env-scrub.md) | [T-003](tasks/T-003-discovery-contract.md), [T-401](tasks/T-401-worker-lifecycle.md), [T-501](tasks/T-501-peer-store.md), [T-508](tasks/T-508-daemon-persistence.md), [T-505](tasks/T-505-definition-staleness.md) |
| `src/daemon/peer-store.ts` | yes | [T-501](tasks/T-501-peer-store.md), [T-505](tasks/T-505-definition-staleness.md), [T-605](tasks/T-605-console-management.md) | — |
| `src/daemon/quota-state.ts` | yes | [T-404](tasks/T-404-account-registry.md) | — |
| `src/daemon/scheduler.ts` | yes | [T-403](tasks/T-403-scheduler.md) | — |
| `src/daemon/socket.ts` | yes | [T-502](tasks/T-502-daemon-entry-point.md), [T-511](tasks/T-511-operator-steering.md), [T-512](tasks/T-512-sandboxed-on-the-wire.md), [T-513](tasks/T-513-reaction-methods-on-the-socket.md), [T-802](tasks/T-802-daemon-hierarchy.md) | [T-503](tasks/T-503-agent-toolbelt.md), [T-504](tasks/T-504-tui-surface.md) |
| `src/daemon/supervisor.ts` | yes | [T-405](tasks/T-405-supervisor.md), [T-505](tasks/T-505-definition-staleness.md), [T-506](tasks/T-506-metered-budget-wiring.md), [T-509](tasks/T-509-wake-filters.md), [T-605](tasks/T-605-console-management.md) | [T-502](tasks/T-502-daemon-entry-point.md), [T-601](tasks/T-601-conversation-model.md), [T-602](tasks/T-602-console-api.md) |
| `src/extension/commands.ts` | yes | [T-504](tasks/T-504-tui-surface.md), [T-511](tasks/T-511-operator-steering.md), [T-901](tasks/T-901-tui-tree.md), [T-903](tasks/T-903-tui-editing.md) | — |
| `src/extension/index.ts` | yes | [T-001](tasks/T-001-package-scaffold.md), [T-504](tasks/T-504-tui-surface.md), [T-902](tasks/T-902-tui-manager.md) | — |
| `src/extension/manager.ts` | not yet | [T-902](tasks/T-902-tui-manager.md), [T-903](tasks/T-903-tui-editing.md) | — |
| `src/extension/widget.ts` | yes | [T-504](tasks/T-504-tui-surface.md), [T-901](tasks/T-901-tui-tree.md) | — |
| `src/rooms/store.ts` | yes | [T-402](tasks/T-402-room-store.md), [T-509](tasks/T-509-wake-filters.md), [T-601](tasks/T-601-conversation-model.md) | [T-508](tasks/T-508-daemon-persistence.md), [T-503](tasks/T-503-agent-toolbelt.md), [T-506](tasks/T-506-metered-budget-wiring.md), [T-602](tasks/T-602-console-api.md), [T-604](tasks/T-604-reaction-toolbelt.md), [T-605](tasks/T-605-console-management.md) |
| `src/shared/agent-definition.ts` | yes | [T-101](tasks/T-101-peer-definition-parser.md) | [T-201](tasks/T-201-materialization-engine.md), [T-501](tasks/T-501-peer-store.md), [T-505](tasks/T-505-definition-staleness.md), [T-509](tasks/T-509-wake-filters.md) |
| `src/shared/env-scrub.ts` | yes | [T-205](tasks/T-205-worker-env-scrub.md) | — |
| `src/shared/protocol-schemas.ts` | yes | [T-507](tasks/T-507-control-socket-protocol.md), [T-511](tasks/T-511-operator-steering.md), [T-512](tasks/T-512-sandboxed-on-the-wire.md), [T-513](tasks/T-513-reaction-methods-on-the-socket.md), [T-801](tasks/T-801-hierarchy-protocol.md) | — |
| `src/shared/protocol.ts` | yes | [T-507](tasks/T-507-control-socket-protocol.md), [T-511](tasks/T-511-operator-steering.md), [T-512](tasks/T-512-sandboxed-on-the-wire.md), [T-513](tasks/T-513-reaction-methods-on-the-socket.md), [T-801](tasks/T-801-hierarchy-protocol.md) | [T-502](tasks/T-502-daemon-entry-point.md), [T-503](tasks/T-503-agent-toolbelt.md), [T-504](tasks/T-504-tui-surface.md) |
| `src/worker/launch-gate.ts` | yes | [T-203](tasks/T-203-sandbox-launch-gate.md) | [T-401](tasks/T-401-worker-lifecycle.md) |
| `src/worker/lifecycle.ts` | yes | [T-204](tasks/T-204-shared-policy-builder.md), [T-401](tasks/T-401-worker-lifecycle.md), [T-505](tasks/T-505-definition-staleness.md) | [T-005](tasks/T-005-spawn-policy-contract.md), [T-503](tasks/T-503-agent-toolbelt.md) |
| `src/worker/sandbox.ts` | yes | [T-202](tasks/T-202-sandbox-policy-compiler.md) | [T-203](tasks/T-203-sandbox-launch-gate.md) |
| `src/worker/toolbelt.ts` | yes | [T-503](tasks/T-503-agent-toolbelt.md), [T-604](tasks/T-604-reaction-toolbelt.md), [T-803](tasks/T-803-toolbelt-authoring.md) | — |
| `tests/` | yes | [T-704](tasks/T-704-deflake-intermittent-test.md) | — |
| `tests/account-registry.test.ts` | yes | [T-404](tasks/T-404-account-registry.md) | — |
| `tests/agent-definition.test.ts` | yes | [T-101](tasks/T-101-peer-definition-parser.md) | — |
| `tests/console-api.test.ts` | yes | [T-602](tasks/T-602-console-api.md) | — |
| `tests/console-client.test.ts` | yes | [T-603](tasks/T-603-console-client.md) | — |
| `tests/contracts/broker.contract.test.ts` | yes | [T-004](tasks/T-004-broker-contract.md) | — |
| `tests/contracts/discovery.contract.test.ts` | yes | [T-003](tasks/T-003-discovery-contract.md), [T-007](tasks/T-007-hermetic-child-environments.md) | — |
| `tests/contracts/spawn-policy.contract.test.ts` | yes | [T-005](tasks/T-005-spawn-policy-contract.md) | — |
| `tests/credential-gateway.test.ts` | yes | [T-301](tasks/T-301-credential-gateway.md), [T-302](tasks/T-302-shared-disable-recovery.md) | — |
| `tests/daemon-boot.test.ts` | yes | [T-510](tasks/T-510-broker-hosting-resolution.md) | — |
| `tests/daemon-hierarchy.test.ts` | yes | [T-802](tasks/T-802-daemon-hierarchy.md) | — |
| `tests/daemon-main.test.ts` | yes | [T-502](tasks/T-502-daemon-entry-point.md), [T-511](tasks/T-511-operator-steering.md), [T-512](tasks/T-512-sandboxed-on-the-wire.md), [T-513](tasks/T-513-reaction-methods-on-the-socket.md) | — |
| `tests/daemon-persistence.test.ts` | yes | [T-508](tasks/T-508-daemon-persistence.md) | — |
| `tests/end-to-end.test.ts` | yes | [T-405](tasks/T-405-supervisor.md) | — |
| `tests/extension.test.ts` | yes | [T-504](tasks/T-504-tui-surface.md), [T-511](tasks/T-511-operator-steering.md), [T-901](tasks/T-901-tui-tree.md), [T-902](tasks/T-902-tui-manager.md), [T-903](tasks/T-903-tui-editing.md) | — |
| `tests/fixtures/fake-broker.ts` | yes | [T-002](tasks/T-002-test-harness.md) | — |
| `tests/fixtures/hermetic-env.ts` | yes | [T-007](tasks/T-007-hermetic-child-environments.md), [T-205](tasks/T-205-worker-env-scrub.md) | — |
| `tests/fixtures/temp-agent-dir.ts` | yes | [T-002](tasks/T-002-test-harness.md) | [T-007](tasks/T-007-hermetic-child-environments.md) |
| `tests/gateway-client.test.ts` | yes | [T-303](tasks/T-303-client-integration.md) | — |
| `tests/harness.test.ts` | yes | [T-002](tasks/T-002-test-harness.md) | — |
| `tests/materializer.test.ts` | yes | [T-201](tasks/T-201-materialization-engine.md), [T-205](tasks/T-205-worker-env-scrub.md) | — |
| `tests/peer-store.test.ts` | yes | [T-501](tasks/T-501-peer-store.md) | — |
| `tests/protocol.contract.test.ts` | yes | [T-507](tasks/T-507-control-socket-protocol.md), [T-511](tasks/T-511-operator-steering.md), [T-513](tasks/T-513-reaction-methods-on-the-socket.md), [T-801](tasks/T-801-hierarchy-protocol.md) | — |
| `tests/rooms.test.ts` | yes | [T-402](tasks/T-402-room-store.md), [T-601](tasks/T-601-conversation-model.md) | — |
| `tests/sandbox-gate.test.ts` | yes | [T-203](tasks/T-203-sandbox-launch-gate.md) | — |
| `tests/sandbox.test.ts` | yes | [T-202](tasks/T-202-sandbox-policy-compiler.md) | — |
| `tests/scaffold.test.ts` | yes | [T-001](tasks/T-001-package-scaffold.md) | — |
| `tests/scheduler.test.ts` | yes | [T-403](tasks/T-403-scheduler.md) | — |
| `tests/seatbelt-wiring.test.ts` | yes | [T-204](tasks/T-204-shared-policy-builder.md) | — |
| `tests/skills.test.ts` | yes | [T-804](tasks/T-804-authoring-skills.md) | — |
| `tests/supervisor.test.ts` | yes | [T-405](tasks/T-405-supervisor.md), [T-505](tasks/T-505-definition-staleness.md), [T-506](tasks/T-506-metered-budget-wiring.md), [T-509](tasks/T-509-wake-filters.md) | — |
| `tests/toolbelt.test.ts` | yes | [T-503](tasks/T-503-agent-toolbelt.md), [T-513](tasks/T-513-reaction-methods-on-the-socket.md), [T-604](tasks/T-604-reaction-toolbelt.md), [T-803](tasks/T-803-toolbelt-authoring.md) | — |
| `tests/worker-lifecycle.test.ts` | yes | [T-401](tasks/T-401-worker-lifecycle.md) | — |
| `tsconfig.json` | yes | [T-001](tasks/T-001-package-scaffold.md) | — |
