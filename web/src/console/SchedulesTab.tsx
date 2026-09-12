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
        const definition = current as { schedules?: { cron: string; prompt: string; room?: string }[] };
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
    <div id="schedules" className="grid gap-4">
      <ul className="space-y-1.5">
        {rows === null && <li className="text-xs text-muted-foreground">Loading…</li>}
        {rows?.length === 0 && <li className="text-xs text-muted-foreground">No schedules yet. Every crew peer has a heartbeat once it starts.</li>}
        {rows?.map((row) => (
          <li key={row.id} className="schedule flex items-center gap-3 rounded-lg border bg-card px-3 py-2" data-id={row.id} data-enabled={String(row.enabled)}>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm"><span className="font-medium">{row.agent}</span><span className="font-mono text-xs text-muted-foreground">{kindOf(row)}</span></div>
              <div className="truncate text-xs text-muted-foreground" title={row.action}>{row.action}</div>
              <div className="text-[11px] text-muted-foreground">{nextLabel(row)}</div>
            </div>
            <Button type="button" size="xs" variant={row.enabled ? "secondary" : "outline"} className="schedule-toggle" aria-label={`${row.enabled ? "Pause" : "Resume"} ${row.id}`} disabled={busy !== null} onClick={() => toggle(row)}>{row.enabled ? "Pause" : "Resume"}</Button>
          </li>
        ))}
      </ul>
      <fieldset className="grid gap-2 rounded-lg border p-3" disabled={busy !== null}>
        <legend className="px-1 text-sm font-medium">Add a cron schedule</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="grid gap-1.5"><Label htmlFor="schedule-agent">Agent</Label>
            <select id="schedule-agent" className="h-9 rounded-md border border-input bg-transparent px-3 text-sm" value={draft.agent} onChange={(e) => setDraft((d) => ({ ...d, agent: e.target.value }))}>
              <option value="">Choose…</option>
              {agents.map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
            </select>
          </div>
          <div className="grid gap-1.5"><Label htmlFor="schedule-cron">Cron (UTC)</Label><Input id="schedule-cron" placeholder="0 9 * * 1-5" value={draft.cron} onChange={(e) => setDraft((d) => ({ ...d, cron: e.target.value }))} /></div>
          <div className="grid gap-1.5 sm:col-span-2"><Label htmlFor="schedule-prompt">Prompt</Label><Input id="schedule-prompt" placeholder="Post the daily status" value={draft.prompt} onChange={(e) => setDraft((d) => ({ ...d, prompt: e.target.value }))} /></div>
          <div className="grid gap-1.5"><Label htmlFor="schedule-room">Room <span className="font-normal text-muted-foreground">(optional)</span></Label><Input id="schedule-room" placeholder="#team" value={draft.room} onChange={(e) => setDraft((d) => ({ ...d, room: e.target.value }))} /></div>
        </div>
        <div><Button id="schedule-add" type="button" size="sm" onClick={add}>Add schedule</Button></div>
      </fieldset>
      <p role="alert" className="min-h-5 text-xs text-destructive">{error}</p>
    </div>
  );
}
