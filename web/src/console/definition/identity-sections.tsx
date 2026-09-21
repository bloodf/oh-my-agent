/**
 * Purpose: The agent settings sections about who an agent is and where it
 * works — Soul, Profile, Model, and Rooms & hierarchy.
 *
 * Public API: `SoulSection`, `ProfileSection`, `ModelSection`, `RoomsSection`,
 * `SectionProps`, `ModelCatalog`.
 *
 * Upstream deps: `./fields`, `./AvatarEditor`, `../Markdown` (read-only
 * preview), `../FilePicker`.
 *
 * Downstream consumers: `DefinitionDialog.tsx`.
 *
 * Failure modes: none local. Each control writes the draft; the daemon
 * validates on save and its refusal is shown by the dialog.
 */
import { useState } from "react";
import { Eye, Folder, PenLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ConsoleCall } from "../CreateChannelDialog";
import { FilePicker } from "../FilePicker";
import { Markdown } from "../Markdown";
import type { Persona } from "../profile";
import { AvatarEditor } from "./AvatarEditor";
import { ChipList, CheckRow, Field, SELECT_CLASS, SectionTitle } from "./fields";
import { type Definition, THINKING_LEVELS } from "./model";

export type SectionProps = {
  draft: Definition;
  set: <K extends keyof Definition>(key: K, value: Definition[K]) => void;
  disabled: boolean;
};

export type ModelCatalog = { models: { provider: string; id: string; name?: string }[]; default?: string };

export function SoulSection({ draft, set, disabled }: SectionProps) {
  const [preview, setPreview] = useState(false);
  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3" aria-labelledby="definition-soul-title">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h3 id="definition-soul-title" className="text-lg font-bold">Soul</h3>
          <p className="text-[13px] text-muted-foreground">The agent's system prompt, in Markdown.</p>
        </div>
        <div className="grid grid-cols-2 gap-1 rounded-lg border bg-muted p-1" role="group" aria-label="Soul view">
          <Button type="button" size="sm" variant="ghost" aria-pressed={!preview} className={!preview ? "bg-background font-bold shadow-[var(--shadow-float)] hover:bg-background" : ""} onClick={() => setPreview(false)}><PenLine /> Write</Button>
          <Button type="button" size="sm" variant="ghost" aria-pressed={preview} className={preview ? "bg-background font-bold shadow-[var(--shadow-float)] hover:bg-background" : ""} onClick={() => setPreview(true)}><Eye /> Preview</Button>
        </div>
      </header>
      {preview ? (
        <div id="definition-body-preview" className="min-h-0 flex-1 overflow-y-auto rounded-lg border bg-background px-4 py-3 text-[15px]">
          {draft.body?.trim() ? <Markdown body={draft.body} /> : <p className="text-muted-foreground">Nothing to preview.</p>}
        </div>
      ) : (
        <Textarea
          id="definition-body"
          aria-label="Soul (Markdown)"
          spellCheck={false}
          className="min-h-0 flex-1 resize-none font-mono text-[13px] leading-5 [field-sizing:fixed]"
          value={draft.body ?? ""}
          disabled={disabled}
          onChange={(event) => set("body", event.target.value)}
        />
      )}
    </section>
  );
}

export function ProfileSection({ name, draft, set, disabled, persona, onPersona }: SectionProps & {
  name: string;
  persona: Persona;
  onPersona: (persona: Persona) => void;
}) {
  return (
    <section className="grid content-start gap-5">
      <SectionTitle title="Profile" description="How the agent is described and drawn. The display name and avatar are shared by every console; the agent's name on the wire does not change." />
      <Field id="definition-description" label="Description" hint="One line other agents and the operator read about this agent.">
        <Textarea id="definition-description" rows={3} value={draft.description ?? ""} disabled={disabled} onChange={(event) => set("description", event.target.value)} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
        <Field id="definition-display-name" label="Display name" optional>
          <Input id="definition-display-name" placeholder={name} maxLength={40} value={persona.displayName ?? ""} disabled={disabled} onChange={(event) => onPersona({ ...persona, displayName: event.target.value })} />
        </Field>
        <Field id="definition-avatar" label="Avatar" optional>
          <AvatarEditor id="definition-avatar" label={`${name} avatar`} placeholder="🤖" value={persona.avatar ?? ""} onChange={(avatar) => onPersona({ ...persona, avatar })} name={name} />
        </Field>
      </div>
    </section>
  );
}

