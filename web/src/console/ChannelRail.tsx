import { useState, type ReactNode } from "react";
import { Bot, ChevronDown, Hash, MessageSquare, PanelLeftClose, Plus, UserRoundPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { RoomInfo } from "@/lib/types";
export interface ChatSummary { id: string; title: string; cwd: string; }
export function ChannelRail({ rooms, chats, current, unread, onSelectRoom, onSelectChat, onNewChat, onNewRoom, onNewAgent, onNewBot, onClose, connected }: {
  rooms: RoomInfo[];
  chats: ChatSummary[];
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
}) {
  const [open, setOpen] = useState({ chats: true, channels: true, direct: true });
  const channels = rooms.filter((room) => room.kind !== "dm");
  const directMessages = rooms.filter((room) => room.kind === "dm");
  const roomRows = (items: RoomInfo[]) => items.map((room, index) => (
    <li key={room.id} role="presentation">
      <Button role="option" aria-selected={current === room.id} data-id={room.id} tabIndex={current === room.id || (!items.some((item) => item.id === current) && index === 0) ? 0 : -1} onKeyDown={(event) => {
        const next = event.key === "ArrowDown" ? (index + 1) % items.length : event.key === "ArrowUp" ? (index + items.length - 1) % items.length : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : -1;
        if (next < 0) return;
        event.preventDefault();
        const target = items[next];
        if (target) event.currentTarget.closest("ul")?.querySelector<HTMLButtonElement>(`[data-id="${CSS.escape(target.id)}"]`)?.focus();
      }} variant="ghost" size="sm" title={room.workspace ?? room.id} className={`channel w-full justify-start font-normal ${current === room.id ? "active bg-[var(--workspace-foreground)] text-[var(--workspace-bar)]" : "text-[var(--workspace-foreground)] hover:bg-[var(--workspace-accent)] hover:text-[var(--workspace-accent-foreground)]"} ${unread.has(room.id) ? "unread font-semibold text-[var(--workspace-foreground)]" : ""}`} onClick={() => onSelectRoom(room.id)}>
        {room.kind === "dm" ? <MessageSquare className="size-4 shrink-0" /> : <Hash className="size-4 shrink-0" />}
        <span className="truncate">{room.name ?? room.id}</span>
        {unread.has(room.id) && <span aria-label="Unread messages" className="ml-auto size-1.5 shrink-0 rounded-full bg-[var(--workspace-foreground)]" />}
      </Button>
    </li>
  ));
  const heading = (section: keyof typeof open, label: string, action?: ReactNode) => (
    <div className="rail-heading mt-2 flex items-center">
      <Button type="button" variant="ghost" size="sm" className="h-7 flex-1 justify-start px-1 text-xs font-semibold text-[var(--workspace-foreground)] aria-expanded:bg-transparent aria-expanded:text-[var(--workspace-foreground)] hover:bg-[var(--workspace-accent)] hover:text-[var(--workspace-accent-foreground)]" aria-expanded={open[section]} onClick={() => setOpen((value) => ({ ...value, [section]: !value[section] }))}>
        <ChevronDown className={`size-3.5 transition-transform ${open[section] ? "" : "-rotate-90"}`} />
        {label}
      </Button>
      {action}
    </div>
  );
  return (
    <nav id="sidebar" aria-label="Conversations" className="workspace-rail flex h-full w-[260px] shrink-0 flex-col bg-[var(--workspace-sidebar)] text-[var(--workspace-foreground)]">
      <div className="flex h-12 items-center gap-2 border-b border-[var(--workspace-border)] px-3">
        <span className="flex size-7 items-center justify-center rounded-md bg-[var(--workspace-foreground)] font-mono text-[10px] font-bold text-[var(--workspace-bar)]">OMA</span>
        <span className="min-w-0 flex-1 truncate font-semibold tracking-tight">oh-my-agent</span>
        {onClose && <Button variant="ghost" size="icon-sm" className="text-[var(--workspace-foreground)] hover:bg-[var(--workspace-accent)] hover:text-[var(--workspace-accent-foreground)]" onClick={onClose} aria-label="Close navigation"><PanelLeftClose /></Button>}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-2 py-2">
          {heading("chats", "OMP chats", <Button type="button" onClick={onNewChat} size="icon-xs" variant="ghost" className="text-[var(--workspace-foreground)] hover:bg-[var(--workspace-accent)] hover:text-[var(--workspace-accent-foreground)]" aria-label="New OMP chat"><Plus /></Button>)}
          {open.chats && <div>
            {chats.length === 0 && <p className="px-2 pb-2 text-xs leading-relaxed text-[var(--workspace-foreground)]">No independent chats yet.</p>}
            {chats.map((chat) => <Button key={chat.id} variant="ghost" size="sm" title={`${chat.title} · ${chat.cwd}`} className={`mb-0.5 w-full justify-start font-normal ${current === chat.id ? "bg-[var(--workspace-foreground)] text-[var(--workspace-bar)]" : "text-[var(--workspace-foreground)] hover:bg-[var(--workspace-accent)] hover:text-[var(--workspace-accent-foreground)]"}`} onClick={() => onSelectChat(chat.id)}><MessageSquare className="size-4 shrink-0" /><span className="truncate">{chat.title}</span></Button>)}
          </div>}
          {heading("channels", "Channels", <Button id="open-new-channel" type="button" size="icon-xs" variant="ghost" className="text-[var(--workspace-foreground)] hover:bg-[var(--workspace-accent)] hover:text-[var(--workspace-accent-foreground)]" aria-label="Create channel" onClick={onNewRoom}><Plus /></Button>)}
          {open.channels && <ul id="channels" role="listbox" aria-label="Channels" className="space-y-0.5">{roomRows(channels)}</ul>}
          {heading("direct", "Direct messages")}
          {open.direct && <ul role="listbox" aria-label="Direct messages" className="space-y-0.5">{roomRows(directMessages)}</ul>}
        </div>
      </ScrollArea>
      <div className="grid gap-0.5 border-t border-[var(--workspace-border)] px-2 py-2">
        <Button id="open-new-agent" variant="ghost" size="sm" className="w-full justify-start text-[var(--workspace-foreground)] hover:bg-[var(--workspace-accent)] hover:text-[var(--workspace-accent-foreground)]" onClick={onNewAgent}><UserRoundPlus />Create agent</Button>
        <Button id="open-new-bot" variant="ghost" size="sm" className="w-full justify-start text-[var(--workspace-foreground)] hover:bg-[var(--workspace-accent)] hover:text-[var(--workspace-accent-foreground)]" onClick={onNewBot}><Bot />Create automated bot</Button>
      </div>
      <div className="flex items-center gap-2 border-t border-[var(--workspace-border)] px-3 py-2.5 text-[11px] text-[var(--workspace-foreground)]"><span className={`size-2 rounded-full ${connected ? "bg-[var(--workspace-foreground)]" : "bg-[var(--workspace-foreground)]/40"}`} />{connected ? "Daemon connected" : "Daemon reconnecting"}<span className="ml-auto font-mono">OMP</span></div>
    </nav>
  );
}
