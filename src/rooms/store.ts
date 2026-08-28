/**
 * @oh-my-agent/rooms - bun:sqlite RoomStore
 *
 * Purpose:        Persistent room, threaded-message, reaction, and subscription store for multi-agent collaboration.
 * Public API:      RoomStore.open(), createRoom(), post(), parseMentions(), listMessages(), react(), unreact(), subscribe(), markRead(), unreadCount(), pendingForAgent(), enqueueMention(), pendingMentionsForAgent(), acknowledgeMentions(), close();
 *                  Room { id, kind }, RoomKind; MessageReaction { actor, emoji };
 *                  RoomMessage { id, room, author, body, mentions, createdAt, parentId, threadRootId, replyCount, reactions };
 *                  CreateRoomInput { id, kind }; PostMessageInput { room, author, body, createdAt?, parentId? };
 *                  PendingRoom { room, messages }.
 * Upstream deps:   bun:sqlite (Database), node:fs/promises (mkdir)
 * Downstream consumers: extension/index.ts, any agent code importing this module
 * Failure modes:   INVALID_ROOM, INVALID_MESSAGE, INVALID_REACTION, ROOM_NOT_FOUND, MESSAGE_NOT_FOUND, MESSAGE_NOT_IN_ROOM, NOT_SUBSCRIBED, INVALID_PAGE; react/unreact and close are idempotent.
 * Performance:     Synchronous SQLite with WAL; message listing and pending delivery queries aggregate thread metadata and reactions; message parent, reaction, and durable mention-delivery keys are indexed.
 */

import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";

export type RoomKind = "channel" | "dm";

export interface Room {
	id: string;
	kind: RoomKind;
}

export interface MessageReaction {
	actor: string;
	emoji: string;
}

export interface RoomMessage {
	id: number;
	room: string;
	author: string;
	body: string;
	mentions: string[];
	createdAt: number;
	parentId: number | null;
	threadRootId: number | null;
	replyCount: number;
	reactions: MessageReaction[];
}

export interface CreateRoomInput {
	id: string;
	kind: RoomKind;
}

export interface PostMessageInput {
	room: string;
	author: string;
	body: string;
	createdAt?: number;
	parentId?: number | null;
}

export interface PendingRoom {
	room: string;
	messages: RoomMessage[];
}
interface MessageRow {
	id: number;
	room: string;
	author: string;
	body: string;
	mentions: string;
	created_at: number;
	parent_id: number | null;
	thread_root_id: number | null;
	reply_count: number;
	reactions: string;
}

interface NullableMessageRow {
	id: number | null;
	room: string;
	author: string | null;
	body: string | null;
	mentions: string | null;
	created_at: number | null;
	parent_id: number | null;
	thread_root_id: number | null;
	reply_count: number;
	reactions: string;
}

export class RoomStore {
	private closed = false;

	private constructor(
		readonly path: string,
		private db: Database,
	) {}

