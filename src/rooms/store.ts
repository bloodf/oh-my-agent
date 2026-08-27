/**
 * @oh-my-agent/rooms — bun:sqlite RoomStore
 *
 * Purpose:        Persistent room/message/subscription store for multi-agent collaboration.
 * Public API:      RoomStore.open(), createRoom(), post(), listMessages(), subscribe(), markRead(), unreadCount(), pendingForAgent(), close()
 * Upstream deps:   bun:sqlite (Database), node:fs/promises (mkdir)
 * Downstream consumers: extension/index.ts, any agent code importing this module
 * Failure modes:   INVALID_ROOM (missing/invalid id or kind mismatch), INVALID_MESSAGE (empty author or body), ROOM_NOT_FOUND, NOT_SUBSCRIBED, MESSAGE_NOT_IN_ROOM, INVALID_PAGE (pagination bounds violation), close idempotent (no-op if already closed)
 * Performance:     Synchronous SQLite; rooms.id, messages.id (PK), subscriptions(agent,room) (PK) indexed; WAL journal mode.
 */

import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";

export type RoomKind = "channel" | "dm";

export interface Room {
  id: string;
  kind: RoomKind;
}

export interface RoomMessage {
  id: number;
  room: string;
  author: string;
  body: string;
  createdAt: number;
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
}

export interface PendingRoom {
  room: string;
  messages: RoomMessage[];
}

export class RoomStore {
  private closed = false;

  private constructor(readonly path: string, private db: Database) {}

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
        created_at INTEGER NOT NULL,
        FOREIGN KEY (room) REFERENCES rooms(id)
      );
      CREATE TABLE IF NOT EXISTS subscriptions (
        agent        TEXT NOT NULL,
        room         TEXT NOT NULL,
        last_read_id INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (agent, room),
        FOREIGN KEY (room) REFERENCES rooms(id)
      );
    `);
    return new RoomStore(path, db);
  }

  private mapRoom(row: { id: string; kind: string }): Room {
    return { id: row.id, kind: row.kind as RoomKind };
  }

  private mapMessage(row: {
    id: number;
    room: string;
    author: string;
    body: string;
    created_at: number;
  }): RoomMessage {
    return {
      id: row.id,
      room: row.room,
      author: row.author,
      body: row.body,
      createdAt: row.created_at,
    };
  }

  async createRoom(input: CreateRoomInput): Promise<Room> {
    if (!input.id || !input.id.trim()) throw new Error("INVALID_ROOM");
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
    if (!input.author || !input.author.trim()) throw new Error("INVALID_MESSAGE");
    const body = input.body;
    if (!body || !body.trim()) throw new Error("INVALID_MESSAGE");
    const room = this.db
      .prepare("SELECT id FROM rooms WHERE id = ?")
      .get(input.room) as { id: string } | undefined;
    if (!room) throw new Error("ROOM_NOT_FOUND");
    const createdAt = input.createdAt ?? Date.now();
    const result = this.db
      .prepare(
        "INSERT INTO messages (room, author, body, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(input.room, input.author, body, createdAt);
    return {
      id: Number(result.lastInsertRowid),
      room: input.room,
      author: input.author,
      body: input.body,
      createdAt,
    };
  }

  async listMessages(
    roomId: string,
    opts: { afterId?: number; limit?: number },
  ): Promise<RoomMessage[]> {
    if (!roomId) throw new Error("ROOM_NOT_FOUND");
    const room = this.db
      .prepare("SELECT id FROM rooms WHERE id = ?")
      .get(roomId) as { id: string } | undefined;
    if (!room) throw new Error("ROOM_NOT_FOUND");

    if (opts.afterId !== undefined) {
      if (!Number.isInteger(opts.afterId) || opts.afterId < 0)
        throw new Error("INVALID_PAGE");
    }
    if (opts.limit !== undefined) {
      if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 500)
        throw new Error("INVALID_PAGE");
    }

    let sql =
      "SELECT id, room, author, body, created_at FROM messages WHERE room = ?";
    const args: (string | number)[] = [roomId];
    if (opts.afterId !== undefined) {
      sql += " AND id > ?";
      args.push(opts.afterId);
    }
    sql += " ORDER BY id ASC";
    if (opts.limit !== undefined) {
      sql += " LIMIT " + opts.limit;
    }
    const rows = this.db.prepare(sql).all(...args) as {
      id: number;
      room: string;
      author: string;
      body: string;
      created_at: number;
    }[];
    return rows.map((r) => this.mapMessage(r));
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

  async markRead(agent: string, roomId: string, messageId: number): Promise<void> {
    const sub = this.db
      .prepare("SELECT last_read_id FROM subscriptions WHERE agent = ? AND room = ?")
      .get(agent, roomId) as { last_read_id: number } | undefined;
    if (!sub) throw new Error("NOT_SUBSCRIBED");
    const msg = this.db
      .prepare("SELECT id FROM messages WHERE id = ? AND room = ?")
      .get(messageId, roomId);
    if (!msg) throw new Error("MESSAGE_NOT_IN_ROOM");
    const newCursor = Math.max(sub.last_read_id, messageId);
    this.db
      .prepare("UPDATE subscriptions SET last_read_id = ? WHERE agent = ? AND room = ?")
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
        .prepare("SELECT COUNT(*) as cnt FROM messages WHERE room = ? AND id > ?")
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
        `SELECT s.room, m.id, m.author, m.body, m.created_at
         FROM subscriptions s
         LEFT JOIN messages m ON m.room = s.room AND m.id > s.last_read_id
         WHERE s.agent = ?
         ORDER BY s.room, m.id ASC`,
      )
      .all(agent) as {
      room: string;
      id: number | null;
      author: string | null;
      body: string | null;
      created_at: number | null;
    }[];

    const map = new Map<string, PendingRoom>();
    for (const row of rows) {
      if (!map.has(row.room)) {
        map.set(row.room, { room: row.room, messages: [] });
      }
      if (
        row.id !== null &&
        row.author !== null &&
        row.body !== null &&
        row.created_at !== null
      ) {
        map.get(row.room)!.messages.push({
          id: row.id,
          room: row.room,
          author: row.author,
          body: row.body,
          createdAt: row.created_at,
        });
      }
    }
    return Array.from(map.values());
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
