import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, Menu, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import type { AttachmentUpload } from "@/lib/attachments";
import type {
  AgentInfo,
  ConsoleStateKind,
  RoomInfo,
  RoomMessage,
} from "@/lib/types";
import { AgentPanel } from "./AgentPanel";
import { ArtifactsView } from "./ArtifactsView";
import { ChangesView } from "./ChangesView";
import { ChannelRail } from "./ChannelRail";
import { Composer } from "./Composer";
import { CreateAgentDialog } from "./CreateAgentDialog";
import { CreateChannelDialog, type ConsoleCall } from "./CreateChannelDialog";
import { PlansView } from "./PlansView";
import { ThreadPanel } from "./ThreadPanel";
import { Transcript } from "./Transcript";
import { WorkspaceNavigation, WorkspaceToolbar } from "./WorkspaceToolbar";

const NOW = Date.UTC(2026, 8, 4, 14, 30);
const ROOMS: RoomInfo[] = [
  { id: "#research", kind: "channel", name: "research", workspace: "/workspace/oh-my-agent" },
  { id: "#operations", kind: "channel", name: "operations", workspace: "/workspace/operations" },
  { id: "@reviewer", kind: "dm", name: "reviewer" },
];
const AGENTS: AgentInfo[] = [
  {
    name: "researcher",
    state: "running",
    account: "durindoor",
    rooms: ["#research", "#operations"],
  },
  {
    name: "reviewer",
    state: "parked",
    account: "durindoor",
    rooms: ["#research"],
  },
  {
    name: "release-bot",
    state: "stopped",
    account: "openai",
    rooms: ["#operations"],
    automation: { wakeRooms: true, schedules: ["0 9 * * 1-5"] },
  },
];
const MESSAGES: RoomMessage[] = [
  {
    id: 101,
    room: "#research",
    author: "researcher",
    body: "## Reproduction complete\nPaper 2314 fails on the clean fixture. The mismatch begins in `resolveWorkspace()`.\n\n```diff\n- return cachedRoot\n+ return discoveredRoot\n```",
    createdAt: NOW - 240_000,
    mentions: [],
    parentId: null,
    threadRootId: null,
    replyCount: 2,
    reactions: [
      { actor: "@you", emoji: "👀" },
      { actor: "reviewer", emoji: "👀" },
    ],
  },
  {
    id: 102,
    room: "#research",
    author: "@you",
    body: "Keep the fix narrow. Add the clean-worktree proof before handoff.",
    createdAt: NOW - 180_000,
    mentions: ["researcher"],
    parentId: null,
    threadRootId: null,
    replyCount: 0,
    reactions: [],
  },
  {
    id: 103,
    room: "#research",
    author: "reviewer",
    body: "Review queued. I will verify the cache invalidation boundary.",
    createdAt: NOW - 120_000,
    mentions: [],
    parentId: null,
    threadRootId: null,
    replyCount: 0,
    reactions: [{ actor: "@you", emoji: "✅" }],
  },
  {
    id: 104,
    room: "#research",
    author: "@you",
    body: "Does this also cover renamed worktrees?",
    createdAt: NOW - 90_000,
    mentions: [],
    parentId: 101,
    threadRootId: 101,
    replyCount: 0,
    reactions: [],
  },
  {
    id: 105,
    room: "#research",
    author: "researcher",
    body: "Yes. Rename and symlink fixtures both resolve to the canonical root.",
    createdAt: NOW - 60_000,
    mentions: [],
    parentId: 101,
    threadRootId: 101,
    replyCount: 0,
    reactions: [{ actor: "@you", emoji: "✅" }],
  },
];

const PLAN = {
  id: "plan-release",
  room: "#research",
  title: "Workspace resolver release",
  status: "active",
  revision: 3,
  body: "## Exit criteria\n- Clean-worktree reproduction passes\n- Rename behavior stays canonical\n- Reviewer accepts cache invalidation",
  author: "@you",
  updatedBy: "researcher",
  createdAt: NOW - 86_400_000,
  updatedAt: NOW - 300_000,
};
const DIFF =
  "diff --git a/src/workspace.ts b/src/workspace.ts\nindex 3b18b22..712c8a1 100644\n--- a/src/workspace.ts\n+++ b/src/workspace.ts\n@@ -18,2 +18,2 @@ export function resolveWorkspace(path: string) {\n-  return cachedRoot;\n+  return discoveredRoot;";

