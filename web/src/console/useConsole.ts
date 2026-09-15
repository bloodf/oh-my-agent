import { useCallback, useEffect, useRef, useState } from "react";
import { EMPTY_PROFILE, type Profile } from "./profile";
import { toast } from "sonner";
import { api, AUTHENTICATION_REQUIRED, readToken } from "@/lib/api";
import type {
  AgentInfo,
  ConsoleStateKind,
  RoomInfo,
  RoomMessage,
} from "@/lib/types";

/** Rows per transcript page, newest first; older pages load on request. */
const PAGE_SIZE = 200;
/** Chat frames arrive per token while OMP streams; refetches are batched to this. */
const CHAT_REFRESH_MS = 250;
/** Failed reconnects before the console suggests the daemon moved. */
const RESTART_HINT_ATTEMPTS = 5;
const RESTART_HINT =
  "Still cannot reach the daemon. If it restarted, it may be on a new address: open the URL printed by `omp-agent console`.";

type TestHooks = typeof globalThis & {
  __consoleTestHooks?: boolean;
  __consoleSockets?: WebSocket[];
  __consoleReconcilePasses?: number;
};

/** Socket and reconcile probes exist only for a page that opted in before load. */
const testHooks = (): TestHooks | null => {
  const root = globalThis as TestHooks;
  return root.__consoleTestHooks === true ? root : null;
};

/** A newest or `beforeId` page ends with its own rows; any before them are thread roots it carried. */
const pageStart = (rows: RoomMessage[]) =>
  rows[Math.max(0, rows.length - PAGE_SIZE)]?.id;

const mergeMessages = (previous: RoomMessage[], rows: RoomMessage[]) => {
  const byId = new Map(previous.map((message) => [message.id, message]));
  for (const row of rows) byId.set(row.id, row);
  return [...byId.values()].sort((left, right) => left.id - right.id);
};

