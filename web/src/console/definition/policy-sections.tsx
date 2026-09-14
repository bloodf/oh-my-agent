/**
 * Purpose: The agent settings sections about when and how an agent acts —
 * Wake & autonomy, Schedules & automations, and Sandbox & tools.
 *
 * Public API: `WakeSection`, `SchedulesSection`, `SandboxSection`.
 *
 * Upstream deps: `./fields`, `../SchedulesTab` (`ScheduleRows`), and
 * `/api/schedules` for the live schedule state.
 *
 * Downstream consumers: `DefinitionDialog.tsx`.
 *
 * Failure modes: a live schedule read or toggle that fails is shown in the
 * section; definition fields are validated by the daemon on save.
 */
import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ConsoleCall } from "../CreateChannelDialog";
import { ScheduleRows, type ScheduleRow } from "../SchedulesTab";
import { ChipList, CheckRow, Field, SectionTitle } from "./fields";
import type { SandboxConfig } from "./model";
import type { SectionProps } from "./identity-sections";

export function WakeSection({ draft, set, disabled, budgetUsd }: SectionProps & { budgetUsd?: number }) {
  const wake = draft.wake ?? {};
  const heartbeat = draft.heartbeat ?? { every: "" };
  const setHeartbeat = (every: string, prompt: string) => set("heartbeat", { every, ...(prompt ? { prompt } : {}) });
  const { budgetUsd: _budget, ...autonomy } = draft.autonomy ?? {};
  return (
    <section className="grid content-start gap-5">
      <SectionTitle title="Wake & autonomy" description="What wakes the agent and how long it may run on its own." />
      <div className="grid gap-2">
        <CheckRow id="definition-wake-rooms" label="Wake for channel messages" checked={wake.rooms === true} disabled={disabled} onChange={(rooms) => set("wake", { ...wake, rooms })} />
        <CheckRow id="definition-wake-mention" label="Wake when mentioned elsewhere" checked={wake.mention === true} disabled={disabled} onChange={(mention) => set("wake", { ...wake, mention })} />
      </div>
      <fieldset className="grid gap-4 rounded-lg border p-4">
        <legend className="px-1 text-[13px] font-bold text-muted-foreground">Heartbeat</legend>
        <Field id="definition-heartbeat-every" label="Every" hint="A duration such as 30s, 15m, 2h, or 1d; at least 10s.">
          <Input id="definition-heartbeat-every" className="font-mono sm:max-w-40" placeholder="15m" value={heartbeat.every} disabled={disabled} onChange={(event) => setHeartbeat(event.target.value, heartbeat.prompt ?? "")} />
        </Field>
        <Field id="definition-heartbeat-prompt" label="Prompt" optional hint="Unset uses the default heartbeat prompt.">
          <Textarea id="definition-heartbeat-prompt" rows={3} value={heartbeat.prompt ?? ""} disabled={disabled} onChange={(event) => setHeartbeat(heartbeat.every, event.target.value)} />
        </Field>
      </fieldset>
      <Field id="definition-max-turns" label="Maximum turns" optional hint="A positive whole number.">
        <Input
          id="definition-max-turns"
          type="number"
          min="1"
          step="1"
          className="sm:max-w-40"
          value={autonomy.maxTurns ?? ""}
          disabled={disabled}
          onChange={(event) => {
            const { maxTurns: _old, ...rest } = autonomy;
            set("autonomy", event.target.value === "" ? rest : { ...rest, maxTurns: Number(event.target.value) });
          }}
        />
      </Field>
      {budgetUsd !== undefined && (
        <div id="definition-budget" className="grid gap-1 rounded-lg border border-dashed px-3 py-2.5">
          <span className="text-[13px] font-bold text-muted-foreground">Spending ceiling</span>
          <span className="font-mono text-[15px]">${budgetUsd}</span>
          <p className="text-[13px] text-muted-foreground">Ceilings are managed outside the console; saving here keeps this value.</p>
        </div>
      )}
    </section>
  );
}

type Row = { prompt: string; room?: string } & ({ cron: string } | { event: string });

function RowsEditor<T extends Row>({ idPrefix, rows, onChange, keyField, keyLabel, keyPlaceholder, blank, disabled }: {
  idPrefix: string;
  rows: T[];
  onChange: (rows: T[]) => void;
  keyField: "cron" | "event";
  keyLabel: string;
  keyPlaceholder: string;
  blank: T;
  disabled: boolean;
}) {
  const update = (index: number, field: string, value: string) =>
    onChange(rows.map((row, at) => {
      if (at !== index) return row;
      if (field === "room" && !value) {
        const { room: _room, ...rest } = row;
        return rest as T;
      }
      return { ...row, [field]: value };
    }));
  return (
    <div className="grid gap-2">
      {rows.map((row, index) => (
        <div key={index} className="grid grid-cols-1 gap-2 rounded-lg border bg-card p-3 sm:grid-cols-[10rem_minmax(0,1fr)_8rem_auto]" data-row={`${idPrefix}-${index}`}>
          <Input aria-label={`${keyLabel} ${index + 1}`} className="font-mono text-[13px]" placeholder={keyPlaceholder} value={(row as Record<string, string>)[keyField] ?? ""} disabled={disabled} onChange={(event) => update(index, keyField, event.target.value)} />
          <Input aria-label={`Prompt ${index + 1}`} placeholder="Prompt" value={row.prompt} disabled={disabled} onChange={(event) => update(index, "prompt", event.target.value)} />
          <Input aria-label={`Room ${index + 1}`} placeholder="#room" value={row.room ?? ""} disabled={disabled} onChange={(event) => update(index, "room", event.target.value)} />
          <Button type="button" variant="ghost" size="icon" className="justify-self-end max-sm:size-11" aria-label={`Remove ${keyLabel.toLowerCase()} ${index + 1}`} disabled={disabled} onClick={() => onChange(rows.filter((_, at) => at !== index))}><Trash2 /></Button>
        </div>
      ))}
      <div><Button type="button" variant="outline" className="h-9 max-sm:h-11" id={`${idPrefix}-add`} disabled={disabled} onClick={() => onChange([...rows, blank])}><Plus /> Add</Button></div>
    </div>
  );
}