function useFixtureCall(): ConsoleCall {
  return useCallback(async (path, init) => {
    if (path.includes("/plans")) {
      if (init?.method === "POST")
        return { plan: { ...PLAN, id: "plan-new", ...(init.body as object) } };
      if (init?.method === "PATCH")
        return {
          plan: {
            ...PLAN,
            ...(init.body as object),
            revision: PLAN.revision + 1,
          },
        };
      return { plans: [PLAN] };
    }
    if (path === "/api/schedules")
      return {
        schedules: [
          { id: "researcher:heartbeat", agent: "researcher", cron: null, action: "Heartbeat. Read your rooms and plans and continue.", nextFireAt: NOW + 900_000, enabled: true },
          { id: "digest-bot:schedule:0", agent: "digest-bot", cron: "0 9 * * 1-5", action: "Post the daily digest.", nextFireAt: NOW + 3_600_000, enabled: false },
        ],
      };
    if (path === "/api/artifacts")
      return {
        artifacts: [
          { file: "/workspace/oh-my-agent/plans/workspace-resolver.html", url: "http://127.0.0.1:4387/s/abc", status: "feedback", pendingPrompts: 2, updatedAt: new Date(NOW - 600_000).toISOString() },
          { file: "/workspace/oh-my-agent/plans/release-checklist.html", url: "http://127.0.0.1:4387/s/def", status: "open", pendingPrompts: 0, updatedAt: new Date(NOW - 7_200_000).toISOString() },
        ],
      };
    if (path === "/api/profile") return { profile: { operator: { displayName: "Heitor", avatar: "🧭" }, agents: { researcher: { avatar: "🔬" } } } };
    if (path.startsWith("/api/workspace/changes"))
      return {
        cwd: "/workspace/oh-my-agent",
        root: "/workspace/oh-my-agent",
        branch: "ui/story-catalog",
        files: [
          {
            path: "src/workspace.ts",
            indexStatus: " ",
            worktreeStatus: "M",
            staged: false,
            unstaged: true,
            untracked: false,
          },
          {
            path: "web/src/console/Storybook.tsx",
            indexStatus: "?",
            worktreeStatus: "?",
            staged: false,
            unstaged: false,
            untracked: true,
          },
        ],
      };
    if (path.startsWith("/api/workspace/diff"))
      return {
        path: "src/workspace.ts",
        diff: DIFF,
        truncated: false,
        binary: false,
      };
    if (path.endsWith("/logs"))
      return {
        lines: [
          "14:26 subscribed #research",
          "14:28 reproduction complete",
          "14:29 waiting for review",
        ],
      };
    if (path.endsWith("/definition"))
      return {
        definition: {
          name: "researcher",
          description: "Investigates repository behavior",
          spawns: ["reviewer"],
          body: "Work from evidence. Keep changes narrow.",
        },
      };
    if (path.includes("/rooms")) return { notice: "Membership updated." };
    if (path.endsWith("/inject")) return { name: "researcher", queued: false };
    if (path.includes("/bump")) return { account: "durindoor", budgetUsd: 12 };
    return {};
  }, []);
}

const noop = () => {};
const noopAsync = async (): Promise<void> => {};