export function ModelSection({ draft, set, disabled, catalog, locked = false }: SectionProps & { catalog: ModelCatalog; locked?: boolean }) {
  const [primary = "", ...fallbacks] = draft.model ?? [];
  const known = catalog.models.map((model) => `${model.provider}/${model.id}`);
  const options = primary && !known.includes(primary) ? [primary, ...known] : known;
  const setModels = (next: string[]) => set("model", next.filter(Boolean));
  return (
    <section className="grid content-start gap-5">
      <SectionTitle title="Model" description="What the agent runs on. OMP resolves the model through its own sign-in, so subscriptions and API keys both work." />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="definition-model" label="Model" hint={catalog.default ? `Unset runs on the OMP default: ${catalog.default}.` : "Unset runs on the OMP default model."}>
          <select id="definition-model" className={SELECT_CLASS} value={primary} disabled={disabled} onChange={(event) => setModels([event.target.value, ...fallbacks])}>
            <option value="">OMP default</option>
            {options.map((model) => {
              const entry = catalog.models.find((candidate) => `${candidate.provider}/${candidate.id}` === model);
              return <option key={model} value={model}>{entry?.name ? `${entry.name} (${model})` : model}</option>;
            })}
          </select>
        </Field>
        <Field id="definition-thinking" label="Thinking level">
          <select id="definition-thinking" className={SELECT_CLASS} value={draft.thinkingLevel ?? ""} disabled={disabled} onChange={(event) => set("thinkingLevel", event.target.value || undefined)}>
            {draft.thinkingLevel === undefined && <option value="">Not set</option>}
            {THINKING_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
          </select>
        </Field>
      </div>
      <Field id="definition-model-fallbacks" label="Fallback models" optional hint="Tried in order when the model above cannot be used.">
        <ChipList id="definition-model-fallbacks" label="Fallback models" values={fallbacks} suggestions={known.filter((model) => model !== primary)} placeholder="provider/model" disabled={disabled || !primary} onChange={(next) => setModels([primary, ...next])} />
      </Field>
      <Field id="definition-tools" label="Tools" optional hint="Native tool names the agent is limited to.">
        <ChipList id="definition-tools" label="Tools" values={draft.tools ?? []} placeholder="read, edit, bash" disabled={disabled || locked} onChange={(next) => set("tools", next)} />
      </Field>
    </section>
  );
}

export function RoomsSection({ draft, set, disabled, channels, agentNames, fullControl, call, locked = false }: SectionProps & {
  locked?: boolean;
  channels: string[];
  agentNames: string[];
  fullControl: boolean;
  call: ConsoleCall;
}) {
  const [picking, setPicking] = useState(false);
  const anySpawn = draft.spawns === "*";
  const spawns = Array.isArray(draft.spawns) ? draft.spawns : [];
  return (
    <section className="grid content-start gap-5">
      <SectionTitle title="Rooms & hierarchy" description="Where the agent listens, which agents it may start, and the directory it works in." />
      <Field id="definition-rooms" label="Channels and DMs" hint="Membership changes apply live. Entries start with # or @.">
        <ChipList id="definition-rooms" label="Channels and DMs" values={draft.rooms ?? []} suggestions={channels} placeholder="#engineering" disabled={disabled} onChange={(next) => set("rooms", next)} />
      </Field>
      <div className="grid gap-2">
        <CheckRow id="definition-spawns-any" label="Can spawn any agent" hint="Off limits spawning to the agents listed below." checked={anySpawn} disabled={disabled || locked} onChange={(checked) => set("spawns", checked ? "*" : spawns)} />
        {!anySpawn && (
          <Field id="definition-spawns" label="Can spawn" hint={spawns.length ? undefined : "Add at least one agent; an empty list is refused."}>
            <ChipList id="definition-spawns" label="Can spawn" values={spawns} suggestions={agentNames} placeholder="agent name" disabled={disabled || locked} onChange={(next) => set("spawns", next)} />
          </Field>
        )}
      </div>
      <Field id="definition-workspace" label="Working directory" optional hint={fullControl ? "An absolute directory. It wins over the channel's working directory." : "Full control is disabled remotely, so the working directory cannot be changed here."}>
        <div className="flex gap-2">
          <Input id="definition-workspace" className="font-mono text-[13px]" placeholder="Uses the channel workspace when unset" value={draft.workspace ?? ""} disabled={disabled || !fullControl} onChange={(event) => set("workspace", event.target.value)} />
          <Button type="button" variant="outline" size="icon-lg" className="max-sm:size-11" aria-label="Browse agent workspace" disabled={disabled || !fullControl} onClick={() => setPicking(true)}><Folder /></Button>
        </div>
      </Field>
      {fullControl && (
        <FilePicker open={picking} onOpenChange={setPicking} initialPath={draft.workspace ?? ""} call={call} directoryOnly onPick={(path) => { set("workspace", path); setPicking(false); }} />
      )}
    </section>
  );
}
