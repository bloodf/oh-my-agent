/**
 * Purpose: The setup checklist behind `/setup` and `omp-agent setup` — what
 * a fresh install needs before the crew can work, checked against the live
 * daemon and reported as lines an operator (or the OMP assistant reading
 * them) can act on.
 *
 * Public API: `collectSetupReport(client)`, `SetupReport`, `CREW`.
 *
 * Upstream deps: `./protocol` for the wire shapes. Pure over a `call`
 * function, so the TUI and the CLI share one checklist.
 *
 * Downstream consumers: `../extension/setup` (adds the interactive fixes),
 * `../daemon/cli` (prints it).
 *
 * Failure modes: a daemon that cannot be reached ends the report at the
 * first line — every other check needs it — with the restart command.
 */
import type {
	AgentStatus,
	MethodName,
	ModelsListResult,
	RoomsListResult,
	StatusResult,
} from "./protocol";

/** The peers a fresh install seeds; setup expects to find them. */
export const CREW = [
	"mate",
	"staff-pm",
	"staff-backend",
	"staff-frontend",
	"staff-qa",
] as const;

export interface SetupClient {
	call<T>(method: MethodName, params?: unknown): Promise<T>;
}

export interface SetupReport {
	/** Human lines, each starting with a ✓ or ✗ mark. */
	lines: string[];
	/** Every check passed; nothing left to fix. */
	ready: boolean;
	daemon?: StatusResult;
	models?: ModelsListResult;
	/** Crew peers that are not running, with the reason when the daemon has one. */
	stoppedCrew: AgentStatus[];
	/** Crew peers missing from the daemon entirely: not seeded, or deleted. */
	missingCrew: string[];
	/** The default model is set but the daemon cannot route to it. */
	defaultUnroutable: boolean;
}

const ok = (text: string) => `✓ ${text}`;
const bad = (text: string) => `✗ ${text}`;

/** Run every check and describe what was found and what to do next. */
export async function collectSetupReport(
	client: SetupClient,
	pluginVersion?: string,
): Promise<SetupReport> {
	const lines: string[] = [];
	const report: SetupReport = {
		lines,
		ready: false,
		stoppedCrew: [],
		missingCrew: [],
		defaultUnroutable: false,
	};

	let daemon: StatusResult;
	try {
		daemon = await client.call<StatusResult>("status", {});
	} catch (error) {
		lines.push(
			bad(
				`daemon: ${error instanceof Error ? error.message : String(error)} — start it with /cli daemon restart`,
			),
		);
		return report;
	}
	report.daemon = daemon;
	const drift =
		pluginVersion !== undefined &&
		daemon.version !== undefined &&
		daemon.version !== pluginVersion;
	lines.push(
		drift
			? bad(
					`daemon ${daemon.version} is older than this plugin ${pluginVersion} — /cli daemon restart`,
				)
			: ok(`daemon ${daemon.version ?? ""} up, ${daemon.agents.length} agents`),
	);

	let models: ModelsListResult | undefined;
	try {
		models = await client.call<ModelsListResult>("models_list", {});
		report.models = models;
	} catch {
		// An older daemon: the crew still runs on whatever it resolved.
	}
	if (models !== undefined) {
		if (models.models.length === 0) {
			lines.push(
				bad(
					"no model the daemon can route to — log into a provider in OMP (/login) or add one to ~/.omp/agent/models.yml, then /cli daemon restart",
				),
			);
		} else {
			lines.push(ok(`${models.models.length} models routable`));
		}
		if (models.default === undefined) {
			lines.push(
				bad(
					"no OMP default model — pick one with /model, then /cli daemon restart",
				),
			);
		} else if (models.defaultRoutable === false) {
			report.defaultUnroutable = true;
			lines.push(
				bad(
					`OMP default ${models.default} is not routable by the daemon — pick a listed model for the crew below, or add the provider to ~/.omp/agent/models.yml`,
				),
			);
		} else {
			lines.push(ok(`default model ${models.default}`));
		}
	}

	const byName = new Map(daemon.agents.map((agent) => [agent.name, agent]));
	for (const name of CREW) {
		const agent = byName.get(name);
		if (agent === undefined) report.missingCrew.push(name);
		else if (agent.state === "stopped") report.stoppedCrew.push(agent);
	}
	const running = CREW.filter((n) => byName.get(n)?.state === "running");
	if (running.length === CREW.length) {
		lines.push(ok(`crew running: ${CREW.join(", ")}`));
	} else {
		if (running.length > 0) lines.push(ok(`running: ${running.join(", ")}`));
		for (const agent of report.stoppedCrew) {
			lines.push(
				bad(
					`${agent.name} stopped${agent.lastError ? `: ${agent.lastError}` : ""} — /spawn ${agent.name}`,
				),
			);
		}
		if (report.missingCrew.length > 0) {
			lines.push(
				bad(
					`missing: ${report.missingCrew.join(", ")} — seeded on the daemon's first boot; /cli daemon restart, or recreate with /preset`,
				),
			);
		}
	}

	try {
		const rooms = await client.call<RoomsListResult>("rooms_list", {});
		const ids = new Set(rooms.rooms.map((room) => room.id));
		const wanted = ["#bridge", "#team"];
		const absent = wanted.filter((id) => !ids.has(id));
		lines.push(
			absent.length === 0
				? ok(`rooms ${wanted.join(" and ")} exist`)
				: bad(
						`rooms missing: ${absent.join(", ")} — /rooms create ${absent[0]}`,
					),
		);
	} catch {
		// Not fatal; the crew's rooms are created when they start.
	}

	report.ready = lines.every((line) => line.startsWith("✓"));
	lines.push(
		report.ready
			? ok(
					"ready — talk to the mate: /rooms post #bridge @mate <what you want>",
				)
			: "next: fix the ✗ lines above, then run /setup again",
	);
	return report;
}