function StoryFrame({
  status = null,
  messages = MESSAGES,
  threadOpen = false,
  connected = true,
  initialView = "conversation",
}: {
  status?: ConsoleStateKind;
  messages?: RoomMessage[];
  threadOpen?: boolean;
  connected?: boolean;
  initialView?: "conversation" | "plans" | "changes" | "artifacts";
}) {
  const [room, setRoom] = useState("#research");
  const [thread, setThread] = useState(threadOpen ? 101 : null);
  const [view, setView] = useState(initialView);
  const [mobileNav, setMobileNav] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [channelOpen, setChannelOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [botOpen, setBotOpen] = useState(false);
  const call = useFixtureCall();
  const rail = (
    <ChannelRail
      rooms={ROOMS}
      chats={[{ id: "chat-1", title: "Resolver investigation", cwd: "/workspace/oh-my-agent" }]}
      current={room}
      unread={new Set(["#operations"])}
      onSelectRoom={(id) => { setRoom(id); setMobileNav(false); }}
      onSelectChat={noop}
      onNewChat={noop}
      onNewRoom={() => setChannelOpen(true)}
      onNewAgent={() => setAgentOpen(true)}
      onNewBot={() => setBotOpen(true)}
      onClose={() => setMobileNav(false)}
      connected={connected}
    />
  );
  return (
    <div className="flex h-svh flex-col overflow-hidden bg-background text-foreground">
      <WorkspaceToolbar onSearch={noop} onProfile={noop} />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <WorkspaceNavigation onConversations={noop} onAgents={() => setAgentsOpen(true)} onNewChat={noop} />
        <div className="hidden border-r md:block">{rail}</div>
        <main id="main" className="flex min-w-0 flex-1 flex-col">
          <header id="current-channel" role="banner" className="flex min-h-14 items-center gap-3 border-b px-3 md:px-5">
            <Button type="button" className="md:hidden" variant="ghost" size="icon-sm" aria-label="Open navigation" onClick={() => setMobileNav(true)}><Menu /></Button>
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-base font-bold">{room}</h1>
              <p className="truncate text-[11px] text-muted-foreground">Shared room · 2 active agents</p>
            </div>
            <Button id="open-agents" variant="outline" size="sm" onClick={() => setAgentsOpen(true)}><Users /><span className="hidden sm:inline">Agents</span></Button>
          </header>
          <div className="border-b px-4 py-2 md:px-6">
            <Tabs value={view} onValueChange={(next) => setView(next as typeof view)}>
              <TabsList variant="line">
                <TabsTrigger value="conversation">Conversation</TabsTrigger>
                <TabsTrigger value="plans">Plans</TabsTrigger>
                <TabsTrigger value="changes">Changes</TabsTrigger>
                <TabsTrigger value="artifacts">Artifacts</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          <div className="flex min-h-0 flex-1">
            {view === "conversation" ? <>
              <div className="flex min-w-0 flex-1 flex-col">
                <Transcript messages={messages} status={status} statusDetail={status === "offline" ? "Connection to the daemon was lost." : status === "load-failure" ? "The room history request failed." : ""} currentRoom={room} onThread={setThread} onReact={noopAsync} onRetry={noopAsync} />
                <Composer roomKey={room} onSend={noopAsync} onPickFiles={() => Promise.resolve(["/workspace/notes.txt"])} />
              </div>
              <ThreadPanel root={messages.find((message) => message.id === thread) ?? null} messages={messages} onClose={() => setThread(null)} onReact={noopAsync} onSend={noopAsync} />
            </> : view === "plans" ? <PlansView room={room} call={call} /> : view === "artifacts" ? <ArtifactsView call={call} version={0} /> : <ChangesView cwd="/workspace/oh-my-agent" call={call} />}
          </div>
        </main>
      </div>
      <Sheet open={mobileNav} onOpenChange={setMobileNav}>
        <SheetContent side="left" className="w-[260px] p-0"><SheetTitle className="sr-only">Conversations</SheetTitle><SheetDescription className="sr-only">Switch rooms and chats</SheetDescription>{mobileNav && rail}</SheetContent>
      </Sheet>
      <AgentPanel open={agentsOpen} onOpenChange={setAgentsOpen} agents={AGENTS} currentRoom={room} call={call} onRefresh={noopAsync} onNotice={noop} />
      <CreateChannelDialog open={channelOpen} onOpenChange={setChannelOpen} call={call} onCreated={setRoom} onPickWorkspace={() => Promise.resolve("/workspace/oh-my-agent")} />
      <CreateAgentDialog open={agentOpen} onOpenChange={setAgentOpen} call={call} onCreated={noop} onPickWorkspace={() => Promise.resolve("/workspace/oh-my-agent")} />
      <CreateAgentDialog open={botOpen} onOpenChange={setBotOpen} call={call} onCreated={noop} initialKind="bot" onPickWorkspace={() => Promise.resolve("/workspace/oh-my-agent")} />
    </div>
  );
}

function ComponentStage({
  children,
  title,
}: {
  children: React.ReactNode;
  title: string;
}) {
  return (
    <main className="min-h-svh bg-background p-4 text-foreground sm:p-8">
      <div className="mx-auto max-w-5xl">
        <p className="mb-4 text-xs font-medium uppercase tracking-widest text-muted-foreground">
          {title}
        </p>
        <div className="min-h-[34rem] overflow-hidden rounded-xl border bg-card shadow-sm">
          {children}
        </div>
      </div>
    </main>
  );
}

function AgentStory({
  initialTab = "members",
}: {
  initialTab?: "members" | "operations";
}) {
  const call = useFixtureCall();
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (!open || initialTab === "members") return;
    requestAnimationFrame(() => {
      const tab = [
        ...document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
      ].find((candidate) => candidate.textContent === "Operations");
      tab?.click();
    });
  }, [initialTab, open]);
  return (
    <ComponentStage title="Agent controls">
      <div className="grid min-h-[34rem] place-items-center">
        <Button id="open-agents" onClick={() => setOpen(true)}>
          <Bot />
          Open agents
        </Button>
      </div>
      <AgentPanel
        open={open}
        onOpenChange={setOpen}
        agents={AGENTS}
        currentRoom="#research"
        call={call}
        onRefresh={noopAsync}
        onNotice={noop}
      />
    </ComponentStage>
  );
}

