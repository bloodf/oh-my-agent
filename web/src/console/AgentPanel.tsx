import {
  Bot,
  MessageCircle,
  Play,
  ScrollText,
  Send,
  Settings,
  Square,
} from "lucide-react";
import { useState } from "react";
import { SchedulesTab } from "./SchedulesTab";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { AgentInfo } from "@/lib/types";
import type { ConsoleCall } from "./CreateChannelDialog";
import { DefinitionDialog } from "./DefinitionDialog";
import { KillDialog } from "./KillDialog";
import { AvatarDialog } from "./definition/AvatarEditor";
import { personaFor, useProfile } from "./profile";
import { AvatarTile } from "./WorkspaceToolbar";

/** Slack's green primary action, used for every confirm in the agent sheet. */
const SEND_BUTTON = "bg-[var(--send)] text-white hover:bg-[var(--send-hover)] focus-visible:ring-[var(--send)]/40";
/** Row actions grow to a 44px touch target on narrow screens. */
const TOUCH = "max-sm:h-11 max-sm:px-3";
const SECTION_LABEL = "text-[13px] font-bold text-muted-foreground";

const PRESENCE: Record<string, string> = {
  running: "bg-[var(--presence-active)]",
  parked: "bg-[var(--presence-parked)]",
};

/** Slack-style state pill: coloured dot plus the daemon's own state word. */
function StatePill({ state }: { state: string }) {
  return (
    <span className="agent-state inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border border-border bg-background px-2 text-xs font-semibold text-muted-foreground">
      <span aria-hidden className={`size-2 rounded-full ${PRESENCE[state] ?? "bg-[var(--presence-stopped)]"}`} />
      {state}
    </span>
  );
}

/**
 * Purpose: Present room membership, agent operations, schedules, avatars, and agent settings.
 * Public API: AgentPanel and AgentPanelProps.
 * Upstream deps: shadcn Sheet/Tabs controls, AgentInfo, and console API operations.
 * Downstream consumers: ConsoleShell contextual agent action.
 * Failure modes: operation errors render in #ops-error; failed forms retain drafts.
 * Performance: linear rendering over agents.
 */

export type AgentPanelProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: AgentInfo[];
  currentRoom: string | null;
  call: ConsoleCall;
  onRefresh: () => Promise<void>;
  onNotice: (text: string) => void;
  onDirectMessage?: (name: string) => Promise<void>;
  fullControl?: boolean;
};

