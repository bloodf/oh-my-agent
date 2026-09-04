import {
  FilePenLine,
  MessageCircle,
  ScrollText,
  Send,
  Square,
} from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
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

/**
 * Purpose: Present room membership, agent operations, account bumps, and definition editing.
 * Public API: AgentPanel and AgentPanelProps.
 * Upstream deps: shadcn Sheet/Tabs controls, AgentInfo, and console API operations.
 * Downstream consumers: ConsoleShell contextual agent action.
 * Failure modes: operation errors render in #ops-error; failed forms retain drafts.
 * Performance: linear rendering over agents and their account IDs.
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
}: AgentPanelProps) {
  const [definitionTarget, setDefinitionTarget] = useState<string | null>(null);
  const [killTarget, setKillTarget] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("members");
  const [injectDrafts, setInjectDrafts] = useState<Record<string, string>>({});
  const [logs, setLogs] = useState("");
  const [budgets, setBudgets] = useState<Record<string, number>>({});
  const [logsTitle, setLogsTitle] = useState("Logs");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const restoreFocus = (selector: string) => {
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>(selector)?.focus(),
      ),
    );
  };
  const accounts = [
    ...new Set(
      agents
        .map((agent) => agent.account)
        .filter((account): account is string => Boolean(account)),
    ),
  ];

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
        open={open && definitionTarget === null && killTarget === null}
        onOpenChange={onOpenChange}
      >
        <SheetContent
          className="w-full! max-w-full! gap-0 sm:max-w-md!"
          onCloseAutoFocus={(event) => {
            if (definitionTarget !== null || killTarget !== null) event.preventDefault();
          }}
        >
          <SheetHeader className="border-b">
            <SheetTitle>Agents</SheetTitle>
            <SheetDescription>
              Membership, live operations, and account controls.
            </SheetDescription>
          </SheetHeader>
          <Tabs value={activeTab} onValueChange={setActiveTab} className="min-h-0 flex-1 gap-0">
            <TabsList variant="line" className="mx-4 mt-2 w-[calc(100%-2rem)]">
              <TabsTrigger value="members">Members</TabsTrigger>
              <TabsTrigger value="operations">Operations</TabsTrigger>
              <TabsTrigger value="accounts">Accounts</TabsTrigger>
            </TabsList>
            <ScrollArea className="min-h-0 flex-1">
              <TabsContent value="members" className="p-4 pt-3">
                <p className="mb-3 text-xs text-muted-foreground">
                  {currentRoom
                    ? `Membership in ${currentRoom}`
                    : "Select a room to change membership."}
                </p>
                <ul id="agents" className="space-y-1.5">
                  {agents.map((agent) => {
                    const member = currentRoom
                      ? (agent.rooms ?? []).includes(currentRoom)
                      : false;
                    return (
                      <li
                        key={agent.name}
                        className="agent flex min-h-11 flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2"
                        data-name={agent.name}
                      >
                        <div className="min-w-0 basis-full sm:flex-1 sm:basis-auto">
                          <div className="truncate text-sm font-medium">
                            {agent.name}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {agent.state}
                          </div>
                        </div>
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          className="definition-edit"
                          data-name={agent.name}
                          aria-label={`Edit ${agent.name} soul and definition`}
                          onClick={() => setDefinitionTarget(agent.name)}
                        >
                          <FilePenLine />
                          Soul & definition
                        </Button>
                        {onDirectMessage ? (
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
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
                          variant={member ? "secondary" : "outline"}
                          className={
                            member
                              ? "membership-toggle member"
                              : "membership-toggle"
                          }
                          data-member={String(member)}
                          disabled={!currentRoom || busy !== null}
                          onClick={() => membership(agent)}
                        >
                          {member ? "Leave" : "Join"}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              </TabsContent>

              <TabsContent id="ops" value="operations" aria-label="Operations" className="p-4 pt-3">
                <ul id="ops-agents" className="space-y-3">
                  {agents.map((agent) => (
                    <li
                      key={agent.name}
                      className="ops-agent rounded-lg border bg-card p-3"
                      data-name={agent.name}
                    >
                      <div className="ops-name flex items-center justify-between">
                        <span className="font-medium">{agent.name}</span>
                        <Badge variant="outline">{agent.state}</Badge>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <Button
                          type="button"
                          size="xs"
                          variant="destructive"
                          className="ops-kill"
                          disabled={agent.state === "stopped"}
                          onClick={() => {
                            setActiveTab("operations");
                            setKillTarget(agent.name);
                          }}
                        >
                          <Square />
                          Stop
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          className="ops-logs"
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
                          className="definition-edit"
                          data-name={agent.name}
                          aria-label={`Edit ${agent.name} soul and definition`}
                          onClick={() => setDefinitionTarget(agent.name)}
                        >
                          <FilePenLine />
                          Soul & definition
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
                          variant="secondary"
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
                  className="mt-2 text-xs font-medium text-muted-foreground"
                >
                  {logsTitle}
                </h2>
                <pre
                  id="ops-logs-output"
                  role="log"
                  aria-live="polite"
                  className="mt-2 max-h-52 min-h-20 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre-wrap"
                >
                  {logs}
                </pre>
              </TabsContent>

              <TabsContent value="accounts" className="p-4 pt-3">
                <ul id="ops-accounts" className="space-y-2">
                  {accounts.map((account) => (
                    <li
                      key={account}
                      className="ops-account rounded-lg border bg-card p-3"
                      data-account={account}
                    >
                      <div className="ops-name text-sm font-medium">
                        {account}
                      </div>
                      <div className="ops-budget text-xs text-muted-foreground">
                        {budgets[account] === undefined ? "Metered account" : `$${budgets[account]}`}
                      </div>
                      <form
                        className="ops-bump mt-3 flex gap-2"
                        onSubmit={(event) => {
                          event.preventDefault();
                          const input = event.currentTarget.elements.namedItem(
                            "budget",
                          ) as HTMLInputElement;
                          const budgetUsd = Number(input.value);
                          if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
                            setError("Budget must be a positive number.");
                            return;
                          }
                          setError("");
                          setBusy(`bump:${account}`);
                          void call(
                            `/api/accounts/${encodeURIComponent(account)}/bump`,
                            { method: "POST", body: { budgetUsd } },
                          )
                            .then(async (result) => {
                              const appliedBudget = Number(result.budgetUsd);
                              if (Number.isFinite(appliedBudget)) {
                                setBudgets((current) => ({ ...current, [account]: appliedBudget }));
                              }
                              input.value = "";
                              onNotice(
                                `Raised ${String(result.account ?? account)} to $${String(result.budgetUsd)}.`,
                              );
                              await onRefresh();
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
                          name="budget"
                          aria-label={`New budget for ${account}`}
                          className="ops-bump-input"
                          type="number"
                          min="0.01"
                          step="any"
                          placeholder="New USD ceiling"
                        />
                        <Button
                          type="submit"
                          size="sm"
                          disabled={busy !== null}
                        >
                          Raise
                        </Button>
                      </form>
                    </li>
                  ))}
                </ul>
                <p
                  role="alert"
                  className="mt-3 min-h-5 text-xs text-destructive"
                >
                  {error}
                </p>
              </TabsContent>
            </ScrollArea>
          </Tabs>
          <p
            id="ops-error"
            role="alert"
            className="border-t px-4 py-2 text-xs text-destructive"
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
