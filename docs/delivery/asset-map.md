# Asset map

Every module the delivery tree names, the task that owns it, and the tasks that read it. Use this to find the owning task before editing a file, so two tasks do not edit the same module from different directions.

`Exists` is computed when this file is generated: `not yet` means the module is specified but unwritten.

| Path | Exists | Owned by | Read by |
|---|---|---|---|
| `.github/workflows/ci.yml` | yes | [T-701](tasks/T-701-ci-workflow.md), [T-705](tasks/T-705-spawn-test-time-budget.md), [T-1302](tasks/T-1302-versioning-policy.md), [T-1305](tasks/T-1305-patch-hygiene-gate.md), [T-1306](tasks/T-1306-consumer-install-smoke.md) | — |
| `.github/workflows/release.yml` | yes | [T-1303](tasks/T-1303-release-ci.md), [T-1504](tasks/T-1504-drop-rpc-pid-patch.md) | — |
| `.gitignore` | yes | [T-1402](tasks/T-1402-dogfood-harness.md) | — |
| `ARCHITECTURE.md` | yes | [T-1205](tasks/T-1205-exposure-runbook.md) | [T-703](tasks/T-703-root-readme-and-metadata.md) |
| `CHANGELOG.md` | yes | [T-1302](tasks/T-1302-versioning-policy.md) | — |
| `LICENSE` | yes | [T-703](tasks/T-703-root-readme-and-metadata.md) | — |
| `README.md` | yes | [T-703](tasks/T-703-root-readme-and-metadata.md), [T-1205](tasks/T-1205-exposure-runbook.md), [T-1302](tasks/T-1302-versioning-policy.md), [T-1304](tasks/T-1304-install-docs.md) | — |
| `agents/example-researcher.md` | yes | [T-501](tasks/T-501-peer-store.md) | — |
| `agents/example-reviewer.md` | yes | [T-501](tasks/T-501-peer-store.md) | — |
| `biome.json` | yes | [T-702](tasks/T-702-biome-lint.md) | — |
| `bun.lock` | yes | [T-1503](tasks/T-1503-drop-resolve-walk.md) | — |
| `docs/dogfooding.md` | yes | [T-1401](tasks/T-1401-dogfood-runbook.md), [T-1403](tasks/T-1403-first-live-session.md), [T-1404](tasks/T-1404-live-session-safety-rails.md), [T-1405](tasks/T-1405-daemon-backend-selector.md) | — |
| `docs/remote-exposure.md` | yes | [T-1202](tasks/T-1202-tls-termination.md), [T-1205](tasks/T-1205-exposure-runbook.md) | — |
| `docs/web-console.md` | yes | [T-1001](tasks/T-1001-console-mounted-at-boot.md), [T-1101](tasks/T-1101-console-visual-system.md) | — |
| `node_modules/@oh-my-pi/pi-ai/src/auth-broker/remote-store.ts` | yes | — | [T-303](tasks/T-303-client-integration.md) |
| `package.json` | yes | [T-001](tasks/T-001-package-scaffold.md), [T-502](tasks/T-502-daemon-entry-point.md), [T-702](tasks/T-702-biome-lint.md), [T-703](tasks/T-703-root-readme-and-metadata.md), [T-705](tasks/T-705-spawn-test-time-budget.md), [T-804](tasks/T-804-authoring-skills.md), [T-1003](tasks/T-1003-worker-pid-on-the-wire.md), [T-1301](tasks/T-1301-packable-artifact.md), [T-1303](tasks/T-1303-release-ci.md), [T-1306](tasks/T-1306-consumer-install-smoke.md), [T-1503](tasks/T-1503-drop-resolve-walk.md), [T-1504](tasks/T-1504-drop-rpc-pid-patch.md) | [T-701](tasks/T-701-ci-workflow.md), [T-1613](tasks/T-1613-build-hygiene-test.md) |
| `patches/@oh-my-pi%2Fpi-coding-agent@18.0.7.patch` | yes | [T-1003](tasks/T-1003-worker-pid-on-the-wire.md), [T-1504](tasks/T-1504-drop-rpc-pid-patch.md) | [T-1301](tasks/T-1301-packable-artifact.md) |
| `repro/bun-plugin-memo/README.md` | yes | [T-1501](tasks/T-1501-repro-import-meta-resolve.md) | — |
| `repro/bun-plugin-memo/bun.lock` | yes | [T-1501](tasks/T-1501-repro-import-meta-resolve.md) | — |
| `repro/bun-plugin-memo/package.json` | yes | [T-1501](tasks/T-1501-repro-import-meta-resolve.md) | — |
| `repro/bun-plugin-memo/repro.ts` | yes | [T-1501](tasks/T-1501-repro-import-meta-resolve.md) | — |
| `scripts/check-patches.py` | yes | [T-1305](tasks/T-1305-patch-hygiene-gate.md) | — |
| `scripts/dogfood.ts` | yes | [T-1402](tasks/T-1402-dogfood-harness.md), [T-1404](tasks/T-1404-live-session-safety-rails.md), [T-1405](tasks/T-1405-daemon-backend-selector.md) | — |
| `scripts/gen-delivery-docs.py` | yes | [T-1403](tasks/T-1403-first-live-session.md), [T-1502](tasks/T-1502-file-upstream-issues.md) | [T-701](tasks/T-701-ci-workflow.md) |
| `skills/omp-agent-authoring/SKILL.md` | yes | [T-804](tasks/T-804-authoring-skills.md) | — |
| `skills/omp-orchestration/SKILL.md` | yes | [T-804](tasks/T-804-authoring-skills.md) | — |
| `skills/omp-subagent-authoring/SKILL.md` | yes | [T-804](tasks/T-804-authoring-skills.md) | — |
| `src/console/` | yes | — | [T-1001](tasks/T-1001-console-mounted-at-boot.md) |
| `src/console/app.js` | yes | [T-603](tasks/T-603-console-client.md), [T-605](tasks/T-605-console-management.md), [T-1101](tasks/T-1101-console-visual-system.md), [T-1102](tasks/T-1102-console-accessibility.md), [T-1104](tasks/T-1104-console-focus-stability.md), [T-1105](tasks/T-1105-unread-reconcile-on-open.md), [T-1203](tasks/T-1203-remote-console-auth.md), [T-1601](tasks/T-1601-console-thread-parentage.md), [T-1602](tasks/T-1602-reaction-removal-frames.md), [T-1604](tasks/T-1604-typed-daemon-events.md), [T-1605](tasks/T-1605-console-ops-panel.md), [T-1607](tasks/T-1607-authoring-parity.md), [T-1608](tasks/T-1608-mentions-fidelity.md), [T-1615](tasks/T-1615-repaint-focus-stability.md) | — |
| `src/console/index.html` | yes | [T-603](tasks/T-603-console-client.md), [T-1101](tasks/T-1101-console-visual-system.md), [T-1102](tasks/T-1102-console-accessibility.md), [T-1203](tasks/T-1203-remote-console-auth.md), [T-1605](tasks/T-1605-console-ops-panel.md), [T-1607](tasks/T-1607-authoring-parity.md) | [T-1615](tasks/T-1615-repaint-focus-stability.md) |
| `src/console/style.css` | yes | [T-603](tasks/T-603-console-client.md), [T-1101](tasks/T-1101-console-visual-system.md), [T-1102](tasks/T-1102-console-accessibility.md), [T-1605](tasks/T-1605-console-ops-panel.md), [T-1607](tasks/T-1607-authoring-parity.md), [T-1608](tasks/T-1608-mentions-fidelity.md) | — |
| `src/daemon/account-registry.ts` | yes | [T-404](tasks/T-404-account-registry.md), [T-1002](tasks/T-1002-usage-feeds-the-meter.md) | [T-405](tasks/T-405-supervisor.md), [T-506](tasks/T-506-metered-budget-wiring.md) |
| `src/daemon/boot.ts` | yes | [T-510](tasks/T-510-broker-hosting-resolution.md) | [T-502](tasks/T-502-daemon-entry-point.md) |
| `src/daemon/cli.ts` | yes | [T-1103](tasks/T-1103-cli-management-surface.md), [T-1206](tasks/T-1206-authenticated-connection-audit.md), [T-1405](tasks/T-1405-daemon-backend-selector.md), [T-1606](tasks/T-1606-daemon-lifecycle-verbs.md), [T-1607](tasks/T-1607-authoring-parity.md), [T-1611](tasks/T-1611-cli-json-everywhere.md) | — |
| `src/daemon/console-api.ts` | yes | [T-602](tasks/T-602-console-api.md), [T-605](tasks/T-605-console-management.md), [T-1001](tasks/T-1001-console-mounted-at-boot.md), [T-1201](tasks/T-1201-exposure-policy.md), [T-1202](tasks/T-1202-tls-termination.md), [T-1203](tasks/T-1203-remote-console-auth.md), [T-1206](tasks/T-1206-authenticated-connection-audit.md), [T-1601](tasks/T-1601-console-thread-parentage.md), [T-1602](tasks/T-1602-reaction-removal-frames.md), [T-1603](tasks/T-1603-attribution-enforcement.md), [T-1604](tasks/T-1604-typed-daemon-events.md), [T-1605](tasks/T-1605-console-ops-panel.md), [T-1607](tasks/T-1607-authoring-parity.md) | [T-603](tasks/T-603-console-client.md) |
| `src/daemon/credential-gateway.ts` | yes | [T-301](tasks/T-301-credential-gateway.md), [T-302](tasks/T-302-shared-disable-recovery.md), [T-303](tasks/T-303-client-integration.md) | [T-004](tasks/T-004-broker-contract.md), [T-510](tasks/T-510-broker-hosting-resolution.md), [T-502](tasks/T-502-daemon-entry-point.md) |
| `src/daemon/db.ts` | yes | [T-508](tasks/T-508-daemon-persistence.md), [T-802](tasks/T-802-daemon-hierarchy.md) | — |
| `src/daemon/main.ts` | yes | [T-502](tasks/T-502-daemon-entry-point.md), [T-508](tasks/T-508-daemon-persistence.md), [T-802](tasks/T-802-daemon-hierarchy.md), [T-1001](tasks/T-1001-console-mounted-at-boot.md), [T-1002](tasks/T-1002-usage-feeds-the-meter.md), [T-1003](tasks/T-1003-worker-pid-on-the-wire.md), [T-1004](tasks/T-1004-control-socket-identity.md), [T-1006](tasks/T-1006-in-process-worker-path.md), [T-1103](tasks/T-1103-cli-management-surface.md), [T-1201](tasks/T-1201-exposure-policy.md), [T-1202](tasks/T-1202-tls-termination.md), [T-1204](tasks/T-1204-authoritative-hierarchy.md), [T-1405](tasks/T-1405-daemon-backend-selector.md), [T-1604](tasks/T-1604-typed-daemon-events.md), [T-1605](tasks/T-1605-console-ops-panel.md), [T-1606](tasks/T-1606-daemon-lifecycle-verbs.md) | — |
| `src/daemon/materializer.ts` | yes | [T-201](tasks/T-201-materialization-engine.md), [T-205](tasks/T-205-worker-env-scrub.md), [T-1005](tasks/T-1005-worker-env-allowlist.md) | [T-003](tasks/T-003-discovery-contract.md), [T-401](tasks/T-401-worker-lifecycle.md), [T-501](tasks/T-501-peer-store.md), [T-508](tasks/T-508-daemon-persistence.md), [T-505](tasks/T-505-definition-staleness.md) |
| `src/daemon/operations.ts` | yes | [T-1605](tasks/T-1605-console-ops-panel.md) | — |
| `src/daemon/peer-store.ts` | yes | [T-501](tasks/T-501-peer-store.md), [T-505](tasks/T-505-definition-staleness.md), [T-605](tasks/T-605-console-management.md) | — |
| `src/daemon/quota-state.ts` | yes | [T-404](tasks/T-404-account-registry.md) | — |
| `src/daemon/scheduler.ts` | yes | [T-403](tasks/T-403-scheduler.md) | — |
| `src/daemon/socket.ts` | yes | [T-502](tasks/T-502-daemon-entry-point.md), [T-511](tasks/T-511-operator-steering.md), [T-512](tasks/T-512-sandboxed-on-the-wire.md), [T-513](tasks/T-513-reaction-methods-on-the-socket.md), [T-802](tasks/T-802-daemon-hierarchy.md), [T-1003](tasks/T-1003-worker-pid-on-the-wire.md), [T-1004](tasks/T-1004-control-socket-identity.md), [T-1201](tasks/T-1201-exposure-policy.md), [T-1204](tasks/T-1204-authoritative-hierarchy.md), [T-1206](tasks/T-1206-authenticated-connection-audit.md), [T-1603](tasks/T-1603-attribution-enforcement.md), [T-1605](tasks/T-1605-console-ops-panel.md), [T-1606](tasks/T-1606-daemon-lifecycle-verbs.md), [T-1608](tasks/T-1608-mentions-fidelity.md), [T-1610](tasks/T-1610-unreact-contract.md), [T-1616](tasks/T-1616-control-cap-json-rpc.md) | [T-503](tasks/T-503-agent-toolbelt.md), [T-504](tasks/T-504-tui-surface.md) |
| `src/daemon/supervisor.ts` | yes | [T-405](tasks/T-405-supervisor.md), [T-505](tasks/T-505-definition-staleness.md), [T-506](tasks/T-506-metered-budget-wiring.md), [T-509](tasks/T-509-wake-filters.md), [T-605](tasks/T-605-console-management.md), [T-1601](tasks/T-1601-console-thread-parentage.md), [T-1604](tasks/T-1604-typed-daemon-events.md) | [T-502](tasks/T-502-daemon-entry-point.md), [T-601](tasks/T-601-conversation-model.md), [T-602](tasks/T-602-console-api.md) |
| `src/extension/commands.ts` | yes | [T-504](tasks/T-504-tui-surface.md), [T-511](tasks/T-511-operator-steering.md), [T-901](tasks/T-901-tui-tree.md), [T-903](tasks/T-903-tui-editing.md) | — |
| `src/extension/index.ts` | yes | [T-001](tasks/T-001-package-scaffold.md), [T-504](tasks/T-504-tui-surface.md), [T-902](tasks/T-902-tui-manager.md) | — |
| `src/extension/manager.ts` | yes | [T-902](tasks/T-902-tui-manager.md), [T-903](tasks/T-903-tui-editing.md) | — |
| `src/extension/widget.ts` | yes | [T-504](tasks/T-504-tui-surface.md), [T-901](tasks/T-901-tui-tree.md), [T-1004](tasks/T-1004-control-socket-identity.md) | — |
| `src/rooms/store.ts` | yes | [T-402](tasks/T-402-room-store.md), [T-509](tasks/T-509-wake-filters.md), [T-601](tasks/T-601-conversation-model.md) | [T-508](tasks/T-508-daemon-persistence.md), [T-503](tasks/T-503-agent-toolbelt.md), [T-506](tasks/T-506-metered-budget-wiring.md), [T-602](tasks/T-602-console-api.md), [T-604](tasks/T-604-reaction-toolbelt.md), [T-605](tasks/T-605-console-management.md) |
| `src/shared/agent-definition.ts` | yes | [T-101](tasks/T-101-peer-definition-parser.md), [T-1002](tasks/T-1002-usage-feeds-the-meter.md) | [T-201](tasks/T-201-materialization-engine.md), [T-501](tasks/T-501-peer-store.md), [T-505](tasks/T-505-definition-staleness.md), [T-509](tasks/T-509-wake-filters.md) |
| `src/shared/env-scrub.ts` | yes | [T-205](tasks/T-205-worker-env-scrub.md), [T-1005](tasks/T-1005-worker-env-allowlist.md) | — |
| `src/shared/protocol-schemas.ts` | yes | [T-507](tasks/T-507-control-socket-protocol.md), [T-511](tasks/T-511-operator-steering.md), [T-512](tasks/T-512-sandboxed-on-the-wire.md), [T-513](tasks/T-513-reaction-methods-on-the-socket.md), [T-801](tasks/T-801-hierarchy-protocol.md), [T-1003](tasks/T-1003-worker-pid-on-the-wire.md), [T-1606](tasks/T-1606-daemon-lifecycle-verbs.md), [T-1608](tasks/T-1608-mentions-fidelity.md) | — |
| `src/shared/protocol.ts` | yes | [T-507](tasks/T-507-control-socket-protocol.md), [T-511](tasks/T-511-operator-steering.md), [T-512](tasks/T-512-sandboxed-on-the-wire.md), [T-513](tasks/T-513-reaction-methods-on-the-socket.md), [T-801](tasks/T-801-hierarchy-protocol.md), [T-1003](tasks/T-1003-worker-pid-on-the-wire.md), [T-1004](tasks/T-1004-control-socket-identity.md), [T-1606](tasks/T-1606-daemon-lifecycle-verbs.md), [T-1608](tasks/T-1608-mentions-fidelity.md) | [T-502](tasks/T-502-daemon-entry-point.md), [T-503](tasks/T-503-agent-toolbelt.md), [T-504](tasks/T-504-tui-surface.md) |
| `src/worker/launch-gate.ts` | yes | [T-203](tasks/T-203-sandbox-launch-gate.md) | [T-401](tasks/T-401-worker-lifecycle.md) |
| `src/worker/lifecycle.ts` | yes | [T-204](tasks/T-204-shared-policy-builder.md), [T-401](tasks/T-401-worker-lifecycle.md), [T-505](tasks/T-505-definition-staleness.md), [T-1003](tasks/T-1003-worker-pid-on-the-wire.md), [T-1005](tasks/T-1005-worker-env-allowlist.md), [T-1006](tasks/T-1006-in-process-worker-path.md), [T-1502](tasks/T-1502-file-upstream-issues.md), [T-1503](tasks/T-1503-drop-resolve-walk.md) | [T-005](tasks/T-005-spawn-policy-contract.md), [T-503](tasks/T-503-agent-toolbelt.md) |
| `src/worker/sandbox.ts` | yes | [T-202](tasks/T-202-sandbox-policy-compiler.md) | [T-203](tasks/T-203-sandbox-launch-gate.md) |
| `src/worker/toolbelt.ts` | yes | [T-503](tasks/T-503-agent-toolbelt.md), [T-604](tasks/T-604-reaction-toolbelt.md), [T-803](tasks/T-803-toolbelt-authoring.md), [T-1004](tasks/T-1004-control-socket-identity.md) | — |
| `tests/` | yes | [T-704](tasks/T-704-deflake-intermittent-test.md) | — |
| `tests/account-registry.test.ts` | yes | [T-404](tasks/T-404-account-registry.md) | — |
| `tests/agent-definition.test.ts` | yes | [T-101](tasks/T-101-peer-definition-parser.md) | — |
| `tests/build-hygiene.test.ts` | yes | [T-1613](tasks/T-1613-build-hygiene-test.md) | — |
| `tests/console-api.test.ts` | yes | [T-602](tasks/T-602-console-api.md), [T-1601](tasks/T-1601-console-thread-parentage.md), [T-1602](tasks/T-1602-reaction-removal-frames.md), [T-1603](tasks/T-1603-attribution-enforcement.md), [T-1604](tasks/T-1604-typed-daemon-events.md), [T-1605](tasks/T-1605-console-ops-panel.md) | — |
| `tests/console-client.test.ts` | yes | [T-603](tasks/T-603-console-client.md), [T-1101](tasks/T-1101-console-visual-system.md), [T-1102](tasks/T-1102-console-accessibility.md), [T-1104](tasks/T-1104-console-focus-stability.md), [T-1105](tasks/T-1105-unread-reconcile-on-open.md), [T-1203](tasks/T-1203-remote-console-auth.md), [T-1601](tasks/T-1601-console-thread-parentage.md), [T-1602](tasks/T-1602-reaction-removal-frames.md), [T-1604](tasks/T-1604-typed-daemon-events.md), [T-1605](tasks/T-1605-console-ops-panel.md), [T-1607](tasks/T-1607-authoring-parity.md), [T-1608](tasks/T-1608-mentions-fidelity.md), [T-1614](tasks/T-1614-test-timing-hygiene.md), [T-1615](tasks/T-1615-repaint-focus-stability.md) | — |
| `tests/consumer-install.test.ts` | yes | [T-1306](tasks/T-1306-consumer-install-smoke.md) | — |
| `tests/contracts/broker.contract.test.ts` | yes | [T-004](tasks/T-004-broker-contract.md) | — |
| `tests/contracts/discovery.contract.test.ts` | yes | [T-003](tasks/T-003-discovery-contract.md), [T-007](tasks/T-007-hermetic-child-environments.md) | — |
| `tests/contracts/spawn-policy.contract.test.ts` | yes | [T-005](tasks/T-005-spawn-policy-contract.md) | — |
| `tests/contracts/supervisor-contract.test.ts` | yes | [T-1612](tasks/T-1612-shared-supervisor-contract.md) | — |
| `tests/credential-gateway.test.ts` | yes | [T-301](tasks/T-301-credential-gateway.md), [T-302](tasks/T-302-shared-disable-recovery.md) | — |
| `tests/daemon-boot.test.ts` | yes | [T-510](tasks/T-510-broker-hosting-resolution.md) | — |
| `tests/daemon-cli.test.ts` | yes | [T-1103](tasks/T-1103-cli-management-surface.md), [T-1405](tasks/T-1405-daemon-backend-selector.md), [T-1606](tasks/T-1606-daemon-lifecycle-verbs.md), [T-1607](tasks/T-1607-authoring-parity.md), [T-1611](tasks/T-1611-cli-json-everywhere.md) | — |
| `tests/daemon-console-mount.test.ts` | yes | [T-1001](tasks/T-1001-console-mounted-at-boot.md) | — |
| `tests/daemon-hierarchy.test.ts` | yes | [T-802](tasks/T-802-daemon-hierarchy.md) | — |
| `tests/daemon-main.test.ts` | yes | [T-502](tasks/T-502-daemon-entry-point.md), [T-511](tasks/T-511-operator-steering.md), [T-512](tasks/T-512-sandboxed-on-the-wire.md), [T-513](tasks/T-513-reaction-methods-on-the-socket.md), [T-1003](tasks/T-1003-worker-pid-on-the-wire.md), [T-1606](tasks/T-1606-daemon-lifecycle-verbs.md), [T-1610](tasks/T-1610-unreact-contract.md), [T-1614](tasks/T-1614-test-timing-hygiene.md) | — |
| `tests/daemon-persistence.test.ts` | yes | [T-508](tasks/T-508-daemon-persistence.md) | — |
| `tests/dogfood.test.ts` | yes | [T-1402](tasks/T-1402-dogfood-harness.md), [T-1404](tasks/T-1404-live-session-safety-rails.md), [T-1405](tasks/T-1405-daemon-backend-selector.md) | — |
| `tests/end-to-end.test.ts` | yes | [T-405](tasks/T-405-supervisor.md) | — |
| `tests/extension.test.ts` | yes | [T-504](tasks/T-504-tui-surface.md), [T-511](tasks/T-511-operator-steering.md), [T-901](tasks/T-901-tui-tree.md), [T-902](tasks/T-902-tui-manager.md), [T-903](tasks/T-903-tui-editing.md) | — |
| `tests/fixtures/control-client.ts` | yes | [T-1004](tasks/T-1004-control-socket-identity.md) | — |
| `tests/fixtures/fake-broker.ts` | yes | [T-002](tasks/T-002-test-harness.md) | — |
| `tests/fixtures/hermetic-env.ts` | yes | [T-007](tasks/T-007-hermetic-child-environments.md), [T-205](tasks/T-205-worker-env-scrub.md) | — |
| `tests/fixtures/temp-agent-dir.ts` | yes | [T-002](tasks/T-002-test-harness.md) | [T-007](tasks/T-007-hermetic-child-environments.md) |
| `tests/gateway-client.test.ts` | yes | [T-303](tasks/T-303-client-integration.md), [T-1614](tasks/T-1614-test-timing-hygiene.md) | — |
| `tests/harness.test.ts` | yes | [T-002](tasks/T-002-test-harness.md) | — |
| `tests/materializer.test.ts` | yes | [T-201](tasks/T-201-materialization-engine.md), [T-205](tasks/T-205-worker-env-scrub.md), [T-1005](tasks/T-1005-worker-env-allowlist.md) | — |
| `tests/pack.test.ts` | yes | [T-1301](tasks/T-1301-packable-artifact.md), [T-1504](tasks/T-1504-drop-rpc-pid-patch.md) | — |
| `tests/peer-store.test.ts` | yes | [T-501](tasks/T-501-peer-store.md) | — |
| `tests/protocol.contract.test.ts` | yes | [T-507](tasks/T-507-control-socket-protocol.md), [T-511](tasks/T-511-operator-steering.md), [T-513](tasks/T-513-reaction-methods-on-the-socket.md), [T-801](tasks/T-801-hierarchy-protocol.md), [T-1606](tasks/T-1606-daemon-lifecycle-verbs.md), [T-1608](tasks/T-1608-mentions-fidelity.md) | — |
| `tests/remote-exposure.test.ts` | yes | [T-1201](tasks/T-1201-exposure-policy.md), [T-1202](tasks/T-1202-tls-termination.md), [T-1204](tasks/T-1204-authoritative-hierarchy.md), [T-1206](tasks/T-1206-authenticated-connection-audit.md), [T-1616](tasks/T-1616-control-cap-json-rpc.md) | — |
| `tests/rooms.test.ts` | yes | [T-402](tasks/T-402-room-store.md), [T-601](tasks/T-601-conversation-model.md) | — |
| `tests/sandbox-gate.test.ts` | yes | [T-203](tasks/T-203-sandbox-launch-gate.md) | — |
| `tests/sandbox.test.ts` | yes | [T-202](tasks/T-202-sandbox-policy-compiler.md) | — |
| `tests/scaffold.test.ts` | yes | [T-001](tasks/T-001-package-scaffold.md) | — |
| `tests/scheduler.test.ts` | yes | [T-403](tasks/T-403-scheduler.md) | — |
| `tests/seatbelt-wiring.test.ts` | yes | [T-204](tasks/T-204-shared-policy-builder.md) | — |
| `tests/skills.test.ts` | yes | [T-804](tasks/T-804-authoring-skills.md) | — |
| `tests/socket-identity.test.ts` | yes | [T-1004](tasks/T-1004-control-socket-identity.md), [T-1204](tasks/T-1204-authoritative-hierarchy.md), [T-1603](tasks/T-1603-attribution-enforcement.md), [T-1609](tasks/T-1609-identity-negatives.md) | — |
| `tests/supervisor.test.ts` | yes | [T-405](tasks/T-405-supervisor.md), [T-505](tasks/T-505-definition-staleness.md), [T-506](tasks/T-506-metered-budget-wiring.md), [T-509](tasks/T-509-wake-filters.md) | — |
| `tests/toolbelt.test.ts` | yes | [T-503](tasks/T-503-agent-toolbelt.md), [T-513](tasks/T-513-reaction-methods-on-the-socket.md), [T-604](tasks/T-604-reaction-toolbelt.md), [T-803](tasks/T-803-toolbelt-authoring.md), [T-1614](tasks/T-1614-test-timing-hygiene.md) | — |
| `tests/usage-meter.test.ts` | yes | [T-1002](tasks/T-1002-usage-feeds-the-meter.md) | — |
| `tests/worker-inprocess.test.ts` | yes | [T-1006](tasks/T-1006-in-process-worker-path.md), [T-1612](tasks/T-1612-shared-supervisor-contract.md) | — |
| `tests/worker-lifecycle.test.ts` | yes | [T-401](tasks/T-401-worker-lifecycle.md), [T-1003](tasks/T-1003-worker-pid-on-the-wire.md), [T-1612](tasks/T-1612-shared-supervisor-contract.md) | — |
| `tsconfig.json` | yes | [T-001](tasks/T-001-package-scaffold.md) | — |