function DialogStory({ agent, bot }: { agent?: boolean; bot?: boolean }) {
  const call = useFixtureCall();
  const [open, setOpen] = useState(true);
  return (
    <ComponentStage title={bot ? "Automated bot creation" : agent ? "Agent creation" : "Channel creation"}>
      <div className="grid min-h-[34rem] place-items-center">
        <Button
          id={bot ? "open-new-bot" : agent ? "open-new-agent" : "open-new-channel"}
          onClick={() => setOpen(true)}
        >
          Open dialog
        </Button>
      </div>
      {agent || bot ? (
        <CreateAgentDialog
          open={open}
          onOpenChange={setOpen}
          call={call}
          onCreated={noop}
          initialKind={bot ? "bot" : "agent"}
          onPickWorkspace={() => Promise.resolve("/workspace/oh-my-agent")}
        />
      ) : (
        <CreateChannelDialog
          open={open}
          onOpenChange={setOpen}
          call={call}
          onCreated={noop}
          onPickWorkspace={() => Promise.resolve("/workspace/oh-my-agent")}
        />
      )}
    </ComponentStage>
  );
}

export function Storybook() {
  const story = useMemo(
    () =>
      new URLSearchParams(window.location.search).get("story") ??
      "page-populated",
    [],
  );
  if (story === "page-populated") return <StoryFrame />;
  if (story === "page-empty")
    return <StoryFrame status="empty" messages={[]} />;
  if (story === "page-offline" || story === "state-offline")
    return <StoryFrame status="offline" messages={[]} connected={false} />;
  if (story === "page-load-failure" || story === "state-load-failure")
    return <StoryFrame status="load-failure" messages={[]} />;
  if (story === "page-thread" || story === "comp-thread")
    return <StoryFrame threadOpen />;
  if (story === "page-plans") return <StoryFrame initialView="plans" />;
  if (story === "page-changes") return <StoryFrame initialView="changes" />;
  if (story === "page-artifacts") return <StoryFrame initialView="artifacts" />;
  if (story === "comp-agents") return <AgentStory />;
  if (story === "comp-ops") return <AgentStory initialTab="operations" />;
  if (story === "comp-new-channel") return <DialogStory />;
  if (story === "comp-new-agent") return <DialogStory agent />;
  if (story === "comp-new-bot") return <DialogStory bot />;
  if (story === "comp-composer")
    return (
      <ComponentStage title="Composer uploads and local references">
        <div className="flex min-h-[34rem] flex-col justify-end">
          <Composer
            roomKey="#research"
            onSend={noopAsync}
            onPickFiles={() => Promise.resolve(["/workspace/evidence.txt"])}
            onUpload={(file): AttachmentUpload => ({
              cancel: noop,
              promise: Promise.resolve({ id: `story-${file.name}`, name: file.name, type: file.type, size: file.size, path: `/tmp/oh-my-agent/${file.name}` }),
            })}
            onDeleteUpload={noopAsync}
          />
        </div>
      </ComponentStage>
    );
  if (story === "comp-transcript")
    return (
      <ComponentStage title="Transcript">
        <div className="flex h-[42rem] flex-col">
          <Transcript
            messages={MESSAGES}
            status={null}
            currentRoom="#research"
            onThread={noop}
            onReact={noopAsync}
          />
        </div>
      </ComponentStage>
    );
  if (story === "state-empty")
    return (
      <ComponentStage title="Empty transcript">
        <div className="flex h-[34rem]">
          <Transcript
            messages={[]}
            status="empty"
            currentRoom="#research"
            onThread={noop}
            onReact={noopAsync}
          />
        </div>
      </ComponentStage>
    );
  return (
    <main className="grid h-svh place-items-center bg-background text-foreground">
      <div className="text-center">
        <h1 className="font-semibold">Unknown story</h1>
        <code className="text-sm text-muted-foreground">{story}</code>
      </div>
    </main>
  );
}
