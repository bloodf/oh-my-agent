/**
 * Purpose: Persist editable plans attached to existing collaboration rooms.
 *
 * Public API: `RoomPlans.open()`, `list()`, `create()`, `update()`, `close()`;
 *             `RoomPlan`, `PlanStatus`, `CreatePlanInput`, `UpdatePlanInput`,
 *             `RoomPlanError`, and `RoomPlanErrorCode`.
 *
 * Upstream deps: `bun:sqlite`, `node:crypto`, `node:fs/promises`, and the
 *                `rooms` table owned by `RoomStore` in the same database.
 *
 * Downstream consumers: daemon socket and HTTP composition (wired elsewhere).
 *
 * Failure modes: throws `RoomPlanError` with a stable code for invalid input,
 *                unknown rooms/plans, or stale revisions. Mutations are atomic;
 *                callers may retry an update only after reading its new revision.
 *
 * Performance: synchronous SQLite with WAL; room lists use a room/time index and
 *              updates use one immediate transaction to prevent lost writes.
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { PlanStatus, RoomPlan } from "../shared/protocol";

export interface CreatePlanInput {
	room: string;
	title: string;
	body: string;
	author: string;
}

export interface UpdatePlanInput {
	id: string;
	room: string;
	title?: string;
	body?: string;
	status?: PlanStatus;
	expectedRevision: number;
	author: string;
}

export type RoomPlanErrorCode =
	| "INVALID_PLAN"
	| "ROOM_NOT_FOUND"
	| "PLAN_NOT_FOUND"
	| "PLAN_REVISION_CONFLICT";

export class RoomPlanError extends Error {
	constructor(readonly code: RoomPlanErrorCode) {
		super(code);
		this.name = "RoomPlanError";
	}
}

interface PlanRow {
	id: string;
	room: string;
	title: string;
	body: string;
	status: string;
	revision: number;
	author: string;
	updated_by: string;
	created_at: number;
	updated_at: number;
}

const MAX_ROOM_LENGTH = 256;
const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 1_048_576;
const MAX_AUTHOR_LENGTH = 256;
const STATUS_VALUES: Record<PlanStatus, true> = {
	draft: true,
	active: true,
	completed: true,
};

function requiredString(value: unknown, maxLength: number): string {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.length > maxLength
	) {
		throw new RoomPlanError("INVALID_PLAN");
	}
	return value;
}

function bodyString(value: unknown): string {
	if (typeof value !== "string" || value.length > MAX_BODY_LENGTH) {
		throw new RoomPlanError("INVALID_PLAN");
	}
	return value;
}

function statusValue(value: unknown): PlanStatus {
	if (typeof value !== "string" || !Object.hasOwn(STATUS_VALUES, value)) {
		throw new RoomPlanError("INVALID_PLAN");
	}
	return value as PlanStatus;
}

export class RoomPlans {
	private closed = false;

	private constructor(
		readonly path: string,
		private db: Database,
	) {}

	static async open(path: string): Promise<RoomPlans> {
		const dir = dirname(path);
		if (dir) await mkdir(dir, { recursive: true });
		const db = new Database(path);
		try {
			db.exec("PRAGMA foreign_keys = ON");
			db.exec("PRAGMA journal_mode = WAL");
			const rooms = db
				.prepare(
					"SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'rooms'",
				)
				.get() as { present: number } | undefined;
			if (!rooms) throw new RoomPlanError("ROOM_NOT_FOUND");
			db.exec(`
				CREATE TABLE IF NOT EXISTS room_plans (
					id         TEXT PRIMARY KEY,
					room       TEXT NOT NULL,
					title      TEXT NOT NULL CHECK (length(trim(title)) > 0 AND length(title) <= ${MAX_TITLE_LENGTH}),
					body       TEXT NOT NULL CHECK (length(body) <= ${MAX_BODY_LENGTH}),
					status     TEXT NOT NULL CHECK (status IN ('draft', 'active', 'completed')),
					revision   INTEGER NOT NULL CHECK (revision >= 1),
					author     TEXT NOT NULL CHECK (length(trim(author)) > 0 AND length(author) <= ${MAX_AUTHOR_LENGTH}),
					updated_by TEXT NOT NULL CHECK (length(trim(updated_by)) > 0 AND length(updated_by) <= ${MAX_AUTHOR_LENGTH}),
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					FOREIGN KEY (room) REFERENCES rooms(id)
				);
				CREATE INDEX IF NOT EXISTS room_plans_room_updated_idx
					ON room_plans(room, updated_at DESC, id);
			`);
			return new RoomPlans(path, db);
		} catch (error) {
			db.close();
			throw error;
		}
	}

	list(room: string): RoomPlan[] {
		const roomId = requiredString(room, MAX_ROOM_LENGTH);
		this.requireRoom(roomId);
		const rows = this.db
			.prepare(
				`SELECT id, room, title, body, status, revision, author, updated_by, created_at, updated_at
				 FROM room_plans WHERE room = ? ORDER BY updated_at DESC, id ASC`,
			)
			.all(roomId) as PlanRow[];
		return rows.map(mapPlan);
	}

	create(input: CreatePlanInput): RoomPlan {
		const room = requiredString(input?.room, MAX_ROOM_LENGTH);
		const title = requiredString(input?.title, MAX_TITLE_LENGTH);
		const body = bodyString(input?.body);
		const author = requiredString(input?.author, MAX_AUTHOR_LENGTH);
		this.requireRoom(room);

		const now = Date.now();
		const plan: RoomPlan = {
			id: randomUUID(),
			room,
			title,
			body,
			status: "draft",
			revision: 1,
			author,
			updatedBy: author,
			createdAt: now,
			updatedAt: now,
		};
		this.db
			.prepare(
				`INSERT INTO room_plans
				 (id, room, title, body, status, revision, author, updated_by, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				plan.id,
				plan.room,
				plan.title,
				plan.body,
				plan.status,
				plan.revision,
				plan.author,
				plan.updatedBy,
				plan.createdAt,
				plan.updatedAt,
			);
		return plan;
	}

	update(input: UpdatePlanInput): RoomPlan {
		const id = requiredString(input?.id, 128);
		const room = requiredString(input?.room, MAX_ROOM_LENGTH);
		const author = requiredString(input?.author, MAX_AUTHOR_LENGTH);
		if (
			!Number.isSafeInteger(input?.expectedRevision) ||
			input.expectedRevision < 1
		) {
			throw new RoomPlanError("INVALID_PLAN");
		}
		if (
			input.title === undefined &&
			input.body === undefined &&
			input.status === undefined
		) {
			throw new RoomPlanError("INVALID_PLAN");
		}
		const title =
			input.title === undefined
				? undefined
				: requiredString(input.title, MAX_TITLE_LENGTH);
		const body = input.body === undefined ? undefined : bodyString(input.body);
		const status =
			input.status === undefined ? undefined : statusValue(input.status);

		const perform = this.db.transaction((): RoomPlan => {
			this.requireRoom(room);
			const current = this.db
				.prepare(
					`SELECT id, room, title, body, status, revision, author, updated_by, created_at, updated_at
					 FROM room_plans WHERE id = ? AND room = ?`,
				)
				.get(id, room) as PlanRow | undefined;
			if (!current) throw new RoomPlanError("PLAN_NOT_FOUND");
			if (current.revision !== input.expectedRevision) {
				throw new RoomPlanError("PLAN_REVISION_CONFLICT");
			}

			const updatedAt = Date.now();
			const result = this.db
				.prepare(
					`UPDATE room_plans SET title = ?, body = ?, status = ?, revision = revision + 1,
					 updated_by = ?, updated_at = ? WHERE id = ? AND room = ? AND revision = ?`,
				)
				.run(
					title ?? current.title,
					body ?? current.body,
					status ?? current.status,
					author,
					updatedAt,
					id,
					room,
					input.expectedRevision,
				);
			if (result.changes !== 1) {
				throw new RoomPlanError("PLAN_REVISION_CONFLICT");
			}
			const updated = this.db
				.prepare(
					`SELECT id, room, title, body, status, revision, author, updated_by, created_at, updated_at
					 FROM room_plans WHERE id = ? AND room = ?`,
				)
				.get(id, room) as PlanRow;
			return mapPlan(updated);
		});
		return perform.immediate();
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.db.close();
	}

	private requireRoom(room: string): void {
		const found = this.db.prepare("SELECT 1 FROM rooms WHERE id = ?").get(room);
		if (!found) throw new RoomPlanError("ROOM_NOT_FOUND");
	}
}

function mapPlan(row: PlanRow): RoomPlan {
	return {
		id: row.id,
		room: row.room,
		title: row.title,
		body: row.body,
		status: row.status as PlanStatus,
		revision: row.revision,
		author: row.author,
		updatedBy: row.updated_by,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}
