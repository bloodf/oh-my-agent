import { useEffect, useRef, useState } from "react";
import { Bot, Folder, Menu, Plus, Square, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { readToken } from "@/lib/api";
import type { RoomMessage } from "@/lib/types";
import type {
  WebChatInfo,
  WebChatState,
  WebChatMessage,
  WebChatModel,
} from "../../../src/shared/web-workspace";
import { useConsole } from "./useConsole";
import { ChannelRail } from "./ChannelRail";
import { Composer } from "./Composer";
import { Transcript } from "./Transcript";
import { ThreadPanel } from "./ThreadPanel";
import { AgentPanel } from "./AgentPanel";
import { CreateChannelDialog } from "./CreateChannelDialog";
import { CreateAgentDialog } from "./CreateAgentDialog";
import { AuthScreen } from "./AuthScreen";
import { FilePicker } from "./FilePicker";
import { PlansView } from "./PlansView";
import { ChangesView } from "./ChangesView";

/** Conversation-first frame. Native chats and shared rooms have separate lifecycles. */
export function ConsoleShell() {
  const c = useConsole();
  const { call, authRequired, connected, workspaceVersion } = c;
  const [chats, setChats] = useState<WebChatInfo[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [chatState, setChatState] = useState<WebChatState | null>(null);
  const [chatMessages, setChatMessages] = useState<WebChatMessage[]>([]);
  const [models, setModels] = useState<WebChatModel[]>([]);
  const [fullControl, setFullControl] = useState(false);
  const [view, setView] = useState("conversation");
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [newRoom, setNewRoom] = useState(false);
  const [newAgent, setNewAgent] = useState(false);
  const [newChat, setNewChat] = useState(false);
  const [search, setSearch] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [thread, setThread] = useState<number | null>(null);
  const [cwd, setCwd] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [picker, setPicker] = useState<"attachment" | "workspace" | null>(null);
  const pickResolve = useRef<((paths: string[]) => void) | null>(null);
  const selectedChat = chats.find((chat) => chat.id === chatId);
  const selected = chatId ?? c.currentRoom;
  useEffect(() => {
    if (authRequired || !connected) return;
    let stale = false;
    void call("/api/capabilities")
      .then(async (capabilities) => {
        if (stale) return;
        setFullControl(capabilities.fullControl === true);
        if (capabilities.fullControl) {
          const result = await call("/api/chats");
          if (!stale) setChats(result.chats as WebChatInfo[]);
        }
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [call, authRequired, connected]);
  useEffect(() => {
    if (!chatId) return;
    let stale = false;
    void Promise.all([
      call(`/api/chats/${chatId}/state`),
      call(`/api/chats/${chatId}/messages`),
      call(`/api/chats/${chatId}/models`),
    ])
      .then(([state, messages, catalog]) => {
        if (stale) return;
        setChatState(state.state as WebChatState);
        setChatMessages(messages.messages as WebChatMessage[]);
        setModels(catalog.models as WebChatModel[]);
        setError("");
      })
      .catch((e) => {
        if (!stale) setError(String(e));
      });
    return () => {
      stale = true;
    };
  }, [chatId, call, workspaceVersion]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearch((v) => !v);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);
  const selectRoom = (id: string) => {
    setChatId(null);
    setThread(null);
    setView("conversation");
    setMobileNav(false);
    c.selectRoom(id);
  };
  const selectChat = (id: string) => {
    setChatId(id);
    setChatState(null);
    setChatMessages([]);
    setThread(null);
    setView("conversation");
    setMobileNav(false);
  };
  const pickFiles = () =>
    new Promise<string[]>((resolve) => {
      pickResolve.current = resolve;
      setPicker("attachment");
    });
  const pasteImage = async (file: File) => {
    const { token } = readToken();
    const data = new FormData();
    data.set("image", file);
    const response = await fetch("/api/clipboard", {
      method: "POST",
      headers: { "X-Operator-Token": token },
      body: data,
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(
        result.error?.message ?? "Clipboard image could not be saved",
      );
    return String(result.path);
  };
  const send = async (
    body: string,
    paths: string[],
    parentId: number | null = null,
  ) => {
    if (chatId) {
      await c.call(`/api/chats/${chatId}/prompt`, {
        method: "POST",
        body: { message: body, paths },
      });
      return;
    }
    await c.send(
      body +
        (paths.length
          ? `\n\nAttached local files (read with your tools):\n${paths.map((p) => JSON.stringify(p)).join("\n")}`
          : ""),
      parentId,
    );
  };
  const renderedChat: RoomMessage[] = chatMessages.map((message, index) => ({
    id: index + 1,
    room: chatId ?? "",
    author:
      message.role === "user"
        ? "@you"
        : message.role === "assistant"
          ? "OMP"
          : "system",
    body:
      typeof message.content === "string"
        ? message.content
        : message.content
            .map(
              (part) =>
                part.text ??
                part.thinking ??
                (part.type === "toolCall"
                  ? `Using ${part.name ?? "tool"}`
                  : ""),
            )
            .filter(Boolean)
            .join("\n"),
    createdAt: message.timestamp ?? 0,
    parentId: null,
    threadRootId: null,
    replyCount: 0,
    reactions: [],
  }));
  const rail = (
    <ChannelRail
      rooms={c.channels}
      chats={chats}
      current={selected}
      unread={c.unread}
      onSelectRoom={selectRoom}
      onSelectChat={selectChat}
      onNewChat={() => {
        setMobileNav(false);
        setNewChat(true);
      }}
      onNewRoom={() => setNewRoom(true)}
      onNewAgent={() => setNewAgent(true)}
      onSearch={() => setSearch(true)}
      connected={c.connected}
    />
  );
  return (
    <>
    {c.authRequired && <AuthScreen onAuthenticate={c.authenticate} error={c.authError} />}
    <div hidden={c.authRequired} inert={c.authRequired} className="console-shell flex h-svh overflow-hidden bg-background text-foreground">
      {!c.authRequired && <section id="operator-auth" hidden aria-label="Operator authentication" />}
      <a href="#composer-input" className="skip-link">
        Skip to composer
      </a>
      <div className="hidden border-r md:block">{rail}</div>
      <main id="main" hidden={c.authRequired} className="flex min-w-0 flex-1 flex-col">
        <header
          id="current-channel"
          role="banner"
          className="flex min-h-16 items-center gap-3 border-b px-4 md:px-6"
        >
          <Button
            className="md:hidden"
            variant="ghost"
            size="icon-sm"
            aria-label="Open navigation"
            onClick={() => setMobileNav(true)}
          >
            <Menu />
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold">
              {selectedChat?.title ?? c.currentRoom ?? "Your workspace"}
            </h1>
            <p className="truncate text-xs text-muted-foreground">
              {selectedChat?.cwd ?? "A shared space for you and your agents"}
            </p>
          </div>
          {chatId ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="max-w-[40%]">
                  <span className="truncate">
                    {chatState?.model?.id ?? "Choose model"}
                  </span>
                  <ChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="max-h-80 overflow-y-auto">
                {models.map((model) => (
                  <DropdownMenuItem
                    key={`${model.provider}/${model.id}`}
                    onSelect={() => {
                      void c
                        .call(`/api/chats/${chatId}/model`, {
                          method: "POST",
                          body: { provider: model.provider, modelId: model.id },
                        })
                        .then(() =>
                          setChatState((s) => (s ? { ...s, model } : s)),
                        )
                        .catch((e) => setError(String(e)));
                    }}
                  >
                    {model.provider} / {model.id}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Button
              id="open-agents"
              variant="outline"
              size="sm"
              onClick={() => setAgentsOpen(true)}
            >
              <Bot />
              <span className="hidden sm:inline">Agents</span>
              <Badge variant="secondary">{c.agents.length}</Badge>
            </Button>
          )}
        </header>
        <div className="flex items-center justify-between border-b px-4 py-2 md:px-6">
          <Tabs value={view} onValueChange={setView}>
            <TabsList variant="line">
              <TabsTrigger value="conversation">Conversation</TabsTrigger>
              <TabsTrigger value="plans">Plans</TabsTrigger>
              <TabsTrigger value="changes" disabled={!fullControl}>
                Changes
              </TabsTrigger>
            </TabsList>
          </Tabs>
          {chatState?.streaming && (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void c
                  .call(`/api/chats/${chatId}/abort`, { method: "POST" })
                  .catch((e) => setError(String(e)))
              }
            >
              <Square />
              Stop
            </Button>
          )}
        </div>
        <p
          id="notice"
          role="status"
          className={
            c.notice
              ? "border-b px-6 py-2 text-xs text-muted-foreground"
              : "sr-only"
          }
        >
          {c.notice}
        </p>
        {error && (
          <p role="alert" className="px-6 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex min-h-0 flex-1">
          {view === "conversation" ? (
            <>
              <div className="flex min-w-0 flex-1 flex-col">
                <Transcript
                  interactive={!chatId}
                  messages={chatId ? renderedChat : c.messages}
                  status={
                    chatId
                      ? chatState
                        ? renderedChat.length
                          ? null
                          : "empty"
                        : "connecting"
                      : c.status
                  }
                  statusDetail={c.statusDetail}
                  currentRoom={selectedChat?.title ?? c.currentRoom}
                  onThread={(id) => {
                    if (!chatId) setThread(id);
                  }}
                  onReact={c.react}
                  onRetry={c.retry}
                />
                <Composer
                  roomKey={selected ?? "empty"}
                  onSend={send}
                  disabled={!selected}
                  supportsAttachments={fullControl}
                  onPickFiles={pickFiles}
                  onPasteImage={pasteImage}
                />
              </div>
              {!chatId && (
                <ThreadPanel
                  root={c.messages.find((m) => m.id === thread) ?? null}
                  messages={c.messages.filter((m) => m.threadRootId === thread)}
                  onClose={() => setThread(null)}
                  onReact={c.react}
                  onSend={(body, paths) => send(body, paths, thread)}
                  onPickFiles={pickFiles}
                  onPasteImage={pasteImage}
                />
              )}
            </>
          ) : view === "plans" ? (
            chatId ? (
              <div className="w-full overflow-y-auto p-6">
                <h2 className="mb-4 text-lg font-semibold">Session plan</h2>
                {chatState?.todoPhases.length ? (
                  chatState.todoPhases.map((phase) => (
                    <section
                      key={phase.name}
                      className="mb-4 rounded-lg border p-4"
                    >
                      <h3 className="mb-3 font-medium">{phase.name}</h3>
                      {phase.tasks.map((task) => (
                        <div
                          key={task.content}
                          className="flex items-start gap-3 py-2 text-sm"
                        >
                          <Badge variant="outline">
                            {task.status.replaceAll("_", " ")}
                          </Badge>
                          <p>{task.content}</p>
                        </div>
                      ))}
                    </section>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">
                    OMP's plan will appear here when the session creates one.
                  </p>
                )}
              </div>
            ) : c.currentRoom ? (
              <PlansView
                room={c.currentRoom}
                call={c.call}
                version={c.workspaceVersion}
              />
            ) : null
          ) : (
            <div className="flex min-w-0 flex-1 flex-col">
              {!selectedChat && (
                <div className="flex gap-2 border-b p-3">
                  <Input
                    aria-label="Repository workspace"
                    value={cwd}
                    onChange={(e) => setCwd(e.target.value)}
                    placeholder="Absolute workspace path"
                  />
                  <Button
                    variant="outline"
                    onClick={() => setPicker("workspace")}
                  >
                    <Folder />
                    Browse
                  </Button>
                </div>
              )}
              {selectedChat?.cwd || cwd ? (
                <ChangesView cwd={selectedChat?.cwd ?? cwd} call={c.call} />
              ) : (
                <p className="p-6 text-sm text-muted-foreground">
                  Choose a workspace to inspect its real Git changes.
                </p>
              )}
            </div>
          )}
        </div>
      </main>
      <Sheet open={mobileNav} onOpenChange={setMobileNav}>
        <SheetContent side="left" className="w-[260px] p-0">
          <SheetTitle className="sr-only">Conversations</SheetTitle>
          <SheetDescription className="sr-only">
            Switch rooms and chats
          </SheetDescription>
          {mobileNav && rail}
        </SheetContent>
      </Sheet>
      <AgentPanel
        open={agentsOpen}
        onOpenChange={setAgentsOpen}
        agents={c.agents}
        currentRoom={c.currentRoom}
        call={c.call}
        onRefresh={c.refreshAgents}
        onNotice={c.showNotice}
        onDirectMessage={async (name) => {
          const room = `@${name}`;
          await c.call("/api/channels", { method: "POST", body: { id: room } });
          const stopped = c.agents.find(agent => agent.name === name)?.state === "stopped";
          await c.call(`/api/agents/${encodeURIComponent(name)}/rooms`, {
            method: "POST",
            body: { room },
          });
          await Promise.all([c.refreshChannels(), c.refreshAgents()]);
          selectRoom(room);
          setAgentsOpen(false);
          if (stopped) c.showNotice("This agent is stopped. Messages wait here until it starts.");
        }}
      />
      <CreateChannelDialog
        open={newRoom}
        onOpenChange={setNewRoom}
        call={c.call}
        onCreated={(id) => {
          void c.refreshChannels();
          selectRoom(id);
        }}
      />
      <CreateAgentDialog
        open={newAgent}
        onOpenChange={setNewAgent}
        call={c.call}
        onCreated={() => {
          void c.refreshAgents();
        }}
      />
      <Dialog open={newChat} onOpenChange={setNewChat}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New OMP chat</DialogTitle>
            <DialogDescription>
              Open OMP in a workspace. Chat history is temporary; your files
              stay where they are.
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              setCreating(true);
              setError("");
              void c
                .call("/api/chats", {
                  method: "POST",
                  body: { cwd, title: title || undefined },
                })
                .then((result) => {
                  const chat = result.chat as WebChatInfo;
                  setChats((prev) => [...prev, chat]);
                  selectChat(chat.id);
                  setNewChat(false);
                })
                .catch((e) => setError(String(e)))
                .finally(() => setCreating(false));
            }}
          >
            <Label htmlFor="chat-workspace">Workspace folder</Label>
            <div className="flex gap-2">
              <Input
                id="chat-workspace"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="/Users/you/project"
                required
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => setPicker("workspace")}
              >
                <Folder />
              </Button>
            </div>
            <Label htmlFor="chat-title">Chat title</Label>
            <Input
              id="chat-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What are we working on?"
            />
            {!fullControl && (
              <p className="text-sm text-destructive">
                Full OMP control is unavailable for this connection.
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button disabled={creating || !fullControl} type="submit">
              <Plus />
              {creating ? "Opening OMP…" : "Start chat"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={search} onOpenChange={setSearch}>
        <DialogContent className="p-0">
          <DialogHeader className="sr-only">
            <DialogTitle>Find a conversation</DialogTitle>
            <DialogDescription>
              Switch rooms, chats, or start something new
            </DialogDescription>
          </DialogHeader>
          <Command>
            <CommandInput placeholder="Search conversations or actions…" />
            <CommandList>
              <CommandEmpty>No matches.</CommandEmpty>
              <CommandGroup heading="Actions">
                <CommandItem
                  onSelect={() => {
                    setSearch(false);
                    setNewChat(true);
                  }}
                >
                  New chat
                </CommandItem>
                <CommandItem
                  onSelect={() => {
                    setSearch(false);
                    setNewRoom(true);
                  }}
                >
                  Create room
                </CommandItem>
                <CommandItem
                  onSelect={() => {
                    setSearch(false);
                    setAgentsOpen(true);
                  }}
                >
                  Manage agents
                </CommandItem>
              </CommandGroup>
              <CommandGroup heading="Conversations">
                {c.channels.map((room) => (
                  <CommandItem
                    key={room.id}
                    onSelect={() => {
                      selectRoom(room.id);
                      setSearch(false);
                    }}
                  >
                    {room.id}
                  </CommandItem>
                ))}
                {chats.map((chat) => (
                  <CommandItem
                    key={chat.id}
                    onSelect={() => {
                      selectChat(chat.id);
                      setSearch(false);
                    }}
                  >
                    {chat.title}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
      <FilePicker key={`${picker}:${selectedChat?.cwd ?? cwd}`} open={picker !== null}
      onOpenChange={(open) => {
        if (!open) {
          setPicker(null);
          pickResolve.current?.([]);
          pickResolve.current = null;
        }
      }}
      initialPath={selectedChat?.cwd ?? cwd}
      call={c.call}
      directoryOnly={picker === "workspace"}
      onPick={(path) => {
        if (picker === "workspace") setCwd(path);
        else {
          pickResolve.current?.([path]);
          pickResolve.current = null;
        }
        setPicker(null);
      }} />
    </div>
    </>
  );
}
