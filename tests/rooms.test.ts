import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateRoomInput } from "../src/rooms/store";
import { RoomStore } from "../src/rooms/store";

async function withTempDb<T>(fn: (path: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "rooms-db-"));
	const path = join(dir, "test.sqlite");
	try {
		return await fn(path);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

// ── RoomStore.open / close ─────────────────────────────────────────────────────

describe("RoomStore lifecycle", () => {
	test("open creates schema in SQLite file", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				expect(typeof store).toBe("object");
			} finally {
				await store.close();
			}
		});
	});

	test("close is idempotent and resolves", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			await store.close();
			await store.close();
		});
	});
});

// ── RoomStore.createRoom ───────────────────────────────────────────────────────

describe("RoomStore.createRoom", () => {
	test("creates a channel room and returns it", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				const room = await store.createRoom({ id: "general", kind: "channel" });
				expect(room.id).toBe("general");
				expect(room.kind).toBe("channel");
			} finally {
				await store.close();
			}
		});
	});

	test("creates a dm room and returns it", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				const room = await store.createRoom({ id: "alice-bob", kind: "dm" });
				expect(room.id).toBe("alice-bob");
				expect(room.kind).toBe("dm");
			} finally {
				await store.close();
			}
		});
	});

	test("rejects invalid kind", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				await expect(
					store.createRoom({
						id: "x",
						kind: "unknown",
					} as unknown as CreateRoomInput),
				).rejects.toThrow();
			} finally {
				await store.close();
			}
		});
	});

	test("duplicate id is idempotent", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				const r1 = await store.createRoom({ id: "dup", kind: "channel" });
				const r2 = await store.createRoom({ id: "dup", kind: "channel" });
				expect(r1.id).toBe(r2.id);
			} finally {
				await store.close();
			}
		});
	});
});

// ── RoomStore.post ────────────────────────────────────────────────────────────

describe("RoomStore.post", () => {
	test("rejects missing room", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				await expect(
					store.post({ room: "nonexistent", author: "alice", body: "hello" }),
				).rejects.toThrow();
			} finally {
				await store.close();
			}
		});
	});

	test("rejects empty body", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				await store.createRoom({ id: "general", kind: "channel" });
				await expect(
					store.post({ room: "general", author: "alice", body: "" }),
				).rejects.toThrow();
			} finally {
				await store.close();
			}
		});
	});

	test("assigns monotonic integer id", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				await store.createRoom({ id: "general", kind: "channel" });
				const m1 = await store.post({
					room: "general",
					author: "alice",
					body: "first",
				});
				const m2 = await store.post({
					room: "general",
					author: "bob",
					body: "second",
				});
				const m3 = await store.post({
					room: "general",
					author: "carol",
					body: "third",
				});
				expect(m2.id).toBeGreaterThan(m1.id);
				expect(m3.id).toBeGreaterThan(m2.id);
				expect(m1.id).toBe(Math.floor(m1.id));
				expect(m2.id).toBe(Math.floor(m2.id));
			} finally {
				await store.close();
			}
		});
	});

	test("uses provided createdAt when supplied", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				await store.createRoom({ id: "general", kind: "channel" });
				const ts = 1700000000000;
				const msg = await store.post({
					room: "general",
					author: "alice",
					body: "dated",
					createdAt: ts,
				});
				expect(msg.createdAt).toBe(ts);
			} finally {
				await store.close();
			}
		});
	});

	test("records author correctly", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				await store.createRoom({ id: "general", kind: "channel" });
				const msg = await store.post({
					room: "general",
					author: "eve",
					body: "hello",
				});
				expect(msg.author).toBe("eve");
			} finally {
				await store.close();
			}
		});
	});
});

// ── RoomStore.listMessages ─────────────────────────────────────────────────────

