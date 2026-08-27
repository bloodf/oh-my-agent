# Asset map

Every module the delivery tree names, the task that owns it, and the tasks that read it. Use this to find the owning task before editing a file, so two tasks do not edit the same module from different directions.

`Exists` is computed when this file is generated: `not yet` means the module is specified but unwritten.

| Path | Exists | Owned by | Read by |
|---|---|---|---|
| `node_modules/@oh-my-pi/pi-ai/src/auth-broker/remote-store.ts` | yes | — | [T-303](tasks/T-303-client-integration.md) |
| `package.json` | yes | [T-001](tasks/T-001-package-scaffold.md), [T-502](tasks/T-502-daemon-entry-point.md) | — |
| `src/console/app.ts` | not yet | [T-603](tasks/T-603-console-client.md), [T-605](tasks/T-605-console-management.md) | — |
| `src/console/index.html` | not yet | [T-603](tasks/T-603-console-client.md) | — |
| `src/console/style.css` | not yet | [T-603](tasks/T-603-console-client.md) | — |
| `src/daemon/account-registry.ts` | yes | [T-404](tasks/T-404-account-registry.md) | [T-405](tasks/T-405-supervisor.md), [T-506](tasks/T-506-metered-budget-wiring.md) |
| `src/daemon/boot.ts` | yes | — | [T-502](tasks/T-502-daemon-entry-point.md) |
| `src/daemon/console-api.ts` | not yet | [T-602](tasks/T-602-console-api.md), [T-605](tasks/T-605-console-management.md) | [T-603](tasks/T-603-console-client.md) |
| `src/daemon/credential-gateway.ts` | yes | [T-301](tasks/T-301-credential-gateway.md), [T-302](tasks/T-302-shared-disable-recovery.md), [T-303](tasks/T-303-client-integration.md) | [T-004](tasks/T-004-broker-contract.md), [T-502](tasks/T-502-daemon-entry-point.md) |
| `src/daemon/main.ts` | not yet | [T-502](tasks/T-502-daemon-entry-point.md) | — |
| `src/daemon/materializer.ts` | yes | [T-201](tasks/T-201-materialization-engine.md) | [T-003](tasks/T-003-discovery-contract.md), [T-401](tasks/T-401-worker-lifecycle.md), [T-501](tasks/T-501-peer-store.md), [T-505](tasks/T-505-definition-staleness.md) |
| `src/daemon/peer-store.ts` | not yet | [T-501](tasks/T-501-peer-store.md), [T-505](tasks/T-505-definition-staleness.md), [T-605](tasks/T-605-console-management.md) | — |
| `src/daemon/quota-state.ts` | yes | [T-404](tasks/T-404-account-registry.md) | — |
| `src/daemon/scheduler.ts` | yes | [T-403](tasks/T-403-scheduler.md) | — |
| `src/daemon/socket.ts` | not yet | [T-502](tasks/T-502-daemon-entry-point.md) | [T-503](tasks/T-503-agent-toolbelt.md), [T-504](tasks/T-504-tui-surface.md) |
| `src/daemon/supervisor.ts` | yes | [T-405](tasks/T-405-supervisor.md), [T-505](tasks/T-505-definition-staleness.md), [T-506](tasks/T-506-metered-budget-wiring.md) | [T-502](tasks/T-502-daemon-entry-point.md), [T-601](tasks/T-601-conversation-model.md), [T-602](tasks/T-602-console-api.md) |
| `src/extension/commands.ts` | not yet | [T-504](tasks/T-504-tui-surface.md) | — |
| `src/extension/index.ts` | yes | [T-001](tasks/T-001-package-scaffold.md), [T-504](tasks/T-504-tui-surface.md) | — |
| `src/extension/widget.ts` | not yet | [T-504](tasks/T-504-tui-surface.md) | — |
| `src/rooms/store.ts` | yes | [T-402](tasks/T-402-room-store.md), [T-601](tasks/T-601-conversation-model.md) | [T-503](tasks/T-503-agent-toolbelt.md), [T-506](tasks/T-506-metered-budget-wiring.md), [T-602](tasks/T-602-console-api.md), [T-604](tasks/T-604-reaction-toolbelt.md) |
| `src/shared/agent-definition.ts` | yes | [T-101](tasks/T-101-peer-definition-parser.md) | [T-201](tasks/T-201-materialization-engine.md), [T-501](tasks/T-501-peer-store.md), [T-505](tasks/T-505-definition-staleness.md) |
| `src/worker/launch-gate.ts` | yes | [T-203](tasks/T-203-sandbox-launch-gate.md) | [T-401](tasks/T-401-worker-lifecycle.md) |
| `src/worker/lifecycle.ts` | yes | [T-204](tasks/T-204-shared-policy-builder.md), [T-401](tasks/T-401-worker-lifecycle.md), [T-505](tasks/T-505-definition-staleness.md) | [T-005](tasks/T-005-spawn-policy-contract.md), [T-503](tasks/T-503-agent-toolbelt.md) |
| `src/worker/sandbox.ts` | yes | [T-202](tasks/T-202-sandbox-policy-compiler.md) | [T-203](tasks/T-203-sandbox-launch-gate.md) |
| `src/worker/toolbelt.ts` | not yet | [T-503](tasks/T-503-agent-toolbelt.md), [T-604](tasks/T-604-reaction-toolbelt.md) | — |
| `tests/account-registry.test.ts` | yes | [T-404](tasks/T-404-account-registry.md) | — |
| `tests/agent-definition.test.ts` | yes | [T-101](tasks/T-101-peer-definition-parser.md) | — |
| `tests/contracts/broker.contract.test.ts` | yes | [T-004](tasks/T-004-broker-contract.md) | — |
| `tests/contracts/discovery.contract.test.ts` | yes | [T-003](tasks/T-003-discovery-contract.md) | — |
| `tests/contracts/spawn-policy.contract.test.ts` | yes | [T-005](tasks/T-005-spawn-policy-contract.md) | — |
| `tests/credential-gateway.test.ts` | yes | [T-301](tasks/T-301-credential-gateway.md), [T-302](tasks/T-302-shared-disable-recovery.md) | — |
| `tests/end-to-end.test.ts` | yes | [T-405](tasks/T-405-supervisor.md) | — |
| `tests/fixtures/fake-broker.ts` | yes | [T-002](tasks/T-002-test-harness.md) | — |
| `tests/fixtures/temp-agent-dir.ts` | yes | [T-002](tasks/T-002-test-harness.md) | — |
| `tests/gateway-client.test.ts` | yes | [T-303](tasks/T-303-client-integration.md) | — |
| `tests/materializer.test.ts` | yes | [T-201](tasks/T-201-materialization-engine.md) | — |
| `tests/rooms.test.ts` | yes | [T-402](tasks/T-402-room-store.md), [T-601](tasks/T-601-conversation-model.md) | — |
| `tests/sandbox-gate.test.ts` | yes | [T-203](tasks/T-203-sandbox-launch-gate.md) | — |
| `tests/sandbox.test.ts` | yes | [T-202](tasks/T-202-sandbox-policy-compiler.md) | — |
| `tests/scheduler.test.ts` | yes | [T-403](tasks/T-403-scheduler.md) | — |
| `tests/seatbelt-wiring.test.ts` | yes | [T-204](tasks/T-204-shared-policy-builder.md) | — |
| `tests/supervisor.test.ts` | yes | [T-405](tasks/T-405-supervisor.md) | — |
| `tests/worker-lifecycle.test.ts` | yes | [T-401](tasks/T-401-worker-lifecycle.md) | — |
