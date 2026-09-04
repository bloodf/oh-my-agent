import {
  Hash,
  MessageSquare,
  Plus,
  Search,
  Bot,
  PanelLeftClose,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import type { RoomInfo } from "@/lib/types";
export interface ChatSummary {
  id: string;
  title: string;
  cwd: string;
}
export function ChannelRail({
  rooms,
  chats,
  current,
  unread,
  onSelectRoom,
  onSelectChat,
  onNewChat,
  onNewRoom,
  onNewAgent,
  onSearch,
  onClose,
  connected,
}: {
  rooms: RoomInfo[];
  chats: ChatSummary[];
  current: string | null;
  unread: Set<string>;
  onSelectRoom: (id: string) => void;
  onSelectChat: (id: string) => void;
  onNewChat: () => void;
  onNewRoom: () => void;
  onNewAgent: () => void;
  onSearch: () => void;
  onClose?: () => void;
  connected: boolean;
}) {
  return (
    <nav
      id="sidebar"
      aria-label="Conversations"
      className="flex h-full w-[232px] shrink-0 flex-col bg-sidebar text-sidebar-foreground"
    >
      <div className="flex h-16 items-center gap-2 px-4">
        <span className="flex size-7 items-center justify-center rounded-lg border bg-background font-mono text-sm text-primary">
          o
        </span>
        <span className="font-semibold tracking-tight">oh-my-agent</span>
        {onClose && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            onClick={onClose}
            aria-label="Close navigation"
          >
            <PanelLeftClose />
          </Button>
        )}
      </div>
      <div className="grid gap-2 px-3 pb-4">
        <Button
          variant="outline"
          className="justify-start bg-transparent text-muted-foreground"
          onClick={onSearch}
        >
          <Search className="size-4" />
          Find anything<kbd className="ml-auto text-xs">⌘K</kbd>
        </Button>
        <Button onClick={onNewChat} className="justify-start">
          <Plus className="size-4" />
          New chat
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-2">
          <p className="px-2 py-2 text-xs font-medium text-muted-foreground">
            Chats
          </p>
          {chats.length === 0 && (
            <p className="px-2 pb-4 text-xs leading-relaxed text-muted-foreground">
              Start a conversation in any workspace.
            </p>
          )}
          {chats.map((chat) => (
            <Button
              key={chat.id}
              variant="ghost"
              className={`mb-0.5 w-full justify-start font-normal ${current === chat.id ? "bg-sidebar-accent text-foreground" : "text-muted-foreground"}`}
              onClick={() => onSelectChat(chat.id)}
            >
              <MessageSquare className="size-4 shrink-0" />
              <span className="truncate">{chat.title}</span>
            </Button>
          ))}
          <div className="mt-3 flex items-center justify-between px-2">
            <p className="text-xs font-medium text-muted-foreground">
              Rooms & direct messages
            </p>
            <Button
              id="open-new-channel"
              size="icon-xs"
              variant="ghost"
              aria-label="Create channel"
              onClick={onNewRoom}
            >
              <Plus />
            </Button>
          </div>
          <ul
            id="channels"
            role="listbox"
            aria-label="Channels"
            className="mt-1 space-y-0.5"
          >
            {rooms.map((room) => (
              <li key={room.id} role="presentation">
                <Button
                  role="option"
                  aria-selected={current === room.id}
                  data-id={room.id}
                  tabIndex={current === room.id || (!rooms.some(item => item.id === current) && rooms[0]?.id === room.id) ? 0 : -1}
                  onKeyDown={event => {
                    const index = rooms.findIndex(item => item.id === room.id);
                    const next = event.key === "ArrowDown" ? (index + 1) % rooms.length : event.key === "ArrowUp" ? (index + rooms.length - 1) % rooms.length : event.key === "Home" ? 0 : event.key === "End" ? rooms.length - 1 : -1;
                    if (next < 0) return;
                    event.preventDefault();
                    const target = rooms[next];
                    if (target) event.currentTarget.closest("ul")?.querySelector<HTMLButtonElement>(`[data-id="${CSS.escape(target.id)}"]`)?.focus();
                  }}
                  variant="ghost"
                  className={`channel w-full justify-start font-normal ${current === room.id ? "active bg-sidebar-accent text-foreground" : "text-muted-foreground"} ${unread.has(room.id) ? "unread font-semibold text-foreground" : ""}`}
                  onClick={() => onSelectRoom(room.id)}
                >
                  {room.kind === "dm" ? (
                    <MessageSquare className="size-4 shrink-0" />
                  ) : (
                    <Hash className="size-4 shrink-0" />
                  )}
                  <span className="truncate">{room.name ?? room.id}</span>
                  {unread.has(room.id) && (
                    <span
                      aria-label="Unread messages"
                      className="ml-auto size-1.5 shrink-0 rounded-full bg-primary"
                    />
                  )}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      </ScrollArea>
      <div className="p-3">
        <Button
          id="open-new-agent"
          variant="ghost"
          className="w-full justify-start text-muted-foreground"
          onClick={onNewAgent}
        >
          <Bot />
          Create agent
        </Button>
      </div>
      <Separator />
      <div className="flex items-center gap-2 px-4 py-4 text-xs text-muted-foreground">
        <span
          className={`size-1.5 rounded-full ${connected ? "bg-primary" : "bg-muted-foreground"}`}
        />
        {connected ? "Connected to daemon" : "Connecting to daemon"}
        <span className="ml-auto font-mono">OMP</span>
      </div>
    </nav>
  );
}