describe("RoomStore.listMessages", () => {
	test("returns messages in chronological order", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				await store.createRoom({ id: "general", kind: "channel" });
				const m1 = await store.post({
					room: "general",
					author: "a",
					body: "msg1",
				});
				const m2 = await store.post({
					room: "general",
					author: "b",
					body: "msg2",
				});
				const m3 = await store.post({
					room: "general",
					author: "c",
					body: "msg3",
				});

				const msgs = await store.listMessages("general", {});
				const ids = msgs.map((m) => m.id);
				expect(ids).toEqual([m1.id, m2.id, m3.id]);
			} finally {
				await store.close();
			}
		});
	});

	test("paging with afterId", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				await store.createRoom({ id: "general", kind: "channel" });
				const m1 = await store.post({
					room: "general",
					author: "a",
					body: "1",
				});
				const m2 = await store.post({
					room: "general",
					author: "b",
					body: "2",
				});
				const m3 = await store.post({
					room: "general",
					author: "c",
					body: "3",
				});

				const page = await store.listMessages("general", { afterId: m1.id });
				expect(page.map((m) => m.id)).toEqual([m2.id, m3.id]);
			} finally {
				await store.close();
			}
		});
	});

	test("paging with limit", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				await store.createRoom({ id: "general", kind: "channel" });
				await store.post({ room: "general", author: "a", body: "1" });
				await store.post({ room: "general", author: "b", body: "2" });
				await store.post({ room: "general", author: "c", body: "3" });

				const page = await store.listMessages("general", { limit: 2 });
				expect(page.length).toBeLessThanOrEqual(2);
			} finally {
				await store.close();
			}
		});
	});

	test("afterId and limit combined", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				await store.createRoom({ id: "general", kind: "channel" });
				const m1 = await store.post({
					room: "general",
					author: "a",
					body: "1",
				});
				const m2 = await store.post({
					room: "general",
					author: "b",
					body: "2",
				});
				await store.post({
					room: "general",
					author: "c",
					body: "3",
				});

				const page = await store.listMessages("general", {
					afterId: m1.id,
					limit: 1,
				});
				expect(page.length).toBe(1);
				expect(page[0].id).toBe(m2.id);
			} finally {
				await store.close();
			}
		});
	});
});

// ── RoomStore.subscribe ────────────────────────────────────────────────────────

describe("RoomStore.subscribe", () => {
	test("agent subscribes to a room", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				await store.createRoom({ id: "general", kind: "channel" });
				await store.subscribe("alice", "general");
				const pending = await store.pendingForAgent("alice");
				expect(pending.some((p) => p.room === "general")).toBe(true);
			} finally {
				await store.close();
			}
		});
	});

	test("subscribe is idempotent", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				await store.createRoom({ id: "general", kind: "channel" });
				await store.subscribe("alice", "general");
				await store.subscribe("alice", "general");
				const pending = await store.pendingForAgent("alice");
				const count = pending.filter((p) => p.room === "general").length;
				expect(count).toBe(1);
			} finally {
				await store.close();
			}
		});
	});

	test("pending batches only include subscribed rooms", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				await store.createRoom({ id: "general", kind: "channel" });
				await store.createRoom({ id: "random", kind: "channel" });
				await store.subscribe("alice", "general");

				await store.post({
					room: "general",
					author: "bob",
					body: "in general",
				});
				await store.post({ room: "random", author: "bob", body: "in random" });

				const pending = await store.pendingForAgent("alice");
				expect(pending.every((p) => p.room === "general")).toBe(true);
			} finally {
				await store.close();
			}
		});
	});
});

// ── RoomStore.markRead ─────────────────────────────────────────────────────────

describe("RoomStore.markRead", () => {
	test("markRead moves per-agent cursor forward", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				await store.createRoom({ id: "general", kind: "channel" });
				await store.subscribe("alice", "general");

				const m1 = await store.post({
					room: "general",
					author: "bob",
					body: "first",
				});
				await store.post({
					room: "general",
					author: "bob",
					body: "second",
				});

				const before = await store.unreadCount("alice", "general");
				expect(before).toBeGreaterThan(0);

				await store.markRead("alice", "general", m1.id);

				const after = await store.unreadCount("alice", "general");
				expect(after).toBeLessThan(before);
			} finally {
				await store.close();
			}
		});
	});
});

// ── RoomStore.unreadCount ─────────────────────────────────────────────────────

