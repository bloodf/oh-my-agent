import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, AUTHENTICATION_REQUIRED, readToken } from "@/lib/api";
import type {
  AgentInfo,
  ConsoleStateKind,
  RoomInfo,
  RoomMessage,
} from "@/lib/types";

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
          const root = globalThis as typeof globalThis & {
            __consoleSockets?: WebSocket[];
          };
          if (hadSocket || root.__consoleSockets !== undefined)
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
  const refreshChannels = useCallback(async () => {
    const payload = await call("/api/channels");
    const list = payload.channels as RoomInfo[];
    if (!authRef.current) setChannels(list);
    return list;
  }, [call]);
  const refreshMessages = useCallback(
    async (room: string, preserveOnFailure = false) => {
      const serial = ++requestSerial.current;
      try {
        const payload = await call(
          `/api/channels/${encodeURIComponent(room)}/messages?limit=500`,
        );
        if (
          serial !== requestSerial.current ||
          roomRef.current !== room ||
          authRef.current
        )
          return;
        const next = payload.messages as RoomMessage[];
        setMessages(next);
        cursors.current.set(
          room,
          Math.max(cursors.current.get(room) ?? 0, ...next.map((m) => m.id)),
        );
        setStatus(next.length ? null : "empty");
        setStatusDetail("");
      } catch (error) {
        if (
          error === AUTHENTICATION_REQUIRED ||
          serial !== requestSerial.current ||
          roomRef.current !== room ||
          preserveOnFailure
        )
          return;
        setStatus("load-failure");
        setStatusDetail(error instanceof Error ? error.message : String(error));
      }
    },
    [call],
  );
  const selectRoom = useCallback(
    (id: string) => {
      roomRef.current = id;
      setCurrentRoom(id);
      setMessages([]);
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
      const root = globalThis as typeof globalThis & {
        __consoleSockets?: WebSocket[];
      };
      root.__consoleSockets = [...(root.__consoleSockets ?? []), socket];
    };
    const forgetSocket = (socket: WebSocket) => {
      const root = globalThis as typeof globalThis & {
        __consoleSockets?: WebSocket[];
      };
      if (root.__consoleSockets === undefined) return;
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
    const loadSnapshots = async () => {
      try {
        const list = await refreshChannels();
        if (!active()) return list;
        const room = chooseRoom(list);
        void refreshAgents().catch((error) =>
          showNotice(error instanceof Error ? error.message : String(error)),
        );
        if (room) await refreshMessages(room);
        else {
          setMessages([]);
          setStatus("empty");
          setStatusDetail("");
        }
        if (active()) hasSnapshot = true;
        return list;
      } catch (error) {
        if (!active() || error === AUTHENTICATION_REQUIRED) return [];
        setStatus(error instanceof TypeError ? "offline" : "load-failure");
        setStatusDetail(error instanceof Error ? error.message : String(error));
        return [];
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
    const reconcileOpen = async () => {
      const list = opened
        ? await refreshChannels().catch((error) => {
            showError(error);
            return channelsRef.current;
          })
        : await bootstrap;
      if (!active()) return;
      const room = chooseRoom(list);
      await Promise.allSettled([
        ...(opened ? [refreshAgents()] : []),
        reconcileUnread(list),
        ...(room ? [refreshMessages(room, opened)] : []),
      ]);
      if (!active()) return;
      const root = globalThis as typeof globalThis & {
        __consoleReconcilePasses?: number;
      };
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
            void refreshMessages(String(frame.room));
          else if (frame.type === "channel")
            void refreshChannels().catch(showError);
          else if (
            ["agent", "definition", "membership", "budget", "schedule"].includes(
              String(frame.type),
            )
          )
            void refreshAgents().catch(showError);
          else if (frame.type === "chat" || frame.type === "plan")
            setWorkspaceVersion((version) => version + 1);
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
          timer = setTimeout(
            () => void connect(),
            Math.min(5000, 200 * 2 ** attempt++),
          );
        };
        ws.onerror = () => ws.close();
      } catch (error) {
        if (!active()) return;
        setConnected(false);
        if (!hasSnapshot) {
          setStatus("offline");
          setStatusDetail(error instanceof Error ? error.message : String(error));
        }
        timer = setTimeout(
          () => void connect(),
          Math.min(5000, 200 * 2 ** attempt++),
        );
      }
    };
    void bootstrap.then(() => connect());
    return () => {
      disposed = true;
      clearTimeout(timer);
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
    if (roomRef.current) await refreshMessages(roomRef.current);
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
    selectRoom,
    send,
    react,
    workspaceVersion,
    retry: () => setGeneration((n) => n + 1),
  };
}
