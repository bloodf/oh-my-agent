/**
 * Purpose: The schedules tab of the agent sheet — every cron schedule,
 * heartbeat, and automation the daemon holds, with its next fire and a
 * switch, plus a form that adds a cron schedule to an agent's definition.
 *
 * Upstream deps: `/api/schedules` (list, PATCH enabled) and the agent's
 * definition GET/PATCH, which is where a new schedule lives; the daemon
 * arms it on the next start of that agent.
 *
 * Downstream consumers: `AgentPanel`.
 *
 * Failure modes: a refusal from either route shows under the list; the
 * list re-reads after every change so it never shows a state the daemon
 * does not hold.
 */
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AgentInfo } from "@/lib/types";
import type { ConsoleCall } from "./CreateChannelDialog";

/** Slack's green primary action. */
const SEND_BUTTON = "bg-[var(--send)] text-white hover:bg-[var(--send-hover)] focus-visible:ring-[var(--send)]/40";

export type ScheduleRow = { id: string; agent: string; cron: string | null; action: string; nextFireAt: number | null; enabled: boolean };

function kindOf(row: ScheduleRow): string {
  if (row.id.endsWith(":heartbeat")) return "heartbeat";
  if (row.cron === null) return "automation";
  return row.cron;
}

function nextLabel(row: ScheduleRow): string {
  if (!row.enabled) return "paused";
  if (row.nextFireAt === null) return "on event";
  return `next ${new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(new Date(row.nextFireAt))}`;
}

/** The daemon's schedules with a Pause/Resume switch each; `null` while loading. */
export function ScheduleRows({ rows, busy, onToggle, empty = "No schedules yet. Every crew peer has a heartbeat once it starts." }: {
  rows: ScheduleRow[] | null;
  busy: boolean;
  onToggle: (row: ScheduleRow) => void;
  empty?: string;
}) {
  return (
    <ul className="grid grid-cols-[minmax(0,1fr)] gap-2">
      {rows === null && <li className="rounded-lg border border-dashed px-4 py-6 text-center text-[13px] text-muted-foreground">Loading…</li>}
      {rows?.length === 0 && <li className="rounded-lg border border-dashed px-4 py-8 text-center text-[15px] text-muted-foreground">{empty}</li>}
      {rows?.map((row) => (
        <li key={row.id} className={`schedule grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg border bg-card px-3 py-2.5 ${row.enabled ? "" : "opacity-80"}`} data-id={row.id} data-enabled={String(row.enabled)}>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"><span className="truncate text-[15px] font-bold">{row.agent}</span><span className="inline-flex h-5 items-center rounded-md border border-border bg-muted px-1.5 font-mono text-xs text-foreground">{kindOf(row)}</span></div>
            <div className="mt-0.5 truncate text-[13px] text-foreground/80" title={row.action}>{row.action}</div>
            <div className="text-xs text-muted-foreground">{nextLabel(row)}</div>
          </div>
          <Button type="button" size="sm" variant="outline" className="schedule-toggle max-sm:h-11 max-sm:px-3" aria-label={`${row.enabled ? "Pause" : "Resume"} ${row.id}`} disabled={busy} onClick={() => onToggle(row)}>{row.enabled ? "Pause" : "Resume"}</Button>
        </li>
      ))}
    </ul>
  );
}

export function SchedulesTab({ call, agents, onNotice }: {
  call: ConsoleCall;
  agents: AgentInfo[];
  onNotice: (text: string) => void;
}) {
  const [rows, setRows] = useState<ScheduleRow[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState({ agent: "", cron: "", prompt: "", room: "" });
  const refresh = useCallback(async () => {
    const result = await call("/api/schedules");
    setRows(result.schedules as ScheduleRow[]);
  }, [call]);
  useEffect(() => { void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))); }, [refresh]);
  const toggle = (row: ScheduleRow) => {
    setError(""); setBusy(row.id);
    void call(`/api/schedules/${encodeURIComponent(row.id)}`, { method: "PATCH", body: { enabled: !row.enabled } })
      .then(refresh)
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(null));
  };
  const add = () => {
    const { agent, cron, prompt, room } = draft;
    if (!agent || !cron.trim() || !prompt.trim()) { setError("Pick an agent and fill in cron and prompt."); return; }
    setError(""); setBusy("add");
    void call(`/api/agents/${encodeURIComponent(agent)}/definition`)
      .then((current) => {
        // The read answers `{ name, filePath, definition }`; the schedules live
        // inside `definition`, and the PATCH replaces the whole list.
        const definition = (current.definition ?? {}) as { schedules?: { cron: string; prompt: string; room?: string }[] };
        const schedules = [...(definition.schedules ?? []), { cron: cron.trim(), prompt: prompt.trim(), ...(room.trim() ? { room: room.trim() } : {}) }];
        return call(`/api/agents/${encodeURIComponent(agent)}`, { method: "PATCH", body: { schedules } });
      })
      .then(async (result) => {
        onNotice(result.rebuildRequired ? `Schedule saved on ${agent}; it arms when ${agent} next starts.` : `Schedule saved on ${agent}.`);
        setDraft({ agent: "", cron: "", prompt: "", room: "" });
        await refresh();
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(null));
  };
  return (
    <div id="schedules" className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <ScheduleRows rows={rows} busy={busy !== null} onToggle={toggle} />
      <fieldset className="grid min-w-0 gap-3 rounded-lg border p-4" disabled={busy !== null}>
        <legend className="px-1 text-[13px] font-bold text-muted-foreground">Add a cron schedule</legend>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="grid gap-1.5"><Label htmlFor="schedule-agent">Agent</Label>
            <select id="schedule-agent" className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-[15px] outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40" value={draft.agent} onChange={(e) => setDraft((d) => ({ ...d, agent: e.target.value }))}>
              <option value="">Choose…</option>
              {agents.map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
            </select>
          </div>
          <div className="grid gap-1.5"><Label htmlFor="schedule-cron">Cron (UTC)</Label><Input id="schedule-cron" placeholder="0 9 * * 1-5" value={draft.cron} onChange={(e) => setDraft((d) => ({ ...d, cron: e.target.value }))} /></div>
          <div className="grid gap-1.5 sm:col-span-2"><Label htmlFor="schedule-prompt">Prompt</Label><Input id="schedule-prompt" placeholder="Post the daily status" value={draft.prompt} onChange={(e) => setDraft((d) => ({ ...d, prompt: e.target.value }))} /></div>
          <div className="grid gap-1.5"><Label htmlFor="schedule-room">Room <span className="font-normal text-muted-foreground">(optional)</span></Label><Input id="schedule-room" placeholder="#team" value={draft.room} onChange={(e) => setDraft((d) => ({ ...d, room: e.target.value }))} /></div>
        </div>
        <div><Button id="schedule-add" type="button" className={`h-9 max-sm:h-11 ${SEND_BUTTON}`} onClick={add}>Add schedule</Button></div>
      </fieldset>
      <p role="alert" className="min-h-5 text-[13px] text-destructive">{error}</p>
    </div>
  );
}