describe("RoomStore.unreadCount", () => {
	test("returns 0 for agent with no subscription", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				await store.createRoom({ id: "general", kind: "channel" });
				await store.post({ room: "general", author: "bob", body: "msg" });
				const count = await store.unreadCount("alice", "general");
				expect(count).toBe(0);
			} finally {
				await store.close();
			}
		});
	});

	test("returns 0 after all messages are marked read", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				await store.createRoom({ id: "general", kind: "channel" });
				await store.subscribe("alice", "general");
				const m1 = await store.post({
					room: "general",
					author: "bob",
					body: "msg1",
				});
				const m2 = await store.post({
					room: "general",
					author: "bob",
					body: "msg2",
				});

				await store.markRead("alice", "general", m1.id);
				await store.markRead("alice", "general", m2.id);

				const count = await store.unreadCount("alice", "general");
				expect(count).toBe(0);
			} finally {
				await store.close();
			}
		});
	});

	test("omitting room returns total unread across all subscribed rooms", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				await store.createRoom({ id: "general", kind: "channel" });
				await store.createRoom({ id: "random", kind: "channel" });
				await store.subscribe("alice", "general");
				await store.subscribe("alice", "random");

				await store.post({ room: "general", author: "bob", body: "g1" });
				await store.post({ room: "random", author: "bob", body: "r1" });

				const total = await store.unreadCount("alice");
				expect(total).toBe(2);
			} finally {
				await store.close();
			}
		});
	});
});

// ── persistence across reopen ─────────────────────────────────────────────────

describe("RoomStore persistence", () => {
	test("messages survive close and reopen", async () => {
		await withTempDb(async (path) => {
			{
				const store = await RoomStore.open(path);
				await store.createRoom({ id: "general", kind: "channel" });
				await store.post({
					room: "general",
					author: "alice",
					body: "persisted",
				});
				await store.close();
			}
			{
				const store = await RoomStore.open(path);
				try {
					const msgs = await store.listMessages("general", {});
					expect(msgs.some((m) => m.body === "persisted")).toBe(true);
				} finally {
					await store.close();
				}
			}
		});
	});

	test("subscriptions survive close and reopen", async () => {
		await withTempDb(async (path) => {
			{
				const store = await RoomStore.open(path);
				await store.createRoom({ id: "general", kind: "channel" });
				await store.subscribe("alice", "general");
				await store.close();
			}
			{
				const store = await RoomStore.open(path);
				try {
					const pending = await store.pendingForAgent("alice");
					expect(pending.some((p) => p.room === "general")).toBe(true);
				} finally {
					await store.close();
				}
			}
		});
	});

	test("read cursors survive close and reopen", async () => {
		await withTempDb(async (path) => {
			{
				const store = await RoomStore.open(path);
				await store.createRoom({ id: "general", kind: "channel" });
				await store.subscribe("alice", "general");
				const m1 = await store.post({
					room: "general",
					author: "bob",
					body: "msg",
				});
				await store.markRead("alice", "general", m1.id);
				await store.close();
			}
			{
				const store = await RoomStore.open(path);
				try {
					const count = await store.unreadCount("alice", "general");
					expect(count).toBe(0);
				} finally {
					await store.close();
				}
			}
		});
	});
});

// ── T-601: Threading ──────────────────────────────────────────────────────────

