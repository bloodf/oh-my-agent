/**
 * Purpose: `/setup` — the checklist from `../shared/setup-report`, plus the
 * two fixes the TUI can apply on the spot: put the crew on a model the
 * daemon can route to, and start the crew peers that are stopped.
 *
 * Public API: `setupCommand(client, io)`.
 *
 * Upstream deps: `./commands` (client, IO seam, guard), the shared report.
 *
 * Downstream consumers: `./index` registers it; the `oh-my-agent-setup`
 * skill tells the OMP assistant to run it and read the lines.
 *
 * Failure modes: every daemon refusal is a notice, never a throw into the
 * TUI. A fix is offered only when its precondition holds and the operator
 * picks it; Esc leaves everything as it was.
 */

import type {
	AgentSpawnResult,
	DefinitionUpdateResult,
	ModelsListResult,
} from "../shared/protocol";
import {
	CREW,
	collectSetupReport,
	type SetupReport,
} from "../shared/setup-report";
import { PACKAGE_VERSION } from "../shared/version";
import type { DaemonClient, ExtensionIO } from "./commands";
import { guard } from "./commands";

/** Run the checklist, show it, then offer the fixes that apply. */
export async function setupCommand(
	client: DaemonClient,
	io: ExtensionIO,
): Promise<void> {
	await guard(io, async () => {
		const report = await collectSetupReport(client, PACKAGE_VERSION);
		io.notify(["oh-my-agent setup", ...report.lines].join("\n"));
		if (report.daemon === undefined) return;

		if (report.defaultUnroutable && report.models !== undefined) {
			await pickCrewModel(client, io, report.models, report);
		}
		if (report.stoppedCrew.length > 0) {
			await startStoppedCrew(client, io, report);
		}
	});
}

/**
 * Point every crew peer that declares no model at one the daemon can route
 * to. Only peers on the default are touched: an operator's explicit choice
 * is theirs.
 */
async function pickCrewModel(
	client: DaemonClient,
	io: ExtensionIO,
	models: ModelsListResult,
	report: SetupReport,
): Promise<void> {
	if (models.models.length === 0) return;
	const choice = await io.select(
		"Model for the crew (Esc to leave the OMP default)",
		models.models.map((m) => `${m.provider}/${m.id}`),
	);
	if (choice === undefined) return;
	const onDefault = (report.daemon?.agents ?? []).filter(
		(agent) =>
			(CREW as readonly string[]).includes(agent.name) &&
			(agent.model === undefined || agent.model === models.default),
	);
	const changed: string[] = [];
	for (const agent of onDefault) {
		await client.call<DefinitionUpdateResult>("definition_update", {
			name: agent.name,
			changes: { model: [choice] },
		});
		changed.push(agent.name);
	}
	io.notify(
		changed.length === 0
			? "every crew peer already has its own model; nothing changed"
			: `set ${choice} on ${changed.join(", ")}; running peers pick it up on their next turn`,
	);
}

/** Start the crew peers that are stopped, one confirmation for all. */
async function startStoppedCrew(
	client: DaemonClient,
	io: ExtensionIO,
	report: SetupReport,
): Promise<void> {
	const names = report.stoppedCrew.map((agent) => agent.name);
	const yes = await io.confirm(
		"Start the stopped crew?",
		`Spawn ${names.join(", ")} now.`,
	);
	if (!yes) return;
	const started: string[] = [];
	const failed: string[] = [];
	for (const name of names) {
		try {
			const result = await client.call<AgentSpawnResult>("agent_spawn", {
				name,
			});
			started.push(`${result.name} (${result.state})`);
		} catch (error) {
			failed.push(
				`${name}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	io.notify(
		[
			started.length > 0 ? `started ${started.join(", ")}` : "",
			failed.length > 0 ? `could not start ${failed.join("; ")}` : "",
		]
			.filter(Boolean)
			.join("\n"),
	);
}
