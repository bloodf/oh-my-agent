/**
 * Purpose: The daemon's durable state (§6) — which peers are registered, what
 * they did while nobody was watching, and which schedules are armed. Agents,
 * runs, and schedules live in memory inside the supervisor, registry, and
 * scheduler; this module is the write-through behind them, so a restart resumes
 * instead of starting empty and the startup sweep has a registry that outlived
 * the crash to compare worker directories against.
 *
 * Public API: `DaemonDb.open(path)`, plus `upsertAgent`, `markAgentStatus`,
 * `listAgents`, `startRun`, `finishRun`, `interruptOpenRuns`, `listRuns`,
 * `upsertSchedule`, `setScheduleEnabled`, `setScheduleNextFire`,
 * `listSchedules`, and `close`.
 *
 * Upstream deps: `bun:sqlite` and `node:fs/promises` — the same two the room
 * store uses, because a second persistence style in one process is a second
 * thing to reason about at 3am.
 *
 * Downstream consumers: `./main`, which owns composition and is the only writer.
 * Reads at request time go to live daemon state, never here: this is the
 * write-through, not a second source of truth.
 *
 * Failure modes: a run for an unknown agent is rejected by the foreign key
 * rather than accumulating orphan history. `finishRun` on an already-closed run
 * is ignored, so a turn released after shutdown judged it `interrupted` cannot
 * rewrite that verdict. `close()` is idempotent, because shutdown reaches it
 * from both the normal path and the failed-boot unwind.
 *
 * Performance: synchronous SQLite with WAL, one prepared statement per
 * operation, and indexes on the two columns the daemon actually filters by —
 * a run's agent and an open run's null `ended_at`.
 */

import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/** What the daemon last knew about a peer's worker. */
export type AgentStatus = "running" | "parked" | "stopped";

/**
 * How a turn came to be. `room` is a message somebody posted; a schedule
 * carries its own id, because "the 9am sweep fired" and "a human asked" are the
 * two different reasons this system does anything unattended and must not read
 * alike in the history.
 */
export type RunTrigger = "room" | `schedule:${string}`;

/**
 * How a turn ended. `interrupted` is what shutdown writes over a turn still in
 * flight: an open row claims a turn is still running long after the process is
 * gone, which is worse than no record at all.
 */
export type RunOutcome = "ok" | "error" | "interrupted";

export interface AgentRow {
	name: string;
	/** Definition this peer was registered from, for staleness checks. */
	definitionPath: string;
	status: AgentStatus;
	/** `null` for a worker with no OS process of its own. */
	workerPid: number | null;
	/** Project directory the worker edits. Not its synthetic root. */
	cwd: string;
	startedAt: number;
}

export interface RunRow {
	id: number;
	agent: string;
	trigger: RunTrigger;
	startedAt: number;
	/** `null` while the turn is still in flight. */
	endedAt: number | null;
	outcome: RunOutcome | null;
	costUsd: number | null;
	/** Pointer into OMP's own transcript, never a copy of it (§10). */
	transcriptRef: string | null;
}

export interface ScheduleRow {
	id: string;
	/** `null` for an automation, which fires on an event rather than a clock. */
	cron: string | null;
	action: string;
	/** Free-form JSON the action needs; `null` when it needs none. */
	payload: string | null;
	nextFireAt: number | null;
	enabled: boolean;
}

export interface StartRunInput {
	agent: string;
	trigger: RunTrigger;
	startedAt: number;
}

export interface FinishRunInput {
	id: number;
	outcome: RunOutcome;
	endedAt: number;
	costUsd?: number;
	transcriptRef?: string;
}

interface RawAgentRow {
	name: string;
	definition_path: string;
	status: string;
	worker_pid: number | null;
	cwd: string;
	started_at: number;
}

interface RawRunRow {
	id: number;
	agent: string;
	trigger: string;
	started_at: number;
	ended_at: number | null;
	outcome: string | null;
	cost_usd: number | null;
	transcript_ref: string | null;
}