describe("RoomStore threading — parentId and threadRootId", () => {
	test("direct reply sets parentId and threadRootId to parent", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				await store.createRoom({ id: "gen", kind: "channel" });
				const root = await store.post({
					room: "gen",
					author: "alice",
					body: "root",
				});
				const reply = await store.post({
					room: "gen",
					author: "bob",
					body: "reply",
					parentId: root.id,
				});
				expect(reply.parentId).toBe(root.id);
				expect(reply.threadRootId).toBe(root.id);
			} finally {
				await store.close();
			}
		});
	});

	test("reply-to-reply derives threadRootId from top ancestor", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				await store.createRoom({ id: "gen", kind: "channel" });
				const root = await store.post({
					room: "gen",
					author: "alice",
					body: "root",
				});
				const child = await store.post({
					room: "gen",
					author: "bob",
					body: "child",
					parentId: root.id,
				});
				const grandchild = await store.post({
					room: "gen",
					author: "carol",
					body: "grandchild",
					parentId: child.id,
				});
				expect(grandchild.parentId).toBe(child.id);
				expect(grandchild.threadRootId).toBe(root.id);
			} finally {
				await store.close();
			}
		});
	});

	test("top-level message has parentId null and threadRootId null", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				await store.createRoom({ id: "gen", kind: "channel" });
				const msg = await store.post({
					room: "gen",
					author: "alice",
					body: "standalone",
				});
				expect(msg.parentId).toBeNull();
				expect(msg.threadRootId).toBeNull();
			} finally {
				await store.close();
			}
		});
	});

	test("cross-room parent is rejected", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				await store.createRoom({ id: "roomA", kind: "channel" });
				await store.createRoom({ id: "roomB", kind: "channel" });
				const inA = await store.post({
					room: "roomA",
					author: "alice",
					body: "in A",
				});
				await expect(
					store.post({
						room: "roomB",
						author: "bob",
						body: "cross-room reply",
						parentId: inA.id,
					}),
				).rejects.toThrow();
			} finally {
				await store.close();
			}
		});
	});
});

// ── T-601: replyCount aggregation in listMessages ─────────────────────────────

describe("RoomStore.listMessages — replyCount and reactions fields", () => {
	test("each listed message has replyCount field", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				await store.createRoom({ id: "gen", kind: "channel" });
				const root = await store.post({
					room: "gen",
					author: "alice",
					body: "root",
				});
				await store.post({
					room: "gen",
					author: "bob",
					body: "reply",
					parentId: root.id,
				});
				const msgs = await store.listMessages("gen", {});
				for (const m of msgs) {
					expect(typeof m.replyCount).toBe("number");
				}
			} finally {
				await store.close();
			}
		});
	});

	test("root replyCount equals number of direct replies", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				await store.createRoom({ id: "gen", kind: "channel" });
				const root = await store.post({
					room: "gen",
					author: "alice",
					body: "root",
				});
				await store.post({
					room: "gen",
					author: "bob",
					body: "r1",
					parentId: root.id,
				});
				await store.post({
					room: "gen",
					author: "carol",
					body: "r2",
					parentId: root.id,
				});
				const msgs = await store.listMessages("gen", {});
				const rootMsg = msgs.find((m) => m.id === root.id);
				expect(rootMsg?.replyCount).toBe(2);
			} finally {
				await store.close();
			}
		});
	});

	test("grandchild reply does not inflate root replyCount", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				await store.createRoom({ id: "gen", kind: "channel" });
				const root = await store.post({
					room: "gen",
					author: "alice",
					body: "root",
				});
				const child = await store.post({
					room: "gen",
					author: "bob",
					body: "child",
					parentId: root.id,
				});
				await store.post({
					room: "gen",
					author: "carol",
					body: "grand",
					parentId: child.id,
				});
				const msgs = await store.listMessages("gen", {});
				const rootMsg = msgs.find((m) => m.id === root.id);
				expect(rootMsg?.replyCount).toBe(1);
			} finally {
				await store.close();
			}
		});
	});

	test("each listed message has reactions array", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				await store.createRoom({ id: "gen", kind: "channel" });
				await store.post({ room: "gen", author: "alice", body: "msg" });
				const msgs = await store.listMessages("gen", {});
				for (const m of msgs) {
					expect(Array.isArray(m.reactions)).toBe(true);
				}
			} finally {
				await store.close();
			}
		});
	});

	test("reactions include actor and emoji fields", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				await store.createRoom({ id: "gen", kind: "channel" });
				const msg = await store.post({
					room: "gen",
					author: "alice",
					body: "msg",
				});
				await store.react(msg.id, "bob", "👍");
				const msgs = await store.listMessages("gen", {});
				const listed = msgs.find((m) => m.id === msg.id);
				expect(listed?.reactions).toHaveLength(1);
				expect(listed?.reactions[0].actor).toBe("bob");
				expect(listed?.reactions[0].emoji).toBe("👍");
			} finally {
				await store.close();
			}
		});
	});

	test("loads populated conversation metadata with exactly one SQLite read", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				await store.createRoom({ id: "gen", kind: "channel" });
				const root = await store.post({
					room: "gen",
					author: "alice",
					body: "root",
				});
				await store.post({
					room: "gen",
					author: "bob",
					body: "reply",
					parentId: root.id,
				});
				await store.react(root.id, "carol", "👍");

				const prepareSpy = spyOn(Database.prototype, "prepare");
				try {
					const messages = await store.listMessages("gen", {});

					expect(messages).toHaveLength(2);
					expect(prepareSpy).toHaveBeenCalledTimes(1);
				} finally {
					prepareSpy.mockRestore();
				}
			} finally {
				await store.close();
			}
		});
	});
});