export function AgentPanel({
  open,
  onOpenChange,
  agents,
  currentRoom,
  call,
  onRefresh,
  onNotice,
  onDirectMessage,
  fullControl = true,
}: AgentPanelProps) {
  const [definitionTarget, setDefinitionTarget] = useState<string | null>(null);
  const [killTarget, setKillTarget] = useState<string | null>(null);
  const [avatarTarget, setAvatarTarget] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("members");
  const [injectDrafts, setInjectDrafts] = useState<Record<string, string>>({});
  const [logs, setLogs] = useState("");
  const [logsTitle, setLogsTitle] = useState("Logs");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const profile = useProfile();
  const restoreFocus = (selector: string) => {
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>(selector)?.focus(),
      ),
    );
  };

  const membership = (agent: AgentInfo) => {
    if (!currentRoom) return;
    const member = (agent.rooms ?? []).includes(currentRoom);
    const base = `/api/agents/${encodeURIComponent(agent.name)}/rooms`;
    setError("");
    setBusy(`membership:${agent.name}`);
    void (
      member
        ? call(`${base}/${encodeURIComponent(currentRoom)}`, {
            method: "DELETE",
          })
        : call(base, { method: "POST", body: { room: currentRoom } })
    )
      .then(async (result) => {
        onNotice(
          typeof result.notice === "string"
            ? result.notice
            : "Membership updated.",
        );
        await onRefresh();
      })
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => setBusy(null));
  };

  return (
    <>
      <Sheet
        open={open && definitionTarget === null && killTarget === null && avatarTarget === null}
        onOpenChange={onOpenChange}
      >
        <SheetContent
          className="w-full! max-w-full! gap-0 sm:max-w-[30rem]!"
          onCloseAutoFocus={(event) => {
            if (definitionTarget !== null || killTarget !== null || avatarTarget !== null) event.preventDefault();
          }}
        >
          <SheetHeader className="h-[49px] shrink-0 border-b">
            <SheetTitle>Agents</SheetTitle>
            <SheetDescription className="sr-only">
              Membership, live operations, and schedules.
            </SheetDescription>
          </SheetHeader>
          <Tabs value={activeTab} onValueChange={setActiveTab} className="min-h-0 flex-1 gap-0">
            <TabsList variant="line" className="h-10! w-full shrink-0 justify-start gap-2 border-b px-3">
              <TabsTrigger value="members">Members</TabsTrigger>
              <TabsTrigger value="operations">Operations</TabsTrigger>
              <TabsTrigger value="schedules">Schedules</TabsTrigger>
            </TabsList>
            <ScrollArea className="min-h-0 flex-1">
              <TabsContent value="schedules" className="px-5 py-4">
                <SchedulesTab call={call} agents={agents} onNotice={onNotice} />
              </TabsContent>
              <TabsContent value="members" className="px-3 py-4">
                <p className={`mb-2 px-2 ${SECTION_LABEL}`}>
                  {currentRoom
                    ? `Membership in ${currentRoom}`
                    : "Select a room to change membership."}
                </p>
                <ul id="agents" className="grid gap-0.5">
                  {agents.map((agent) => {
                    const member = currentRoom
                      ? (agent.rooms ?? []).includes(currentRoom)
                      : false;
                    const persona = personaFor(profile, agent.name);
                    return (
                      <li
                        key={agent.name}
                        className="agent flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md px-2 py-1.5 transition-colors hover:bg-[var(--surface-hover)]"
                        data-name={agent.name}
                      >
                        <button
                          type="button"
                          className="member-avatar grid size-7 shrink-0 place-items-center rounded-md text-[22px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60 max-sm:size-11"
                          data-name={agent.name}
                          aria-label={`Change ${persona.name} avatar`}
                          title="Change avatar"
                          onClick={() => setAvatarTarget(agent.name)}
                        >
                          <AvatarTile author={agent.name} className="size-7 border border-border bg-muted text-foreground" />
                        </button>
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2">
                            {agent.automation && <Bot className="size-3.5 shrink-0 text-muted-foreground" aria-label="Automated bot" />}
                            <span className="truncate text-[15px] font-bold">{agent.name}</span>
                            <StatePill state={agent.state} />
                          </div>
                          <div className="truncate text-[13px] text-muted-foreground">
                            {agent.automation ? `Bot${agent.automation.wakeRooms ? " · message wake" : ""}${agent.automation.schedules.length ? ` · ${agent.automation.schedules.join(", ")}` : ""}` : "Agent"}
                          </div>
                        </div>
                        <div className="flex basis-full flex-wrap items-center justify-end gap-1 pl-10 sm:basis-auto sm:pl-0">
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          className={`definition-edit ${TOUCH}`}
                          data-name={agent.name}
                          aria-label={`${agent.name} settings`}
                          onClick={() => setDefinitionTarget(agent.name)}
                        >
                          <Settings />
                          Settings
                        </Button>
                        {onDirectMessage ? (
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            className={TOUCH}
                            disabled={busy !== null}
                            onClick={() => {
                              setError("");
                              setBusy(`dm:${agent.name}`);
                              void onDirectMessage(agent.name)
                                .catch((cause) =>
                                  setError(
                                    cause instanceof Error
                                      ? cause.message
                                      : String(cause),
                                  ),
                                )
                                .finally(() => setBusy(null));
                            }}
                          >
                            <MessageCircle />
                            Message
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          size="xs"
                          variant={member ? "outline" : "default"}
                          className={
                            member
                              ? `membership-toggle member ${TOUCH}`
                              : `membership-toggle ${TOUCH} ${SEND_BUTTON}`
                          }
                          data-member={String(member)}
                          disabled={!currentRoom || busy !== null}
                          onClick={() => membership(agent)}
                        >
                          {member ? "Leave" : "Join"}
                        </Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </TabsContent>

              <TabsContent id="ops" value="operations" aria-label="Operations" className="px-5 py-4">
                <ul id="ops-agents" className="grid gap-3">
                  {agents.map((agent) => (
                    <li
                      key={agent.name}
                      className="ops-agent rounded-lg border bg-card p-3"
                      data-name={agent.name}
                    >
                      <div className="ops-name flex items-center gap-3">
                        <span className="text-[22px] leading-none"><AvatarTile author={agent.name} className="size-7 border border-border bg-muted text-foreground" /></span>
                        <span className="min-w-0 flex-1 truncate text-[15px] font-bold">{agent.name}</span>
                        <StatePill state={agent.state} />
                      </div>
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          className={`ops-kill ${TOUCH} border-destructive/40 text-destructive hover:bg-destructive hover:text-white dark:hover:bg-destructive dark:hover:text-[#1a1d21]`}
                          disabled={agent.state === "stopped"}
                          onClick={() => {
                            setActiveTab("operations");
                            setKillTarget(agent.name);
                          }}
                        >
                          <Square />
                          Stop
                        </Button>
                        {agent.state === "stopped" && (
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            className={`ops-start ${TOUCH}`}
                            disabled={busy !== null || !fullControl}
                            title={fullControl ? "Start agent" : "Full control disabled remotely"}
                            onClick={() => {
                              setError("");
                              setBusy(`start:${agent.name}`);
                              void call(`/api/agents/${encodeURIComponent(agent.name)}/start`, { method: "POST", body: {} })
                                .then(async () => { onNotice(`${agent.name} started. Waiting DMs can now be processed.`); await onRefresh(); })
                                .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
                                .finally(() => setBusy(null));
                            }}
                          >
                            <Play />
                            Start
                          </Button>
                        )}
                        {!fullControl && agent.state === "stopped" && <span className="text-xs text-muted-foreground">Full control disabled remotely</span>}
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          className={`ops-logs ${TOUCH}`}
                          onClick={() => {
                            setError("");
                            setBusy(`logs:${agent.name}`);
                            void call(
                              `/api/agents/${encodeURIComponent(agent.name)}/logs`,
                            )
                              .then((result) => {
                                const lines = Array.isArray(result.lines)
                                  ? result.lines.map(String)
                                  : [];
                                setLogsTitle(`Logs · ${agent.name}`);
                                setLogs(
                                  lines.length
                                    ? lines.join("\n")
                                    : `No logs for ${agent.name}.`,
                                );
                              })
                              .catch((cause) =>
                                setError(
                                  cause instanceof Error
                                    ? cause.message
                                    : String(cause),
                                ),
                              )
                              .finally(() => setBusy(null));
                          }}
                        >
                          <ScrollText />
                          Logs
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          className={`definition-edit ${TOUCH}`}
                          data-name={agent.name}
                          aria-label={`${agent.name} settings`}
                          onClick={() => setDefinitionTarget(agent.name)}
                        >
                          <Settings />
                          Settings
                        </Button>
                      </div>
                      <form
                        className="ops-inject mt-3 flex gap-2"
                        onSubmit={(event) => {
                          event.preventDefault();
                          const message =
                            injectDrafts[agent.name]?.trim() ?? "";
                          if (!message) return;
                          setError("");
                          setBusy(`inject:${agent.name}`);
                          void call(
                            `/api/agents/${encodeURIComponent(agent.name)}/inject`,
                            { method: "POST", body: { message } },
                          )
                            .then((result) => {
                              setInjectDrafts((drafts) => ({
                                ...drafts,
                                [agent.name]: "",
                              }));
                              onNotice(
                                result.queued
                                  ? `Queued for ${String(result.name)}; it reads this when it resumes.`
                                  : `Sent to ${String(result.name)}.`,
                              );
                            })
                            .catch((cause) =>
                              setError(
                                cause instanceof Error
                                  ? cause.message
                                  : String(cause),
                              ),
                            )
                            .finally(() => setBusy(null));
                        }}
                      >
                        <Input
                          id={`ops-inject-${agent.name}`}
                          aria-label={`Instruction for ${agent.name}`}
                          className="ops-inject-input"
                          placeholder="Instruction"
                          value={injectDrafts[agent.name] ?? ""}
                          onChange={(event) =>
                            setInjectDrafts((drafts) => ({
                              ...drafts,
                              [agent.name]: event.target.value,
                            }))
                          }
                        />
                        <Button
                          type="submit"
                          size="icon"
                          className={`size-9 max-sm:size-11 ${SEND_BUTTON}`}
                          disabled={busy !== null}
                          aria-label={`Send instruction to ${agent.name}`}
                        >
                          <Send />
                        </Button>
                      </form>
                    </li>
                  ))}
                </ul>
                <h2
                  id="ops-logs-title"
                  className={`mt-5 ${SECTION_LABEL}`}
                >
                  {logsTitle}
                </h2>
                <pre
                  id="ops-logs-output"
                  role="log"
                  aria-live="polite"
                  className="mt-2 max-h-64 min-h-24 overflow-auto rounded-lg border border-black/40 bg-[#1d1c1d] p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-[#e8e8e8] dark:border-white/10 dark:bg-[#0e0f11]"
                >
                  {logs}
                </pre>
              </TabsContent>

            </ScrollArea>
          </Tabs>
          <p
            id="ops-error"
            role="alert"
            className="border-t px-5 py-2 text-[13px] text-destructive empty:hidden"
          >
            {error}
          </p>
        </SheetContent>
      </Sheet>
      <DefinitionDialog
        key={definitionTarget ?? "definition-closed"}
        open={definitionTarget !== null}
        onOpenChange={(next) => {
          if (next || definitionTarget === null) return;
          const selector = `.definition-edit[data-name="${CSS.escape(definitionTarget)}"]`;
          setDefinitionTarget(null);
          restoreFocus(selector);
        }}
        name={definitionTarget}
        call={call}
        onRefresh={onRefresh}
        onNotice={onNotice}
        agents={agents}
        fullControl={fullControl}
      />
      <AvatarDialog
        key={avatarTarget ?? "avatar-closed"}
        name={avatarTarget}
        onOpenChange={(next) => {
          if (next || avatarTarget === null) return;
          const selector = `.member-avatar[data-name="${CSS.escape(avatarTarget)}"]`;
          setAvatarTarget(null);
          restoreFocus(selector);
        }}
        call={call}
        onNotice={onNotice}
      />
      <KillDialog
        name={killTarget}
        agents={agents}
        onOpenChange={(next) => {
          if (next || killTarget === null) return;
          const selector = `.ops-agent[data-name="${CSS.escape(killTarget)}"] .ops-kill`;
          setKillTarget(null);
          restoreFocus(selector);
        }}
        call={call}
        onRefresh={onRefresh}
        onNotice={onNotice}
      />
    </>
  );
}
