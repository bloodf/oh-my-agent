import { Bot, Hash, MessageSquare, PanelLeftClose, Plus, Search, UserRoundPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { RoomInfo } from "@/lib/types";
export interface ChatSummary { id: string; title: string; cwd: string; }
export function ChannelRail({ rooms, chats, current, unread, onSelectRoom, onSelectChat, onNewChat, onNewRoom, onNewAgent, onNewBot, onSearch, onClose, connected }: {
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
  onSearch: () => void;
  onClose?: () => void;
  connected: boolean;
}) {
  return (
    <nav id="sidebar" aria-label="Conversations" className="workspace-rail flex h-full w-[260px] shrink-0 flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-14 items-center gap-2 border-b border-sidebar-border px-3">
        <span className="flex size-7 items-center justify-center rounded-md bg-primary font-mono text-[10px] font-bold text-primary-foreground">OMA</span>
        <span className="font-semibold tracking-tight">oh-my-agent</span>
        {onClose && <Button variant="ghost" size="icon-sm" className="ml-auto" onClick={onClose} aria-label="Close navigation"><PanelLeftClose /></Button>}
      </div>
      <div className="grid gap-1.5 px-2 py-3">
        <Button variant="outline" size="sm" className="justify-start bg-sidebar-accent/40 text-sidebar-foreground" onClick={onSearch}><Search className="size-3.5" />Search<kbd className="ml-auto text-[10px] opacity-70">⌘K</kbd></Button>
        <Button onClick={onNewChat} size="sm" className="justify-start"><Plus />New OMP chat</Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-2">
          <div className="rail-heading"><span>OMP chats</span></div>
          {chats.length === 0 && <p className="px-2 pb-3 text-xs leading-relaxed text-sidebar-foreground/60">Independent sessions in a chosen working directory.</p>}
          {chats.map((chat) => <Button key={chat.id} variant="ghost" size="sm" title={`${chat.title} · ${chat.cwd}`} className={`mb-0.5 w-full justify-start font-normal ${current === chat.id ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground/70"}`} onClick={() => onSelectChat(chat.id)}><MessageSquare className="size-4 shrink-0" /><span className="truncate">{chat.title}</span></Button>)}
          <div className="rail-heading mt-3"><span>Channels & DMs</span><Button id="open-new-channel" size="icon-xs" variant="ghost" aria-label="Create channel" onClick={onNewRoom}><Plus /></Button></div>
          <ul id="channels" role="listbox" aria-label="Channels" className="space-y-0.5">
            {rooms.map((room) => <li key={room.id} role="presentation"><Button role="option" aria-selected={current === room.id} data-id={room.id} tabIndex={current === room.id || (!rooms.some((item) => item.id === current) && rooms[0]?.id === room.id) ? 0 : -1} onKeyDown={(event) => {
              const index = rooms.findIndex((item) => item.id === room.id);
              const next = event.key === "ArrowDown" ? (index + 1) % rooms.length : event.key === "ArrowUp" ? (index + rooms.length - 1) % rooms.length : event.key === "Home" ? 0 : event.key === "End" ? rooms.length - 1 : -1;
              if (next < 0) return; event.preventDefault(); const target = rooms[next]; if (target) event.currentTarget.closest("ul")?.querySelector<HTMLButtonElement>(`[data-id="${CSS.escape(target.id)}"]`)?.focus();
            }} variant="ghost" size="sm" title={room.workspace ?? room.id} className={`channel w-full justify-start font-normal ${current === room.id ? "active bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground/70"} ${unread.has(room.id) ? "unread font-semibold text-sidebar-foreground" : ""}`} onClick={() => onSelectRoom(room.id)}>{room.kind === "dm" ? <MessageSquare className="size-4 shrink-0" /> : <Hash className="size-4 shrink-0" />}<span className="truncate">{room.name ?? room.id}</span>{unread.has(room.id) && <span aria-label="Unread messages" className="ml-auto size-1.5 shrink-0 rounded-full bg-primary" />}</Button></li>)}
          </ul>
        </div>
      </ScrollArea>
      <div className="grid gap-0.5 border-t border-sidebar-border px-2 py-2">
        <Button id="open-new-agent" variant="ghost" size="sm" className="w-full justify-start text-sidebar-foreground/75" onClick={onNewAgent}><UserRoundPlus />Create agent</Button>
        <Button id="open-new-bot" variant="ghost" size="sm" className="w-full justify-start text-sidebar-foreground/75" onClick={onNewBot}><Bot />Create automated bot</Button>
      </div>
      <div className="flex items-center gap-2 border-t border-sidebar-border px-3 py-2.5 text-[11px] text-sidebar-foreground/65"><span className={`size-2 rounded-full ${connected ? "bg-emerald-400" : "bg-sidebar-foreground/40"}`} />{connected ? "Daemon connected" : "Daemon reconnecting"}<span className="ml-auto font-mono">OMP</span></div>
    </nav>
  );
}