// ── T-601: RoomStore.react ────────────────────────────────────────────────────

describe("RoomStore.react", () => {
	test("react adds a reaction entry visible in listMessages", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				await store.createRoom({ id: "gen", kind: "channel" });
				const msg = await store.post({
					room: "gen",
					author: "alice",
					body: "hello",
				});
				await store.react(msg.id, "bob", "❤️");
				const msgs = await store.listMessages("gen", {});
				const listed = msgs.find((m) => m.id === msg.id);
				expect(
					listed?.reactions.some((r) => r.actor === "bob" && r.emoji === "❤️"),
				).toBe(true);
			} finally {
				await store.close();
			}
		});
	});

	test("duplicate react (same message+actor+emoji) remains one row", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				await store.createRoom({ id: "gen", kind: "channel" });
				const msg = await store.post({
					room: "gen",
					author: "alice",
					body: "hello",
				});
				await store.react(msg.id, "bob", "👍");
				await store.react(msg.id, "bob", "👍");
				const msgs = await store.listMessages("gen", {});
				const listed = msgs.find((m) => m.id === msg.id);
				const count =
					listed?.reactions.filter((r) => r.actor === "bob" && r.emoji === "👍")
						.length ?? 0;
				expect(count).toBe(1);
			} finally {
				await store.close();
			}
		});
	});

	test("multiple actors on same message all appear", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				await store.createRoom({ id: "gen", kind: "channel" });
				const msg = await store.post({
					room: "gen",
					author: "alice",
					body: "hello",
				});
				await store.react(msg.id, "bob", "👍");
				await store.react(msg.id, "carol", "👍");
				const msgs = await store.listMessages("gen", {});
				const listed = msgs.find((m) => m.id === msg.id);
				const actors = listed?.reactions.map((r) => r.actor).sort() ?? [];
				expect(actors).toEqual(["bob", "carol"]);
			} finally {
				await store.close();
			}
		});
	});

	test("same actor different emojis both appear", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				await store.createRoom({ id: "gen", kind: "channel" });
				const msg = await store.post({
					room: "gen",
					author: "alice",
					body: "hello",
				});
				await store.react(msg.id, "bob", "👍");
				await store.react(msg.id, "bob", "❤️");
				const msgs = await store.listMessages("gen", {});
				const listed = msgs.find((m) => m.id === msg.id);
				const emojis =
					listed?.reactions
						.filter((r) => r.actor === "bob")
						.map((r) => r.emoji)
						.sort() ?? [];
				expect(emojis).toEqual(["❤️", "👍"].sort());
			} finally {
				await store.close();
			}
		});
	});
});

// ── T-601: RoomStore.unreact ──────────────────────────────────────────────────