	static async open(path: string): Promise<RoomStore> {
		const dir = path.substring(0, path.lastIndexOf("/"));
		if (dir) await mkdir(dir, { recursive: true });
		const db = new Database(path);
		db.exec("PRAGMA foreign_keys = ON");
		db.exec("PRAGMA journal_mode = WAL");
		db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        id   TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('channel', 'dm'))
      );
      CREATE TABLE IF NOT EXISTS messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        room       TEXT NOT NULL,
        author     TEXT NOT NULL,
        body       TEXT NOT NULL,
        mentions   TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        parent_id  INTEGER,
        UNIQUE (id, room),
        FOREIGN KEY (room) REFERENCES rooms(id),
        FOREIGN KEY (parent_id, room) REFERENCES messages(id, room)
      );
      CREATE INDEX IF NOT EXISTS messages_parent_id_idx ON messages(parent_id);
      CREATE TABLE IF NOT EXISTS reactions (
        message_id INTEGER NOT NULL,
        actor      TEXT NOT NULL CHECK (length(trim(actor)) > 0),
        emoji      TEXT NOT NULL CHECK (length(trim(emoji)) > 0),
        PRIMARY KEY (message_id, actor, emoji),
        FOREIGN KEY (message_id) REFERENCES messages(id)
      );
      CREATE TABLE IF NOT EXISTS subscriptions (
        agent        TEXT NOT NULL,
        room         TEXT NOT NULL,
        last_read_id INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (agent, room),
        FOREIGN KEY (room) REFERENCES rooms(id)
      );
      CREATE TABLE IF NOT EXISTS mention_deliveries (
        agent      TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        PRIMARY KEY (agent, message_id),
        FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
      );
    `);
		const columns = db.prepare("PRAGMA table_info(messages)").all() as {
			name: string;
		}[];
		if (!columns.some((column) => column.name === "mentions")) {
			db.exec(
				"ALTER TABLE messages ADD COLUMN mentions TEXT NOT NULL DEFAULT '[]'",
			);
		}
		return new RoomStore(path, db);
	}

	private mapRoom(row: { id: string; kind: string }): Room {
		return { id: row.id, kind: row.kind as RoomKind };
	}

	private mapMessage(row: MessageRow): RoomMessage {
		return {
			id: row.id,
			room: row.room,
			author: row.author,
			body: row.body,
			mentions: JSON.parse(row.mentions) as string[],
			createdAt: row.created_at,
			parentId: row.parent_id,
			threadRootId: row.thread_root_id,
			replyCount: row.reply_count,
			reactions: JSON.parse(row.reactions) as MessageReaction[],
		};
	}

	private mapNullableMessage(row: NullableMessageRow): RoomMessage | null {
		if (
			row.id === null ||
			row.author === null ||
			row.body === null ||
			row.mentions === null ||
			row.created_at === null
		) {
			return null;
		}
		return this.mapMessage({
			...row,
			id: row.id,
			author: row.author,
			body: row.body,
			mentions: row.mentions,
			created_at: row.created_at,
		});
	}

	async createRoom(input: CreateRoomInput): Promise<Room> {
		if (!input.id?.trim()) throw new Error("INVALID_ROOM");
		if (input.kind !== "channel" && input.kind !== "dm")
			throw new Error("INVALID_ROOM");

		const existing = this.db
			.prepare("SELECT id, kind FROM rooms WHERE id = ?")
			.get(input.id) as { id: string; kind: string } | undefined;
		if (existing) {
			if (existing.kind !== input.kind) throw new Error("INVALID_ROOM");
			return this.mapRoom(existing);
		}

		this.db
			.prepare("INSERT INTO rooms (id, kind) VALUES (?, ?)")
			.run(input.id, input.kind);
		return { id: input.id, kind: input.kind };
	}

	async post(input: PostMessageInput): Promise<RoomMessage> {
		if (!input.room) throw new Error("ROOM_NOT_FOUND");
		if (!input.author?.trim()) throw new Error("INVALID_MESSAGE");
		const body = input.body;
		if (!body?.trim()) throw new Error("INVALID_MESSAGE");
		const room = this.db
			.prepare("SELECT id FROM rooms WHERE id = ?")
			.get(input.room) as { id: string } | undefined;
		if (!room) throw new Error("ROOM_NOT_FOUND");

		const parentId = input.parentId ?? null;
		let threadRootId: number | null = null;
		if (parentId !== null) {
			const root = this.db
				.prepare(
					`WITH RECURSIVE ancestors(id, parent_id) AS (
						SELECT id, parent_id FROM messages WHERE id = ? AND room = ?
						UNION ALL
						SELECT m.id, m.parent_id FROM messages m JOIN ancestors a ON m.id = a.parent_id
					)
					SELECT id FROM ancestors WHERE parent_id IS NULL`,
				)
				.get(parentId, input.room) as { id: number } | undefined;
			if (!root) throw new Error("MESSAGE_NOT_IN_ROOM");
			threadRootId = root.id;
		}

		const mentions = this.parseMentions(body);
		const createdAt = input.createdAt ?? Date.now();
		const result = this.db
			.prepare(
				"INSERT INTO messages (room, author, body, mentions, created_at, parent_id) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(
				input.room,
				input.author,
				body,
				JSON.stringify(mentions),
				createdAt,
				parentId,
			);
		return {
			id: Number(result.lastInsertRowid),
			room: input.room,
			author: input.author,
			body,
			mentions,
			createdAt,
			parentId,
			threadRootId,
			replyCount: 0,
			reactions: [],
		};
	}

	parseMentions(body: string): string[] {
		return [
			...new Set(
				[
					...body.matchAll(/(?:^|[^A-Za-z0-9_-])@([A-Za-z0-9][A-Za-z0-9_-]*)/g),
				].map((match) => match[1]),
			),
		];
	}

	async listMessages(
		roomId: string,
		opts: { afterId?: number; limit?: number },
	): Promise<RoomMessage[]> {
		if (!roomId) throw new Error("ROOM_NOT_FOUND");
		if (opts.afterId !== undefined) {
			if (!Number.isInteger(opts.afterId) || opts.afterId < 0)
				throw new Error("INVALID_PAGE");
		}
		if (opts.limit !== undefined) {
			if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 500)
				throw new Error("INVALID_PAGE");
		}

		let messageFilter = "";
		const args: (string | number)[] = [roomId];
		if (opts.afterId !== undefined) {
			messageFilter = " AND id > ?";
			args.push(opts.afterId);
		}
		let limit = "";
		if (opts.limit !== undefined) limit = ` LIMIT ${opts.limit}`;
		const rows = this.db
			.prepare(
				`WITH RECURSIVE
				selected AS (
					SELECT * FROM messages WHERE room = ?${messageFilter} ORDER BY id ASC${limit}
				),
				ancestry(message_id, ancestor_id, parent_id) AS (
					SELECT id, id, parent_id FROM selected
					UNION ALL
					SELECT a.message_id, p.id, p.parent_id
					FROM ancestry a JOIN messages p ON p.id = a.parent_id
				),
				thread_roots AS (
					SELECT message_id, MAX(CASE WHEN parent_id IS NULL AND ancestor_id != message_id THEN ancestor_id END) AS thread_root_id
					FROM ancestry GROUP BY message_id
				)
				SELECT m.id, r.id AS room, m.author, m.body, m.mentions, m.created_at, m.parent_id,
					tr.thread_root_id,
					(SELECT COUNT(*) FROM messages child WHERE child.parent_id = m.id) AS reply_count,
					COALESCE((
						SELECT json_group_array(json_object('actor', actor, 'emoji', emoji))
						FROM (SELECT actor, emoji FROM reactions WHERE message_id = m.id ORDER BY actor, emoji)
					), '[]') AS reactions
				FROM rooms r
				LEFT JOIN selected m ON true
				LEFT JOIN thread_roots tr ON tr.message_id = m.id
				WHERE r.id = ?
				ORDER BY m.id ASC`,
			)
			.all(...args, roomId) as NullableMessageRow[];
		if (rows.length === 0) throw new Error("ROOM_NOT_FOUND");
		const messages: RoomMessage[] = [];
		for (const row of rows) {
			const message = this.mapNullableMessage(row);
			if (message) messages.push(message);
		}
		return messages;
	}

	async react(messageId: number, actor: string, emoji: string): Promise<void> {
		if (!actor?.trim() || !emoji?.trim()) throw new Error("INVALID_REACTION");
		const message = this.db
			.prepare("SELECT id FROM messages WHERE id = ?")
			.get(messageId);
		if (!message) throw new Error("MESSAGE_NOT_FOUND");
		this.db
			.prepare(
				"INSERT OR IGNORE INTO reactions (message_id, actor, emoji) VALUES (?, ?, ?)",
			)
			.run(messageId, actor, emoji);
	}

	async unreact(
		messageId: number,
		actor: string,
		emoji: string,
	): Promise<void> {
		if (!actor?.trim() || !emoji?.trim()) throw new Error("INVALID_REACTION");
		this.db
			.prepare(
				"DELETE FROM reactions WHERE message_id = ? AND actor = ? AND emoji = ?",
			)
			.run(messageId, actor, emoji);
	}

	async subscribe(agent: string, roomId: string): Promise<void> {
		const room = this.db
			.prepare("SELECT id FROM rooms WHERE id = ?")
			.get(roomId) as { id: string } | undefined;
		if (!room) throw new Error("ROOM_NOT_FOUND");
		this.db
			.prepare(
				"INSERT OR IGNORE INTO subscriptions (agent, room, last_read_id) VALUES (?, ?, 0)",
			)
			.run(agent, roomId);
	}

	async markRead(
		agent: string,
		roomId: string,
		messageId: number,
	): Promise<void> {
		const sub = this.db
			.prepare(
				"SELECT last_read_id FROM subscriptions WHERE agent = ? AND room = ?",
			)
			.get(agent, roomId) as { last_read_id: number } | undefined;
		if (!sub) throw new Error("NOT_SUBSCRIBED");
		const msg = this.db
			.prepare("SELECT id FROM messages WHERE id = ? AND room = ?")
			.get(messageId, roomId);
		if (!msg) throw new Error("MESSAGE_NOT_IN_ROOM");
		const newCursor = Math.max(sub.last_read_id, messageId);
		this.db
			.prepare(
				"UPDATE subscriptions SET last_read_id = ? WHERE agent = ? AND room = ?",
			)
			.run(newCursor, agent, roomId);
	}

	async unreadCount(agent: string, roomId?: string): Promise<number> {
		if (roomId !== undefined) {
			const sub = this.db
				.prepare(
					"SELECT last_read_id FROM subscriptions WHERE agent = ? AND room = ?",
				)
				.get(agent, roomId) as { last_read_id: number } | undefined;
			if (!sub) return 0;
			const row = this.db
				.prepare(
					"SELECT COUNT(*) as cnt FROM messages WHERE room = ? AND id > ?",
				)
				.get(roomId, sub.last_read_id) as { cnt: number };
			return row.cnt;
		}
		const row = this.db
			.prepare(
				`SELECT COUNT(*) as cnt
         FROM messages m
         JOIN subscriptions s ON m.room = s.room
         WHERE s.agent = ? AND m.id > s.last_read_id`,
			)
			.get(agent) as { cnt: number };
		return row.cnt;
	}

	async pendingForAgent(agent: string): Promise<PendingRoom[]> {
		const rows = this.db
			.prepare(
				`WITH RECURSIVE
				pending AS (
					SELECT s.room AS subscribed_room, m.*
					FROM subscriptions s
					LEFT JOIN messages m ON m.room = s.room AND m.id > s.last_read_id
					WHERE s.agent = ?
				),
				ancestry(message_id, ancestor_id, parent_id) AS (
					SELECT id, id, parent_id FROM pending WHERE id IS NOT NULL
					UNION ALL
					SELECT a.message_id, p.id, p.parent_id
					FROM ancestry a JOIN messages p ON p.id = a.parent_id
				),
				thread_roots AS (
					SELECT message_id, MAX(CASE WHEN parent_id IS NULL AND ancestor_id != message_id THEN ancestor_id END) AS thread_root_id
					FROM ancestry GROUP BY message_id
				)
				SELECT p.subscribed_room AS room, p.id, p.author, p.body, p.mentions, p.created_at, p.parent_id,
					tr.thread_root_id,
					CASE WHEN p.id IS NULL THEN 0 ELSE (SELECT COUNT(*) FROM messages child WHERE child.parent_id = p.id) END AS reply_count,
					CASE WHEN p.id IS NULL THEN '[]' ELSE COALESCE((
						SELECT json_group_array(json_object('actor', actor, 'emoji', emoji))
						FROM (SELECT actor, emoji FROM reactions WHERE message_id = p.id ORDER BY actor, emoji)
					), '[]') END AS reactions
				FROM pending p
				LEFT JOIN thread_roots tr ON tr.message_id = p.id
				ORDER BY p.subscribed_room, p.id ASC`,
			)
			.all(agent) as NullableMessageRow[];

		const map = new Map<string, PendingRoom>();
		for (const row of rows) {
			let pending = map.get(row.room);
			if (!pending) {
				pending = { room: row.room, messages: [] };
				map.set(row.room, pending);
			}
			const message = this.mapNullableMessage(row);
			if (message) pending.messages.push(message);
		}
		return Array.from(map.values());
	}

	async enqueueMention(agent: string, messageId: number): Promise<void> {
		this.db
			.prepare(
				"INSERT OR IGNORE INTO mention_deliveries (agent, message_id) VALUES (?, ?)",
			)
			.run(agent, messageId);
	}

	async pendingMentionsForAgent(agent: string): Promise<RoomMessage[]> {
		const rows = this.db
			.prepare(
				`WITH RECURSIVE
				pending AS (
					SELECT m.*
					FROM mention_deliveries d
					JOIN messages m ON m.id = d.message_id
					WHERE d.agent = ?
				),
				ancestry(message_id, ancestor_id, parent_id) AS (
					SELECT id, id, parent_id FROM pending
					UNION ALL
					SELECT a.message_id, p.id, p.parent_id
					FROM ancestry a JOIN messages p ON p.id = a.parent_id
				),
				thread_roots AS (
					SELECT message_id, MAX(CASE WHEN parent_id IS NULL AND ancestor_id != message_id THEN ancestor_id END) AS thread_root_id
					FROM ancestry GROUP BY message_id
				)
				SELECT p.id, p.room, p.author, p.body, p.mentions, p.created_at, p.parent_id,
					tr.thread_root_id,
					(SELECT COUNT(*) FROM messages child WHERE child.parent_id = p.id) AS reply_count,
					COALESCE((
						SELECT json_group_array(json_object('actor', actor, 'emoji', emoji))
						FROM (SELECT actor, emoji FROM reactions WHERE message_id = p.id ORDER BY actor, emoji)
					), '[]') AS reactions
				FROM pending p
				LEFT JOIN thread_roots tr ON tr.message_id = p.id
				ORDER BY p.id ASC`,
			)
			.all(agent) as MessageRow[];
		return rows.map((row) => this.mapMessage(row));
	}

	async acknowledgeMentions(
		agent: string,
		messageIds: readonly number[],
	): Promise<void> {
		const statement = this.db.prepare(
			"DELETE FROM mention_deliveries WHERE agent = ? AND message_id = ?",
		);
		for (const messageId of messageIds) statement.run(agent, messageId);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.db.close();
	}
}
