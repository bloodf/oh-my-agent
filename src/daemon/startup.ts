/** CLI startup grammar shared by the executable and dispatcher; no SDK imports. */
export class UsageError extends Error {}

export const USAGE = `Usage: omp-agent [--json] <verb> [args]

Flags come before the verb; anything after \`--\` is payload, so a literal
--json inside a message is never eaten. Errors are always plain text,
never JSON.

Verbs:
  status
  audit
  agents
  agent create <name> <file|->
  agent show <name>
  agent edit <name> <file|->
  spawn <name> [--parent <parent>]
  daemon [--worker-backend rpc|in-process]
  kill <name> [--keep-children]
  rooms
  rooms read <room>
  rooms post <room> <text...>
  schedule
  schedule <id> on|off
  logs <name|daemon> [n]
  inject <name> <text...>
  bump <account> <usd>
  console
  daemon stop
  daemon restart
`;

export type WorkerBackend = "rpc" | "in-process";
export interface DaemonStartOptions {
	json: boolean;
	workerBackend: WorkerBackend;
}

/** Parse daemon starts only; the dispatcher owns other verbs. */
export function parseDaemonStartArgs(
	argv: readonly string[],
): DaemonStartOptions | undefined {
	if (argv.length === 0) return { json: false, workerBackend: "rpc" };
	const json = argv[0] === "--json";
	const args = json ? argv.slice(1) : argv;
	if (args[0] !== "daemon" || args[1] === "stop" || args[1] === "restart")
		return undefined;
	if (args.length === 1) return { json, workerBackend: "rpc" };
	if (args.length !== 3 || args[1] !== "--worker-backend")
		throw new UsageError();
	const workerBackend = args[2];
	if (workerBackend !== "rpc" && workerBackend !== "in-process") {
		throw new UsageError(
			`unknown worker backend ${JSON.stringify(workerBackend)}`,
		);
	}
	return { json, workerBackend };
}