describe("RoomStore.unreact", () => {
	test("unreact removes existing reaction", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				await store.createRoom({ id: "gen", kind: "channel" });
				const msg = await store.post({
					room: "gen",
					author: "alice",
					body: "hello",
				});
				await store.react(msg.id, "bob", "👍");
				await store.unreact(msg.id, "bob", "👍");
				const msgs = await store.listMessages("gen", {});
				const listed = msgs.find((m) => m.id === msg.id);
				expect(
					listed?.reactions.some((r) => r.actor === "bob" && r.emoji === "👍"),
				).toBe(false);
			} finally {
				await store.close();
			}
		});
	});

	test("unreact on never-added reaction is a no-op", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				await store.createRoom({ id: "gen", kind: "channel" });
				const msg = await store.post({
					room: "gen",
					author: "alice",
					body: "hello",
				});
				await expect(
					store.unreact(msg.id, "bob", "👍"),
				).resolves.toBeUndefined();
				const msgs = await store.listMessages("gen", {});
				const listed = msgs.find((m) => m.id === msg.id);
				expect(listed?.reactions).toHaveLength(0);
			} finally {
				await store.close();
			}
		});
	});

	test("unreact only removes the matched emoji, others remain", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				await store.createRoom({ id: "gen", kind: "channel" });
				const msg = await store.post({
					room: "gen",
					author: "alice",
					body: "hello",
				});
				await store.react(msg.id, "bob", "👍");
				await store.react(msg.id, "bob", "❤️");
				await store.unreact(msg.id, "bob", "👍");
				const msgs = await store.listMessages("gen", {});
				const listed = msgs.find((m) => m.id === msg.id);
				expect(listed?.reactions).toHaveLength(1);
				expect(listed?.reactions[0].emoji).toBe("❤️");
			} finally {
				await store.close();
			}
		});
	});
});

// ── T-601: reactions do not affect unread count ───────────────────────────────

describe("reactions do not affect unread count", () => {
	test("reacting to a message does not increase unreadCount", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				await store.createRoom({ id: "gen", kind: "channel" });
				await store.subscribe("alice", "gen");
				const msg = await store.post({
					room: "gen",
					author: "bob",
					body: "hello",
				});
				await store.markRead("alice", "gen", msg.id);
				const before = await store.unreadCount("alice", "gen");
				await store.react(msg.id, "carol", "👍");
				const after = await store.unreadCount("alice", "gen");
				expect(after).toBe(before);
			} finally {
				await store.close();
			}
		});
	});
});

// ── T-601: threaded replies in pendingForAgent ────────────────────────────────

describe("pendingForAgent with threaded messages", () => {
	test("threaded reply appears in pendingForAgent with parentId and threadRootId", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				await store.createRoom({ id: "gen", kind: "channel" });
				await store.subscribe("alice", "gen");
				const root = await store.post({
					room: "gen",
					author: "bob",
					body: "root",
				});
				const reply = await store.post({
					room: "gen",
					author: "carol",
					body: "reply",
					parentId: root.id,
				});
				const pending = await store.pendingForAgent("alice");
				const batch = pending.find((p) => p.room === "gen");
				const pendingReply = batch?.messages.find((m) => m.id === reply.id);
				expect(pendingReply?.parentId).toBe(root.id);
				expect(pendingReply?.threadRootId).toBe(root.id);
			} finally {
				await store.close();
			}
		});
	});

	test("pendingForAgent delivers both root and reply as unread messages", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				await store.createRoom({ id: "gen", kind: "channel" });
				await store.subscribe("alice", "gen");
				const root = await store.post({
					room: "gen",
					author: "bob",
					body: "root",
				});
				await store.post({
					room: "gen",
					author: "carol",
					body: "reply",
					parentId: root.id,
				});
				const pending = await store.pendingForAgent("alice");
				const batch = pending.find((p) => p.room === "gen");
				expect(batch?.messages.length).toBe(2);
			} finally {
				await store.close();
			}
		});
	});

	test("pendingForAgent messages include reactions array", async () => {
		await withTempDb(async (path) => {
			const store = await RoomStore.open(path);
			try {
				await store.createRoom({ id: "gen", kind: "channel" });
				await store.subscribe("alice", "gen");
				const msg = await store.post({
					room: "gen",
					author: "bob",
					body: "hello",
				});
				await store.react(msg.id, "carol", "👍");
				const pending = await store.pendingForAgent("alice");
				const batch = pending.find((p) => p.room === "gen");
				const pendingMsg = batch?.messages.find((m) => m.id === msg.id);
				expect(Array.isArray(pendingMsg?.reactions)).toBe(true);
				expect(
					pendingMsg?.reactions.some(
						(r: { actor: string; emoji: string }) =>
							r.actor === "carol" && r.emoji === "👍",
					),
				).toBe(true);
			} finally {
				await store.close();
			}
		});
	});
});
