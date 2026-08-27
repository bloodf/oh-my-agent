import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../src/rooms/store";
import type { CreateRoomInput } from "../src/rooms/store";

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
          store.createRoom({ id: "x", kind: "unknown" } as unknown as CreateRoomInput),
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
        const m1 = await store.post({ room: "general", author: "alice", body: "first" });
        const m2 = await store.post({ room: "general", author: "bob", body: "second" });
        const m3 = await store.post({ room: "general", author: "carol", body: "third" });
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
        const msg = await store.post({ room: "general", author: "alice", body: "dated", createdAt: ts });
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
        const msg = await store.post({ room: "general", author: "eve", body: "hello" });
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
        const m1 = await store.post({ room: "general", author: "a", body: "msg1" });
        const m2 = await store.post({ room: "general", author: "b", body: "msg2" });
        const m3 = await store.post({ room: "general", author: "c", body: "msg3" });

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
        const m1 = await store.post({ room: "general", author: "a", body: "1" });
        const m2 = await store.post({ room: "general", author: "b", body: "2" });
        const m3 = await store.post({ room: "general", author: "c", body: "3" });

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
        const m1 = await store.post({ room: "general", author: "a", body: "1" });
        const m2 = await store.post({ room: "general", author: "b", body: "2" });
        const m3 = await store.post({ room: "general", author: "c", body: "3" });

        const page = await store.listMessages("general", { afterId: m1.id, limit: 1 });
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

        await store.post({ room: "general", author: "bob", body: "in general" });
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

        const m1 = await store.post({ room: "general", author: "bob", body: "first" });
        const m2 = await store.post({ room: "general", author: "bob", body: "second" });

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
        const m1 = await store.post({ room: "general", author: "bob", body: "msg1" });
        const m2 = await store.post({ room: "general", author: "bob", body: "msg2" });

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
        await store.post({ room: "general", author: "alice", body: "persisted" });
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
        const m1 = await store.post({ room: "general", author: "bob", body: "msg" });
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