export function SchedulesSection({ name, draft, set, disabled, call }: SectionProps & { name: string; call: ConsoleCall }) {
  const [rows, setRows] = useState<ScheduleRow[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    const result = await call("/api/schedules");
    setRows(((result.schedules as ScheduleRow[] | undefined) ?? []).filter((row) => row.agent === name));
  }, [call, name]);
  useEffect(() => { void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))); }, [refresh]);
  return (
    <section className="grid content-start gap-5">
      <SectionTitle title="Schedules & automations" description="Cron schedules in UTC and event automations. Definition changes arm when the agent next starts." />
      <div className="grid gap-2">
        <h4 className="text-[13px] font-bold text-muted-foreground">Running now</h4>
        <ScheduleRows
          rows={rows}
          busy={busy}
          empty={`No live schedules for ${name}.`}
          onToggle={(row) => {
            setError(""); setBusy(true);
            void call(`/api/schedules/${encodeURIComponent(row.id)}`, { method: "PATCH", body: { enabled: !row.enabled } })
              .then(refresh)
              .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
              .finally(() => setBusy(false));
          }}
        />
        {error && <p role="alert" className="text-[13px] text-destructive">{error}</p>}
      </div>
      <div className="grid gap-2">
        <h4 className="text-[13px] font-bold text-muted-foreground">Schedules</h4>
        <RowsEditor idPrefix="definition-schedule" rows={draft.schedules ?? []} keyField="cron" keyLabel="Cron" keyPlaceholder="0 9 * * 1-5" blank={{ cron: "", prompt: "" }} disabled={disabled} onChange={(next) => set("schedules", next)} />
      </div>
      <div className="grid gap-2">
        <h4 className="text-[13px] font-bold text-muted-foreground">Automations</h4>
        <p className="text-[13px] text-muted-foreground">Listed with the schedules; each fires on its named event once an event source exists for it.</p>
        <RowsEditor idPrefix="definition-automation" rows={draft.automations ?? []} keyField="event" keyLabel="Event" keyPlaceholder="event name" blank={{ event: "", prompt: "" }} disabled={disabled} onChange={(next) => set("automations", next)} />
      </div>
    </section>
  );
}

export function SandboxSection({ draft, set, disabled }: SectionProps) {
  const sandbox: SandboxConfig = typeof draft.sandbox === "object" ? draft.sandbox : { enabled: draft.sandbox === true };
  const enabled = typeof draft.sandbox === "object" ? draft.sandbox.enabled !== false : draft.sandbox === true;
  return (
    <section className="grid content-start gap-5">
      <SectionTitle title="Sandbox & tools" description="OS confinement for the agent's worker, and the MCP servers and skills it loads." />
      <CheckRow
        id="definition-sandbox"
        label="Run in the OS sandbox"
        hint="Fail-closed: the agent does not start where the sandbox cannot be enforced."
        checked={enabled}
        disabled={disabled}
        onChange={(checked) => set("sandbox", typeof draft.sandbox === "object" ? { ...draft.sandbox, enabled: checked } : checked)}
      />
      <Field id="definition-extra-roots" label="Extra writable roots" optional hint="Absolute directories the sandbox also allows.">
        <ChipList id="definition-extra-roots" label="Extra writable roots" values={sandbox.extraRoots ?? []} placeholder="/path/to/dir" disabled={disabled} onChange={(extraRoots) => set("sandbox", { ...sandbox, enabled, extraRoots })} />
      </Field>
      {sandbox.allowUnenforcedNetwork !== undefined && (
        <p id="definition-unenforced-network" className="rounded-lg border border-dashed px-3 py-2.5 text-[13px] text-muted-foreground">
          Unenforced network is {sandbox.allowUnenforcedNetwork ? "accepted" : "not accepted"} in the definition file. Change it there.
        </p>
      )}
      <Field id="definition-mcps" label="MCP servers" optional>
        <ChipList id="definition-mcps" label="MCP servers" values={draft.mcps ?? []} placeholder="server name" disabled={disabled} onChange={(next) => set("mcps", next)} />
      </Field>
      <Field id="definition-skills" label="Skills" optional>
        <ChipList id="definition-skills" label="Skills" values={draft.skills ?? []} placeholder="skill name" disabled={disabled} onChange={(next) => set("skills", next)} />
      </Field>
    </section>
  );
}