interface RawScheduleRow {
	id: string;
	cron: string | null;
	action: string;
	payload: string | null;
	next_fire_at: number | null;
	enabled: number;
}

export class DaemonDb {
	private closed = false;

	private constructor(
		readonly path: string,
		private db: Database,
	) {}

	/**
	 * Open or create the database. Idempotent: every statement is `IF NOT
	 * EXISTS`, so booting against a database an earlier daemon wrote adds
	 * nothing and loses nothing.
	 */
	static async open(path: string): Promise<DaemonDb> {
		const dir = dirname(path);
		if (dir) await mkdir(dir, { recursive: true });
		const db = new Database(path);
		db.exec("PRAGMA foreign_keys = ON");
		db.exec("PRAGMA journal_mode = WAL");
		db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        name            TEXT PRIMARY KEY,
        definition_path TEXT NOT NULL,
        status          TEXT NOT NULL CHECK (status IN ('running', 'parked', 'stopped')),
        worker_pid      INTEGER,
        cwd             TEXT NOT NULL,
        started_at      INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        agent          TEXT NOT NULL,
        trigger        TEXT NOT NULL,
        started_at     INTEGER NOT NULL,
        ended_at       INTEGER,
        outcome        TEXT CHECK (outcome IN ('ok', 'error', 'interrupted')),
        cost_usd       REAL,
        transcript_ref TEXT,
        FOREIGN KEY (agent) REFERENCES agents(name)
      );
      CREATE INDEX IF NOT EXISTS runs_agent_idx ON runs(agent);
      CREATE INDEX IF NOT EXISTS runs_open_idx ON runs(ended_at) WHERE ended_at IS NULL;
      CREATE TABLE IF NOT EXISTS schedules (
        id           TEXT PRIMARY KEY,
        cron         TEXT,
        action       TEXT NOT NULL,
        payload      TEXT,
        next_fire_at INTEGER,
        enabled      INTEGER NOT NULL DEFAULT 1
      );
    `);
		return new DaemonDb(path, db);
	}

	// ── Agents ────────────────────────────────────────────────────────────────

	/**
	 * Record a registered peer. Keyed by name, so re-registering the same peer
	 * on a later boot updates its row instead of growing a second one per
	 * restart.
	 */
	upsertAgent(agent: AgentRow): void {
		this.db
			.prepare(
				`INSERT INTO agents (name, definition_path, status, worker_pid, cwd, started_at)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT (name) DO UPDATE SET
				   definition_path = excluded.definition_path,
				   status          = excluded.status,
				   worker_pid      = excluded.worker_pid,
				   cwd             = excluded.cwd,
				   started_at      = excluded.started_at`,
			)
			.run(
				agent.name,
				agent.definitionPath,
				agent.status,
				agent.workerPid,
				agent.cwd,
				agent.startedAt,
			);
	}

	/**
	 * Move a known peer's status without touching the rest of its row. A peer
	 * whose row is gone is not recreated here: only registration knows the
	 * definition path and cwd a row needs.
	 */
	markAgentStatus(name: string, status: AgentStatus): void {
		this.db
			.prepare("UPDATE agents SET status = ? WHERE name = ?")
			.run(status, name);
	}

	listAgents(): AgentRow[] {
		const rows = this.db
			.prepare(
				"SELECT name, definition_path, status, worker_pid, cwd, started_at FROM agents ORDER BY name",
			)
			.all() as RawAgentRow[];
		return rows.map((row) => ({
			name: row.name,
			definitionPath: row.definition_path,
			status: row.status as AgentStatus,
			workerPid: row.worker_pid,
			cwd: row.cwd,
			startedAt: row.started_at,
		}));
	}

	// ── Runs ──────────────────────────────────────────────────────────────────

	/** Open a run row for a turn about to be delivered. Returns its id. */
	startRun(input: StartRunInput): number {
		const result = this.db
			.prepare("INSERT INTO runs (agent, trigger, started_at) VALUES (?, ?, ?)")
			.run(input.agent, input.trigger, input.startedAt);
		return Number(result.lastInsertRowid);
	}

	/**
	 * Close a run with its outcome. Ignored when the run is already closed: a
	 * turn released after shutdown recorded it as `interrupted` would otherwise
	 * rewrite a verdict the daemon that made it is no longer around to defend.
	 */
	finishRun(input: FinishRunInput): void {
		this.db
			.prepare(
				`UPDATE runs
				 SET ended_at = ?, outcome = ?, cost_usd = ?, transcript_ref = ?
				 WHERE id = ? AND ended_at IS NULL`,
			)
			.run(
				input.endedAt,
				input.outcome,
				input.costUsd ?? null,
				input.transcriptRef ?? null,
				input.id,
			);
	}

	/**
	 * Close every still-open run as interrupted. Called during shutdown, where
	 * the turns in flight belong to a process that is about to stop existing.
	 * Returns how many rows it closed.
	 */
	interruptOpenRuns(endedAt: number): number {
		const result = this.db
			.prepare(
				"UPDATE runs SET ended_at = ?, outcome = 'interrupted' WHERE ended_at IS NULL",
			)
			.run(endedAt);
		return Number(result.changes);
	}

	listRuns(agent?: string): RunRow[] {
		const rows = (
			agent === undefined
				? this.db
						.prepare(
							"SELECT id, agent, trigger, started_at, ended_at, outcome, cost_usd, transcript_ref FROM runs ORDER BY id",
						)
						.all()
				: this.db
						.prepare(
							"SELECT id, agent, trigger, started_at, ended_at, outcome, cost_usd, transcript_ref FROM runs WHERE agent = ? ORDER BY id",
						)
						.all(agent)
		) as RawRunRow[];
		return rows.map((row) => ({
			id: row.id,
			agent: row.agent,
			trigger: row.trigger as RunTrigger,
			startedAt: row.started_at,
			endedAt: row.ended_at,
			outcome: row.outcome as RunOutcome | null,
			costUsd: row.cost_usd,
			transcriptRef: row.transcript_ref,
		}));
	}

	// ── Schedules ─────────────────────────────────────────────────────────────

	/**
	 * Record an armed schedule. `enabled` is preserved on conflict: the
	 * definition on disk still declares a schedule an operator disarmed, so a
	 * boot that re-armed it from the file would quietly undo that decision.
	 */
	upsertSchedule(schedule: ScheduleRow): void {
		this.db
			.prepare(
				`INSERT INTO schedules (id, cron, action, payload, next_fire_at, enabled)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT (id) DO UPDATE SET
				   cron         = excluded.cron,
				   action       = excluded.action,
				   payload      = excluded.payload,
				   next_fire_at = excluded.next_fire_at`,
			)
			.run(
				schedule.id,
				schedule.cron,
				schedule.action,
				schedule.payload,
				schedule.nextFireAt,
				schedule.enabled ? 1 : 0,
			);
	}

	/** Operator decision: the one piece of schedule state no file carries. */
	setScheduleEnabled(id: string, enabled: boolean): void {
		this.db
			.prepare("UPDATE schedules SET enabled = ? WHERE id = ?")
			.run(enabled ? 1 : 0, id);
	}

	setScheduleNextFire(id: string, nextFireAt: number | null): void {
		this.db
			.prepare("UPDATE schedules SET next_fire_at = ? WHERE id = ?")
			.run(nextFireAt, id);
	}

	listSchedules(): ScheduleRow[] {
		const rows = this.db
			.prepare(
				"SELECT id, cron, action, payload, next_fire_at, enabled FROM schedules ORDER BY id",
			)
			.all() as RawScheduleRow[];
		return rows.map((row) => ({
			id: row.id,
			cron: row.cron,
			action: row.action,
			payload: row.payload,
			nextFireAt: row.next_fire_at,
			enabled: row.enabled !== 0,
		}));
	}

	/** Idempotent: shutdown reaches this from both the normal and unwind paths. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.db.close();
	}
}
