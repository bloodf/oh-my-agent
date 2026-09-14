import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { Bot, ChevronDown, MessageSquare, PanelLeftClose, Plus, Search, SquarePen, UserRoundPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { AgentInfo, RoomInfo } from "@/lib/types";
import { RESIZE_STEP, SIDEBAR, clampSidebar, readStoredWidth, storeWidth } from "@/lib/panel-size";
import { AvatarTile } from "./WorkspaceToolbar";

export interface ChatSummary { id: string; title: string; cwd: string; }

const PRESENCE: Record<string, string> = { running: "var(--presence-active)", parked: "var(--presence-parked)" };
/**
 * Pointer and keyboard resize grip for a panel edge. Drag writes go straight to the DOM
 * (rAF-throttled); only the committed width reaches React state and storage.
 */
export function PanelResizeHandle({ label, value, clamp, direction, apply, commit, reset, className = "" }: {
  label: string;
  value: number;
  clamp: (width: number) => number;
  /** 1 when dragging right grows the panel, -1 when dragging left does. */
  direction: 1 | -1;
  apply: (width: number) => void;
  commit: (width: number) => void;
  reset: () => void;
  className?: string;
}) {
  const drag = useRef<{ x: number; start: number; next: number; frame: number } | null>(null);
  const setNow = (handle: HTMLElement, width: number) => {
    apply(width);
    handle.setAttribute("aria-valuenow", String(width));
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, start: clamp(value), next: clamp(value), frame: 0 };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    state.next = clamp(state.start + (event.clientX - state.x) * direction);
    if (state.frame) return;
    const handle = event.currentTarget;
    state.frame = requestAnimationFrame(() => {
      state.frame = 0;
      setNow(handle, state.next);
    });
  };
  const end = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    drag.current = null;
    cancelAnimationFrame(state.frame);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setNow(event.currentTarget, state.next);
    commit(state.next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = clamp(value);
    const next =
      event.key === "ArrowLeft" ? current - RESIZE_STEP * direction
      : event.key === "ArrowRight" ? current + RESIZE_STEP * direction
      : event.key === "Home" ? clamp(0)
      : event.key === "End" ? clamp(Number.MAX_SAFE_INTEGER)
      : null;
    if (next === null) return;
    event.preventDefault();
    const width = clamp(next);
    setNow(event.currentTarget, width);
    commit(width);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={clamp(value)}
      aria-valuemin={clamp(0)}
      aria-valuemax={clamp(Number.MAX_SAFE_INTEGER)}
      tabIndex={0}
      title={`${label} · double-click to reset`}
      className={`panel-resize-handle group/resize absolute inset-y-0 z-10 w-1.5 cursor-col-resize touch-none outline-none select-none ${className}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
      onDoubleClick={reset}
    >
      <span aria-hidden className="pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-[var(--ws-active,var(--ring))] opacity-0 transition-opacity group-hover/resize:opacity-100 group-focus-visible/resize:opacity-100 group-active/resize:opacity-100" />
    </div>
  );
}

const matches = (query: string, ...values: (string | undefined)[]) => values.some((value) => value?.toLowerCase().includes(query));

export function ChannelRail({ rooms, chats, agents = [], current, unread, onSelectRoom, onSelectChat, onNewChat, onNewRoom, onNewAgent, onNewBot, onClose, connected, resizable = false }: {
  rooms: RoomInfo[];
  chats: ChatSummary[];
  agents?: AgentInfo[];
  current: string | null;
  unread: Set<string>;
  onSelectRoom: (id: string) => void;
  onSelectChat: (id: string) => void;
  onNewChat: () => void;
  onNewRoom: () => void;
  onNewAgent: () => void;
  onNewBot: () => void;
  onClose?: () => void;
  connected: boolean;
  /** Inline desktop sidebar: user-resizable, width persisted. The mobile drawer stays fixed. */
  resizable?: boolean;
}) {
  const navRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(() => readStoredWidth(SIDEBAR.key, SIDEBAR.fallback));
  const clampWidth = (next: number) => clampSidebar(next, window.innerWidth);
  const applyWidth = (next: number) => navRef.current?.style.setProperty("--sidebar-width", `${next}px`);
  const commitWidth = (next: number) => { setWidth(next); storeWidth(SIDEBAR.key, next); };
  const [open, setOpen] = useState({ chats: true, channels: true, direct: true });
  const [filter, setFilter] = useState("");
  const query = filter.trim().toLowerCase();
  const visibleRooms = query ? rooms.filter((room) => matches(query, room.name, room.id)) : rooms;
  const channels = visibleRooms.filter((room) => room.kind !== "dm");
  const directMessages = visibleRooms.filter((room) => room.kind === "dm");
  const visibleChats = query ? chats.filter((chat) => matches(query, chat.title, chat.cwd)) : chats;
  const nothing = query !== "" && channels.length + directMessages.length + visibleChats.length === 0;
  const roomRows = (items: RoomInfo[]) => items.map((room, index) => {
    const selected = current === room.id;
    const isUnread = unread.has(room.id);
    const label = (room.name ?? room.id).replace(/^[#@]/, "");
    const agentName = room.kind === "dm" ? label : "";
    return (
      <li key={room.id} role="presentation">
        <button type="button" role="option" aria-selected={selected} data-id={room.id} title={room.workspace ?? room.id} tabIndex={selected || (!items.some((item) => item.id === current) && index === 0) ? 0 : -1} onKeyDown={(event) => {
          const next = event.key === "ArrowDown" ? (index + 1) % items.length : event.key === "ArrowUp" ? (index + items.length - 1) % items.length : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : -1;
          if (next < 0) return;
          event.preventDefault();
          const target = items[next];
          if (target) event.currentTarget.closest("ul")?.querySelector<HTMLButtonElement>(`[data-id="${CSS.escape(target.id)}"]`)?.focus();
        }} className={`channel ws-row ${selected ? "active" : ""} ${isUnread ? "unread" : ""}`} onClick={() => onSelectRoom(room.id)}>
          {room.kind === "dm" ? (
            <AvatarTile author={agentName} className="size-5 text-[15px]">
              <span className="presence-dot" style={{ background: PRESENCE[agents.find((agent) => agent.name === agentName)?.state ?? ""] ?? "var(--presence-stopped)" }} />
            </AvatarTile>
          ) : (
            <span aria-hidden className="w-5 shrink-0 text-center text-[17px] leading-none opacity-80">{room.id.startsWith("#") ? "#" : ""}</span>
          )}
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {isUnread && <span aria-label="Unread messages" className="ws-badge size-2.5 h-2.5 min-w-2.5 px-0" />}
        </button>
      </li>
    );
  });
  const heading = (section: keyof typeof open, label: string) => (
    <div className="rail-heading group/heading mt-3 first:mt-1">
      <button type="button" className="ws-control -ml-0.5 flex h-7 min-w-0 items-center gap-1 px-1.5 text-[13px] font-semibold" aria-expanded={open[section]} onClick={() => setOpen((value) => ({ ...value, [section]: !value[section] }))}>
        <ChevronDown aria-hidden className={`size-3.5 transition-transform ${open[section] ? "" : "-rotate-90"}`} />
        {label}
      </button>
    </div>
  );
  const addRow = (label: string, onClick: () => void) => (
    <button type="button" className="ws-row mt-0.5 text-[15px]" onClick={onClick}>
      <span aria-hidden className="flex size-5 shrink-0 items-center justify-center rounded-md bg-[var(--ws-hover)]"><Plus className="size-3.5" /></span>
      <span className="truncate">{label}</span>
    </button>
  );
  return (
    <nav
      id="sidebar"
      ref={navRef}
      aria-label="Conversations"
      style={resizable ? ({ "--sidebar-width": `${width}px` } as CSSProperties) : undefined}
      className={`workspace-rail ws-sidebar-surface relative flex h-full shrink-0 flex-col ${resizable ? "w-[min(var(--sidebar-width),40vw)] min-w-[220px] max-w-[420px]" : "w-[260px]"}`}
    >
      <div className="flex h-[49px] shrink-0 items-center gap-1 pr-2 pl-3 shadow-[inset_0_-1px_0_var(--ws-border)]">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="ws-control flex h-8 min-w-0 items-center gap-1 px-1.5 text-[var(--ws-text)]" aria-label="Workspace menu">
              <span className="truncate text-[17px] font-black tracking-tight">oh-my-agent</span>
              <ChevronDown aria-hidden className="size-4 shrink-0" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuItem onSelect={onNewChat}><SquarePen />New OMP chat</DropdownMenuItem>
            <DropdownMenuItem onSelect={onNewRoom}><Plus />Create channel</DropdownMenuItem>
            <DropdownMenuItem onSelect={onNewAgent}><UserRoundPlus />Create agent</DropdownMenuItem>
            <DropdownMenuItem onSelect={onNewBot}><Bot />Create automated bot</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="flex-1" />
        <Button id="open-new-channel" type="button" variant="ws" size="icon-sm" className="rounded-md" aria-label="Create channel" title="Create channel" onClick={onNewRoom}><Plus /></Button>
        <Button type="button" variant="ws" size="icon-sm" className="rounded-md bg-[var(--ws-tile)] text-[var(--ws-tile-text)] hover:bg-[var(--ws-tile)] hover:text-[var(--ws-tile-text)] hover:opacity-90" aria-label="New OMP chat" title="New OMP chat" onClick={onNewChat}><SquarePen /></Button>
        {onClose && <Button type="button" variant="ws" size="icon-sm" className="rounded-md" onClick={onClose} aria-label="Close navigation"><PanelLeftClose /></Button>}
      </div>
      <div className="px-3 pt-2.5 pb-1">
        <label className="flex h-7 items-center gap-2 rounded-md border border-[var(--ws-border)] bg-[var(--ws-hover)] px-2 text-[var(--ws-text-dim)] transition-colors focus-within:bg-[var(--ws-hover-strong)] hover:bg-[var(--ws-hover-strong)]">
          <Search aria-hidden className="size-3.5 shrink-0" />
          <input type="search" value={filter} onChange={(event) => setFilter(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape" && filter) { event.stopPropagation(); setFilter(""); } }} placeholder="Find a conversation" aria-label="Find a conversation" className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-[var(--ws-text)] outline-none placeholder:text-[var(--ws-text-dim)] [&::-webkit-search-cancel-button]:hidden" />
        </label>
      </div>
      <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-thumb]]:bg-[var(--ws-hover-strong)]">
        <div className="px-2 pt-1 pb-3">
          {nothing && <p className="px-2.5 py-3 text-[13px] text-[var(--ws-text-dim)]">No conversations match “{filter.trim()}”.</p>}
          {heading("chats", "OMP chats")}
          {open.chats && <div className="grid gap-px">
            {chats.length === 0 && <p className="px-2.5 pb-1 text-[13px] leading-relaxed text-[var(--ws-text-dim)]">No independent chats yet.</p>}
            {visibleChats.map((chat) => <button type="button" key={chat.id} aria-current={current === chat.id ? "page" : undefined} title={`${chat.title} · ${chat.cwd}`} className={`ws-row ${current === chat.id ? "active" : ""}`} onClick={() => onSelectChat(chat.id)}><MessageSquare aria-hidden className="size-4 w-5 shrink-0 opacity-80" /><span className="truncate">{chat.title}</span></button>)}
            {!query && addRow("New OMP chat", onNewChat)}
          </div>}
          {heading("channels", "Channels")}
          {open.channels && <>
            <ul id="channels" role="listbox" aria-label="Channels" className="grid gap-px">{roomRows(channels)}</ul>
            {!query && addRow("Add channel", onNewRoom)}
          </>}
          {heading("direct", "Direct messages")}
          {open.direct && <ul role="listbox" aria-label="Direct messages" className="grid gap-px">{roomRows(directMessages)}</ul>}
        </div>
      </ScrollArea>
      <div className="grid gap-px px-2 py-2 shadow-[inset_0_1px_0_var(--ws-border)]">
        <button type="button" id="open-new-agent" className="ws-row" onClick={onNewAgent}><UserRoundPlus aria-hidden className="size-4 w-5 shrink-0" />Create agent</button>
        <button type="button" id="open-new-bot" className="ws-row" onClick={onNewBot}><Bot aria-hidden className="size-4 w-5 shrink-0" />Create automated bot</button>
      </div>
      <div className="flex h-9 shrink-0 items-center gap-2 px-4 text-[12px] text-[var(--ws-text-dim)] shadow-[inset_0_1px_0_var(--ws-border)]">
        <span aria-hidden className={`size-2 rounded-full ${connected ? "bg-[var(--presence-active)]" : "bg-[var(--presence-parked)] animate-pulse"}`} />
        {connected ? "Daemon connected" : "Daemon reconnecting"}
        <span className="ml-auto font-mono text-[11px] opacity-70">OMP</span>
      </div>
      {resizable && (
        <PanelResizeHandle
          label="Resize sidebar"
          value={width}
          clamp={clampWidth}
          direction={1}
          apply={applyWidth}
          commit={commitWidth}
          reset={() => { applyWidth(SIDEBAR.fallback); commitWidth(SIDEBAR.fallback); }}
          className="-right-[3px]"
        />
      )}
    </nav>
  );
}