/** Owns authenticated room snapshots and one reconnecting feed per mounted console. */
export function useConsole() {
  const [auth] = useState(readToken);
  const [authRequired, setAuthRequired] = useState(
    auth.remoteMode && !auth.token,
  );
  const [authError, setAuthError] = useState("");
  const [channels, setChannels] = useState<RoomInfo[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [currentRoom, setCurrentRoom] = useState<string | null>(
    new URLSearchParams(location.search).get("room"),
  );
  const [unread, setUnread] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<ConsoleStateKind>("connecting");
  const [statusDetail, setStatusDetail] = useState(
    "Connecting to your workspace.",
  );
  const [notice, setNotice] = useState("");
  const [connected, setConnected] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [workspaceVersion, setWorkspaceVersion] = useState(0);
  const [chatVersions, setChatVersions] = useState<Record<string, number>>({});
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  /** Lowest id of the unbroken history loaded for the current room. */
  const oldestLoaded = useRef<number | null>(null);
  const dirtyChats = useRef(new Set<string>());
  const chatFlush = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const roomRef = useRef(currentRoom);
  const requestSerial = useRef(0);
  const socketRef = useRef<WebSocket | null>(null);
  const authRef = useRef(authRequired);
  const cursors = useRef(new Map<string, number>());
  const channelsRef = useRef<RoomInfo[]>([]);
  const liveGeneration = useRef(0);

  useEffect(() => {
    authRef.current = authRequired;
  }, [authRequired]);

  useEffect(() => {
    channelsRef.current = channels;
  }, [channels]);
  const call = useCallback(
    (
      path: string,
      init: {
        method?: string;
        body?: unknown;
        headers?: Record<string, string>;
      } = {},
    ) => {
      if (authRef.current) return Promise.reject(AUTHENTICATION_REQUIRED);
      return api(path, {
        ...init,
        token: auth.token,
        remoteMode: auth.remoteMode,
        onUnauthorized: () => {
          authRef.current = true;
          liveGeneration.current += 1;
          setAuthRequired(true);
          setAuthError("Operator token refused. Re-enter the token.");
          sessionStorage.removeItem("oh-my-agent.operator-token");
          const hadSocket = socketRef.current !== null;
          socketRef.current?.close();
          socketRef.current = null;
          const root = testHooks();
          if (root && (hadSocket || root.__consoleSockets !== undefined))
            root.__consoleSockets = [];
        },
      });
    },
    [auth],
  );
  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (text) toast.message(text);
  }, []);
  const refreshAgents = useCallback(async () => {
    const payload = await call("/api/agents");
    if (!authRef.current) setAgents(payload.agents as AgentInfo[]);
  }, [call]);
  const [profile, setProfile] = useState<Profile>(EMPTY_PROFILE);
  const refreshProfile = useCallback(async () => {
    const payload = await call("/api/profile");
    if (!authRef.current && payload.profile) setProfile(payload.profile as Profile);
  }, [call]);
  const refreshChannels = useCallback(async () => {
    const payload = await call("/api/channels");
    const list = payload.channels as RoomInfo[];
    if (!authRef.current) setChannels(list);
    return list;
  }, [call]);
  const refreshMessages = useCallback(
    async (room: string, preserveOnFailure = false, changedId?: number) => {
      const serial = ++requestSerial.current;
      const base = `/api/channels/${encodeURIComponent(room)}/messages`;
      const current = () =>
        serial === requestSerial.current &&
        roomRef.current === room &&
        !authRef.current;
      try {
        const payload = await call(`${base}?newest=1&limit=${PAGE_SIZE}`);
        if (!current()) return;
        const page = payload.messages as RoomMessage[];
        const start = pageStart(page);
        const loaded = oldestLoaded.current;
        // Older pages the operator already loaded stay; the newest page
        // replaces everything from its first row on.
        const keepOlder =
          loaded !== null && start !== undefined && loaded < start;
        if (keepOlder)
          setMessages((previous) =>
            mergeMessages(
              previous.filter((message) => message.id < start),
              page,
            ),
          );
        else {
          oldestLoaded.current = start ?? null;
          setHasOlder(page.length >= PAGE_SIZE);
          setMessages(page);
        }
        cursors.current.set(
          room,
          Math.max(cursors.current.get(room) ?? 0, ...page.map((m) => m.id)),
        );
        setStatus(page.length || keepOlder ? null : "empty");
        setStatusDetail("");
        // A reaction on a message older than the newest page is refreshed on
        // its own, so paged-in history does not show stale reactions.
        if (
          keepOlder &&
          changedId !== undefined &&
          start !== undefined &&
          changedId < start
        ) {
          const single = await call(`${base}?afterId=${changedId - 1}&limit=1`);
          const [row] = single.messages as RoomMessage[];
          if (row?.id === changedId && roomRef.current === room)
            setMessages((previous) =>
              previous.map((message) => (message.id === row.id ? row : message)),
            );
        }
      } catch (error) {
        if (
          error === AUTHENTICATION_REQUIRED ||
          !current() ||
          preserveOnFailure
        )
          return;
        setStatus("load-failure");
        setStatusDetail(error instanceof Error ? error.message : String(error));
      }
    },
    [call],
  );
  const loadOlder = useCallback(async () => {
    const room = roomRef.current;
    const before = oldestLoaded.current;
    if (!room || before === null) return;
    setLoadingOlder(true);
    try {
      const payload = await call(
        `/api/channels/${encodeURIComponent(room)}/messages?beforeId=${before}&limit=${PAGE_SIZE}`,
      );
      if (
        roomRef.current !== room ||
        oldestLoaded.current !== before ||
        authRef.current
      )
        return;
      const page = payload.messages as RoomMessage[];
      oldestLoaded.current = pageStart(page) ?? before;
      setHasOlder(page.length >= PAGE_SIZE);
      setMessages((previous) => mergeMessages(previous, page));
    } catch (error) {
      if (error !== AUTHENTICATION_REQUIRED && roomRef.current === room)
        showNotice(error instanceof Error ? error.message : String(error));
    } finally {
      if (roomRef.current === room) setLoadingOlder(false);
    }
  }, [call, showNotice]);
  const selectRoom = useCallback(
    (id: string) => {
      roomRef.current = id;
      setCurrentRoom(id);
      setMessages([]);
      oldestLoaded.current = null;
      setHasOlder(false);
      setLoadingOlder(false);
      setStatus("connecting");
      setUnread((previous) => {
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
      const url = new URL(location.href);
      url.searchParams.set("room", id);
      history.replaceState(null, "", url);
      void refreshChannels().catch((error) =>
        showNotice(error instanceof Error ? error.message : String(error)),
      );
      void refreshMessages(id);
    },
    [refreshChannels, refreshMessages, showNotice],
  );

  useEffect(() => {
    if (authRequired) return;
    const epoch = ++liveGeneration.current;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let opened = false;
    let hasSnapshot = false;
    let reconciliationNotice = "";
    const active = () =>
      !disposed && epoch === liveGeneration.current && !authRef.current;
    const publishSocket = (socket: WebSocket) => {
      const root = testHooks();
      if (root) root.__consoleSockets = [...(root.__consoleSockets ?? []), socket];
    };
    const forgetSocket = (socket: WebSocket) => {
      const root = testHooks();
      if (root?.__consoleSockets === undefined) return;
      root.__consoleSockets = root.__consoleSockets.filter(
        (candidate) => candidate !== socket,
      );
      if (root.__consoleSockets.length === 0) root.__consoleSockets = [];
    };
    const chooseRoom = (list: RoomInfo[]) => {
      if (!roomRef.current || !list.some((room) => room.id === roomRef.current)) {
        roomRef.current = list[0]?.id ?? null;
        setCurrentRoom(roomRef.current);
      }
      return roomRef.current;
    };
    /**
     * Where each unopened room's history ends when the feed first opens, so a
     * reconnect can tell which of them gained messages while it was down.
     */
    const seedCursors = (list: RoomInfo[], room: string | null) =>
      Promise.allSettled(
        list
          .filter(({ id }) => id !== room && !cursors.current.has(id))
          .map(async ({ id }) => {
            const payload = await call(
              `/api/channels/${encodeURIComponent(id)}/messages?newest=1&limit=1`,
            );
            const latest = (payload.messages as RoomMessage[]).at(-1)?.id ?? 0;
            cursors.current.set(id, Math.max(cursors.current.get(id) ?? 0, latest));
          }),
      );
    /** Channels, agents, profile, and the room transcript; `null` when channels failed. */
    const loadSnapshots = async (): Promise<RoomInfo[] | null> => {
      try {
        const list = await refreshChannels();
        if (!active()) return list;
        const room = chooseRoom(list);
        void refreshAgents().catch((error) =>
          showNotice(error instanceof Error ? error.message : String(error)),
        );
        // Names and avatars come with the first snapshot, so a reload draws
        // the operator's chosen name rather than the wire author.
        void refreshProfile().catch(() => {});
        if (room) await refreshMessages(room);
        else {
          setMessages([]);
          setStatus("empty");
          setStatusDetail("");
        }
        if (active()) hasSnapshot = true;
        return list;
      } catch (error) {
        if (!active() || error === AUTHENTICATION_REQUIRED) return null;
        setStatus(error instanceof TypeError ? "offline" : "load-failure");
        setStatusDetail(error instanceof Error ? error.message : String(error));
        return null;
      }
    };
    const bootstrap = loadSnapshots();
    const reconcileUnread = async (list: RoomInfo[]) => {
      const rooms = list.filter(
        (room) => room.id !== roomRef.current && cursors.current.has(room.id),
      );
      const results = await Promise.allSettled(
        rooms.map(async (room) => {
          const cursor = cursors.current.get(room.id);
          if (cursor === undefined) return null;
          const payload = await call(
            `/api/channels/${encodeURIComponent(room.id)}/messages?afterId=${cursor}&limit=1`,
            { headers: { "X-Reconcile": "1" } },
          );
          if (!active() || room.id === roomRef.current) return null;
          const rows = payload.messages as RoomMessage[];
          const latest = rows.at(-1)?.id;
          const currentCursor = cursors.current.get(room.id);
          if (
            latest === undefined ||
            currentCursor === undefined ||
            latest <= currentCursor
          )
            return null;
          return room.id;
        }),
      );
      if (!active()) return;
      const failed = results.flatMap((result, index) =>
        result.status === "rejected" ? [rooms[index].id] : [],
      );
      const changed = results.flatMap((result) =>
        result.status === "fulfilled" && result.value !== null
          ? [result.value]
          : [],
      );
      setUnread((previous) => {
        const next = new Set(previous);
        for (const room of changed) if (room !== roomRef.current) next.add(room);
        return next;
      });
      if (failed.length > 0) {
        reconciliationNotice = `Could not check unread activity in ${failed.join(", ")}.`;
        showNotice(reconciliationNotice);
      } else if (reconciliationNotice) {
        const previousNotice = reconciliationNotice;
        reconciliationNotice = "";
        setNotice((current) => (current === previousNotice ? "" : current));
      }
    };
    /** A message posted between the bootstrap read and the socket opening. */
    const catchUp = async (room: string) => {
      const cursor = cursors.current.get(room);
      if (cursor === undefined) return refreshMessages(room);
      const payload = await call(
        `/api/channels/${encodeURIComponent(room)}/messages?afterId=${cursor}&limit=1`,
      );
      if ((payload.messages as RoomMessage[]).length > 0)
        await refreshMessages(room, true);
    };
    const reconcileOpen = async () => {
      // A failed bootstrap left nothing to reconcile against, so the socket
      // opening is the cue to load everything again, keeping the requested room.
      const reload = !hasSnapshot;
      const list = reload
        ? await loadSnapshots()
        : opened
          ? await refreshChannels().catch((error) => {
              showError(error);
              return channelsRef.current;
            })
          : await bootstrap;
      if (!active() || list === null) return;
      const room = chooseRoom(list);
      await Promise.allSettled([
        ...(opened && !reload ? [refreshAgents(), refreshProfile()] : []),
        ...(opened ? [] : [seedCursors(list, room)]),
        reconcileUnread(list),
        ...(room && !reload
          ? [opened ? refreshMessages(room, true) : catchUp(room)]
          : []),
      ]);
      if (!active()) return;
      const root = testHooks();
      if (root)
        root.__consoleReconcilePasses = (root.__consoleReconcilePasses ?? 0) + 1;
      opened = true;
    };
    const showError = (error: unknown) => {
      if (active() && error !== AUTHENTICATION_REQUIRED)
        showNotice(error instanceof Error ? error.message : String(error));
    };
    const connect = async () => {
      if (!active()) return;
      try {
        const url = new URL("/api/events", location.origin);
        url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
        if (auth.remoteMode) {
          const result = await call("/api/ws-ticket", { method: "POST" });
          url.searchParams.set("ticket", String(result.ticket));
        } else url.searchParams.set("token", auth.token);
        if (!active()) return;
        const ws = new WebSocket(url);
        socketRef.current = ws;
        publishSocket(ws);
        ws.onopen = () => {
          if (!active() || socketRef.current !== ws) return;
          setConnected(true);
          attempt = 0;
          setNotice((current) => (current === RESTART_HINT ? "" : current));
          void reconcileOpen().catch(showError);
        };
        ws.onmessage = (event) => {
          if (!active() || socketRef.current !== ws) return;
          let frame: Record<string, unknown>;
          try {
            frame = JSON.parse(String(event.data));
          } catch {
            return;
          }
          if (frame.type === "message") {
            const message = frame.message as Partial<RoomMessage>;
            if (typeof message.room !== "string") return;
            const last = cursors.current.get(message.room) ?? 0;
            if (typeof message.id === "number")
              cursors.current.set(message.room, Math.max(last, message.id));
            if (message.room === roomRef.current)
              void refreshMessages(message.room);
            else if (typeof message.id !== "number" || message.id > last)
              setUnread((previous) => new Set(previous).add(message.room as string));
          } else if (
            frame.type === "reaction" &&
            frame.room === roomRef.current
          )
            void refreshMessages(
              String(frame.room),
              false,
              typeof frame.messageId === "number" ? frame.messageId : undefined,
            );
          else if (frame.type === "channel")
            void refreshChannels().catch(showError);
          else if (
            ["agent", "definition", "membership", "schedule"].includes(
              String(frame.type),
            )
          )
            void refreshAgents().catch(showError);
          else if (frame.type === "profile") void refreshProfile().catch(showError);
          else if (frame.type === "plan")
            setWorkspaceVersion((version) => version + 1);
          else if (frame.type === "chat" && typeof frame.chatId === "string") {
            // Token deltas come one frame each. Only a finished turn can
            // change artifacts; the chat itself refetches at most once per
            // interval, and only where that chat is open.
            const event = frame.event as { type?: unknown } | undefined;
            if (event?.type === "agent_end")
              setWorkspaceVersion((version) => version + 1);
            dirtyChats.current.add(frame.chatId);
            chatFlush.current ??= setTimeout(() => {
              chatFlush.current = undefined;
              const dirty = [...dirtyChats.current];
              dirtyChats.current.clear();
              setChatVersions((previous) => {
                const next = { ...previous };
                for (const id of dirty) next[id] = (next[id] ?? 0) + 1;
                return next;
              });
            }, CHAT_REFRESH_MS);
          }
        };
        ws.onclose = () => {
          forgetSocket(ws);
          if (socketRef.current === ws) socketRef.current = null;
          if (!active()) return;
          setConnected(false);
          if (!hasSnapshot) {
            setStatus("offline");
            setStatusDetail("Connection lost. Reconnecting automatically.");
          }
          scheduleReconnect();
        };
        ws.onerror = () => ws.close();
      } catch (error) {
        if (!active()) return;
        setConnected(false);
        if (!hasSnapshot) {
          setStatus("offline");
          setStatusDetail(error instanceof Error ? error.message : String(error));
        }
        scheduleReconnect();
      }
    };
    const scheduleReconnect = () => {
      timer = setTimeout(
        () => void connect(),
        Math.min(5000, 200 * 2 ** attempt++),
      );
      if (attempt === RESTART_HINT_ATTEMPTS) showNotice(RESTART_HINT);
    };
    void bootstrap.then(() => connect());
    return () => {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(chatFlush.current);
      chatFlush.current = undefined;
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket) {
        forgetSocket(socket);
        socket.close();
      }
    };
  }, [
    auth,
    authRequired,
    generation,
    call,
    refreshAgents,
    refreshChannels,
    refreshMessages,
    refreshProfile,
    showNotice,
  ]);

  const authenticate = async (token: string) => {
    setAuthError("");
    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "X-Operator-Token": token },
      });
      if (!response.ok)
        throw new Error("Operator token refused. Re-enter the token.");
      const payload = await response.json();
      sessionStorage.setItem("oh-my-agent.operator-token", token);
      location.replace(`/?ticket=${encodeURIComponent(payload.ticket)}`);
    } catch (error) {
      const failure =
        error instanceof Error ? error : new Error("Authentication unavailable.");
      sessionStorage.removeItem("oh-my-agent.operator-token");
      setAuthError(failure.message);
      throw failure;
    }
  };
  const send = async (body: string, parentId: number | null = null) => {
    const room = roomRef.current;
    if (!room) throw new Error("Select a room first.");
    await call(`/api/channels/${encodeURIComponent(room)}/messages`, {
      method: "POST",
      body: { body, author: "@you", parentId },
    });
    if (roomRef.current === room) await refreshMessages(room);
  };
  const react = async (id: number, emoji: string) => {
    await call(`/api/messages/${id}/reactions/toggle`, {
      method: "POST",
      body: { emoji },
    });
    if (roomRef.current) await refreshMessages(roomRef.current, false, id);
  };
  return {
    channels,
    agents,
    messages,
    currentRoom,
    unread,
    status,
    statusDetail,
    notice,
    connected,
    authRequired,
    authError,
    authenticate,
    call,
    showNotice,
    refreshAgents,
    refreshChannels,
    profile,
    setProfile,
    selectRoom,
    send,
    react,
    workspaceVersion,
    chatVersions,
    hasOlder,
    loadingOlder,
    loadOlder,
    retry: () => setGeneration((n) => n + 1),
  };
}
