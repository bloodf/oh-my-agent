import { Action } from "@/components/Action";
import { Live } from "@/components/Live";
import { daemonGet } from "@/lib/daemon";
import type { AgentInfo, Schedule } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
	const [{ agents }, { schedules }] = await Promise.all([
		daemonGet<{ agents: AgentInfo[] }>("/api/agents"),
		daemonGet<{ schedules: Schedule[] }>("/api/schedules").catch(() => ({
			schedules: [] as Schedule[],
		})),
	]);
	return (
		<>
			<Live />
			<header className="border-b border-zinc-800 px-4 py-2">
				<h1 className="text-sm font-semibold">Agents</h1>
			</header>
			<section className="min-h-0 flex-1 overflow-y-auto p-4">
				<ul id="agents" className="space-y-1.5">
					{agents.map((agent) => (
						<li
							key={agent.name}
							className="agent flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 px-3 py-2"
							data-name={agent.name}
						>
							<div className="min-w-0 flex-1">
								<div className="text-sm font-medium">{agent.name}</div>
								<div className="text-xs text-zinc-500">
									{agent.state}
									{agent.model ? ` · ${agent.model}` : ""}
									{agent.rooms?.length ? ` · ${agent.rooms.join(", ")}` : ""}
								</div>
								{agent.lastError && (
									<div className="text-xs text-red-400">{agent.lastError}</div>
								)}
							</div>
							{agent.state === "stopped" ? (
								<Action
									path={`/api/agents/${encodeURIComponent(agent.name)}/start`}
									body={{}}
									label="Start"
								/>
							) : (
								<Action
									path={`/api/agents/${encodeURIComponent(agent.name)}/kill`}
									body={{}}
									label="Stop"
									className="border-red-900 text-red-300"
								/>
							)}
						</li>
					))}
				</ul>
				<h2 className="mt-6 mb-2 text-sm font-semibold">Schedules</h2>
				<ul id="schedules" className="space-y-1.5">
					{schedules.length === 0 && (
						<li className="text-xs text-zinc-500">No schedules.</li>
					)}
					{schedules.map((schedule) => (
						<li
							key={schedule.id}
							className="schedule flex items-center gap-3 rounded-lg border border-zinc-800 px-3 py-2"
							data-id={schedule.id}
							data-enabled={String(schedule.enabled)}
						>
							<div className="min-w-0 flex-1">
								<div className="text-sm">
									<span className="font-medium">{schedule.agent}</span>{" "}
									<span className="font-mono text-xs text-zinc-500">
										{schedule.id.endsWith(":heartbeat")
											? "heartbeat"
											: (schedule.cron ?? "automation")}
									</span>
								</div>
								<div className="truncate text-xs text-zinc-500">
									{schedule.action}
								</div>
							</div>
							<Action
								path={`/api/schedules/${encodeURIComponent(schedule.id)}`}
								method="PATCH"
								body={{ enabled: !schedule.enabled }}
								label={schedule.enabled ? "Pause" : "Resume"}
							/>
						</li>
					))}
				</ul>
			</section>
		</>
	);
}
