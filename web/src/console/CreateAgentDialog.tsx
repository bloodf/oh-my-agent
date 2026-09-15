import { useEffect, useState } from "react";
import { Bot, Folder, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ConsoleCall } from "./CreateChannelDialog";
import { AvatarEditor } from "./definition/AvatarEditor";
import { EMPTY_PROFILE, personaFor } from "./profile";

export type CreateAgentDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  call: ConsoleCall;
  onCreated: () => void;
  initialKind?: "agent" | "bot";
  onPickWorkspace?: (initialPath: string) => Promise<string>;
  /** Whether this connection has full control; remote creation requires it. */
  fullControl?: boolean;
};
type Draft = { name: string; description: string; model: string; workspace: string; spawns: string; rooms: string; body: string; kind: "agent" | "bot"; wakeRooms: boolean; wakeMention: boolean; maxTurns: string; avatar: string; cron: string; prompt: string };
const EMPTY: Draft = { name: "", description: "", model: "", workspace: "", spawns: "", rooms: "", body: "", kind: "agent", wakeRooms: true, wakeMention: false, maxTurns: "", avatar: "", cron: "", prompt: "" };
function list(value: string) { return value.split(",").map((part) => part.trim()).filter(Boolean); }
/** Fields the daemon refuses when blank, in form order, with the message shown under each. */
const REQUIRED = [
  ["name", "new-agent-name", "Enter a name."],
  ["description", "new-agent-description", "Enter a description."],
  ["body", "new-agent-body", "Enter a soul or system prompt."],
] as const;
type RequiredField = (typeof REQUIRED)[number][0];
const RequiredMark = () => <span className="font-normal text-muted-foreground">(required)</span>;
function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? <p id={`${id}-error`} className="text-[13px] text-destructive">{message}</p> : null;
}

export function CreateAgentDialog({ open, onOpenChange, call, onCreated, initialKind = "agent", onPickWorkspace, fullControl = true }: CreateAgentDialogProps) {
  const [draft, setDraft] = useState<Draft>(() => ({ ...EMPTY, kind: initialKind }));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Only a remote connection without full control is refused; a loopback
  // console composed without workspace routes also reports fullControl false.
  const locked = !fullControl && document.documentElement.dataset.authMode === "remote";
  const [missing, setMissing] = useState<Partial<Record<RequiredField, string>>>({});
  const [catalog, setCatalog] = useState<{ models: { provider: string; id: string; name: string }[]; default?: string }>({ models: [] });
  type Preset = { name: string; description: string; body: string; spawns: string[] | "*"; rooms?: string[]; model?: string | string[] };
  const [presets, setPresets] = useState<Preset[]>([]);
  const [preset, setPreset] = useState("");
  // The shipped role library: picking one fills the form, and every field
  // stays editable. The name is left for the operator; a preset is a role,
  // not an identity.
  useEffect(() => {
    if (!open) return;
    void call("/api/presets").then((result) => setPresets((result as { presets: Preset[] }).presets ?? [])).catch(() => setPresets([]));
  }, [open, call]);
  const applyPreset = (name: string) => {
    setPreset(name);
    const found = presets.find((p) => p.name === name);
    if (!found) return;
    setDraft((current) => ({ ...current, description: found.description, body: found.body, rooms: (found.rooms ?? []).join(", "), spawns: found.spawns === "*" ? "" : found.spawns.join(", "), model: Array.isArray(found.model) ? found.model[0] ?? "" : found.model ?? "" }));
  };
  // The daemon's catalog, fetched when the dialog opens: every model it can
  // route to, and the default a peer with no model runs on. A daemon without
  // one answers an empty list and the field stays free text.
  useEffect(() => {
    if (!open) return;
    void call("/api/models").then((result) => setCatalog(result as typeof catalog)).catch(() => setCatalog({ models: [] }));
  }, [open, call]);
  const field = (key: keyof Draft) => ({ value: String(draft[key]), onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { const value = event.target.value; setDraft((current) => ({ ...current, [key]: value })); if (value.trim()) setMissing((current) => ({ ...current, [key]: undefined })); } });
  /** Validation state for a required field: marked invalid and pointed at its message. */
  const invalid = (key: RequiredField, id: string) => missing[key] ? { "aria-invalid": true, "aria-describedby": `${id}-error` } : {};
  const chooseKind = (kind: "agent" | "bot") => setDraft((current) => ({ ...current, kind }));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-1rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>Create {draft.kind}</DialogTitle><DialogDescription>Durable native peer with explicit identity, working directory, wake rules, and lifecycle.</DialogDescription></DialogHeader>
        <div className="grid grid-cols-2 gap-1 rounded-lg border bg-muted p-1" role="group" aria-label="Peer type">
          <Button type="button" variant="ghost" className={draft.kind === "agent" ? "h-9 bg-background font-bold shadow-[var(--shadow-float)] hover:bg-background" : "h-9"} onClick={() => chooseKind("agent")}><UserRound /> Agent</Button>
          <Button id="new-bot-kind" type="button" variant="ghost" className={draft.kind === "bot" ? "h-9 bg-background font-bold shadow-[var(--shadow-float)] hover:bg-background" : "h-9"} onClick={() => chooseKind("bot")}><Bot /> Automated bot</Button>
        </div>
        <p className="-mt-2 text-[13px] text-muted-foreground">{draft.kind === "bot" ? "Bot is the same durable agent lifecycle with automated room wake and optional schedule configured." : "Agent remains available for DMs and channels; stopped-agent messages wait until it starts."}</p>
        <form id="new-agent" noValidate className="grid gap-5" onSubmit={(event) => {
          event.preventDefault(); if (busy || locked) return;
          // Checked here rather than by the browser, whose silent refusal of a
          // blank required field left the dialog looking unresponsive.
          const blank = REQUIRED.filter(([key]) => !draft[key].trim());
          setMissing(Object.fromEntries(blank.map(([key, , text]) => [key, text])));
          if (blank.length > 0) {
            setError("Fill in the required fields.");
            document.getElementById(blank[0][1])?.focus();
            return;
          }
          const rooms = list(draft.rooms); const spawns = list(draft.spawns);
          const payload: Record<string, unknown> = { name: draft.name.trim(), description: draft.description.trim(), body: draft.body, spawns: spawns.length ? spawns : "*" };
          if (rooms.length) payload.rooms = rooms;
          if (draft.model.trim()) payload.model = [draft.model.trim()];
          if (draft.workspace.trim()) payload.workspace = draft.workspace.trim();
          if (draft.kind === "bot") {
            payload.wake = { rooms: draft.wakeRooms, mention: draft.wakeMention };
            if (draft.maxTurns) payload.autonomy = { maxTurns: Number(draft.maxTurns) };
            if (draft.cron.trim() && draft.prompt.trim()) payload.schedules = [{ cron: draft.cron.trim(), prompt: draft.prompt.trim(), ...(rooms[0] ? { room: rooms[0] } : {}) }];
          }
          setError(""); setBusy(true);
          const name = String(payload.name);
          const avatar = draft.avatar.trim();
          void call("/api/agents", { method: "POST", body: payload })
            .then(async () => {
              onCreated();
              // The avatar is display profile, not definition: a second write,
              // made only once the agent exists.
              if (avatar) {
                try {
                  await call("/api/profile", { method: "PUT", body: { agents: { [name]: { avatar } } } });
                } catch (cause) {
                  setError(`Created ${name}, but its avatar was not saved: ${cause instanceof Error ? cause.message : String(cause)}`);
                  return;
                }
              }
              setDraft({ ...EMPTY, kind: initialKind }); onOpenChange(false);
            })
            .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(false));
        }}>
          {presets.length > 0 && <div className="grid gap-1.5"><Label htmlFor="new-agent-preset">Start from a preset <span className="font-normal text-muted-foreground">(optional)</span></Label><select id="new-agent-preset" className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-[15px] outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40" value={preset} onChange={(event) => applyPreset(event.target.value)}><option value="">Blank</option>{presets.map((p) => <option key={p.name} value={p.name}>{p.name} — {p.description}</option>)}</select></div>}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5"><Label htmlFor="new-agent-name">Name <RequiredMark /></Label><Input id="new-agent-name" required autoFocus autoComplete="off" {...field("name")} {...invalid("name", "new-agent-name")} /><FieldError id="new-agent-name" message={missing.name} /></div>
            <div className="grid gap-1.5"><Label htmlFor="new-agent-description">Description <RequiredMark /></Label><Input id="new-agent-description" required {...field("description")} {...invalid("description", "new-agent-description")} /><FieldError id="new-agent-description" message={missing.description} /></div>
            <div className="grid gap-1.5"><Label htmlFor="new-agent-model">Model <span className="font-normal text-muted-foreground">(optional)</span></Label><Input id="new-agent-model" list="new-agent-model-catalog" placeholder={catalog.default ? `default: ${catalog.default}` : "provider/model"} {...field("model")} /><datalist id="new-agent-model-catalog">{catalog.models.map((model) => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name}</option>)}</datalist><p className="text-[13px] text-muted-foreground">Leave empty to run on the OMP default model.</p></div>
            <div className="grid gap-1.5"><Label htmlFor="new-agent-rooms">Channels and DMs</Label><Input id="new-agent-rooms" placeholder="#engineering, @operator" {...field("rooms")} /></div>
            <div className="grid gap-1.5 sm:col-span-2"><Label htmlFor="new-agent-avatar">Avatar <span className="font-normal text-muted-foreground">(optional)</span></Label><AvatarEditor id="new-agent-avatar" label="New agent avatar" placeholder="🤖" value={draft.avatar} onChange={(avatar) => setDraft((current) => ({ ...current, avatar }))} fallback={personaFor(EMPTY_PROFILE, draft.name.trim() || "agent").avatar} /></div>
            <div className="grid gap-1.5 sm:col-span-2"><Label htmlFor="new-agent-workspace">Working directory <span className="font-normal text-muted-foreground">(optional)</span></Label><div className="flex gap-2"><Input id="new-agent-workspace" placeholder="Uses channel workspace when unset" {...field("workspace")} />{onPickWorkspace && <Button type="button" variant="outline" size="icon-lg" aria-label="Browse agent workspace" onClick={() => void onPickWorkspace(draft.workspace).then((workspace) => setDraft((current) => ({ ...current, workspace })))}><Folder /></Button>}</div><p className="text-[13px] text-muted-foreground">Explicit peer workspace wins over channel working directory.</p></div>
            <div className="grid gap-1.5 sm:col-span-2"><Label htmlFor="new-agent-spawns">Can spawn <span className="font-normal text-muted-foreground">(blank allows all)</span></Label><Input id="new-agent-spawns" placeholder="reviewer, researcher" {...field("spawns")} /></div>
          </div>
          {draft.kind === "bot" && <fieldset className="grid gap-3 rounded-lg border p-4"><legend className="px-1 text-[13px] font-bold text-muted-foreground">Automation</legend><div className="flex flex-wrap gap-5"><label className="flex items-center gap-2 text-sm"><Checkbox checked={draft.wakeRooms} onCheckedChange={(value) => setDraft((current) => ({ ...current, wakeRooms: value === true }))} /> Wake for channel messages</label><label className="flex items-center gap-2 text-sm"><Checkbox checked={draft.wakeMention} onCheckedChange={(value) => setDraft((current) => ({ ...current, wakeMention: value === true }))} /> Wake when mentioned elsewhere</label></div><div className="grid gap-3 sm:grid-cols-2 [&>div]:grid [&>div]:gap-1.5"><div><Label htmlFor="new-agent-max-turns">Maximum turns</Label><Input id="new-agent-max-turns" type="number" min="1" {...field("maxTurns")} /></div><div><Label htmlFor="new-agent-cron">Schedule (cron)</Label><Input id="new-agent-cron" placeholder="0 9 * * 1-5" {...field("cron")} /></div><div><Label htmlFor="new-agent-prompt">Scheduled instruction</Label><Input id="new-agent-prompt" placeholder="Post daily status" {...field("prompt")} /></div></div></fieldset>}
          <div className="grid gap-1.5"><Label htmlFor="new-agent-body">Soul / system prompt <RequiredMark /></Label><Textarea id="new-agent-body" required rows={6} className="font-mono text-xs" {...field("body")} {...invalid("body", "new-agent-body")} /><FieldError id="new-agent-body" message={missing.body} /></div>
          {locked && <p id="new-agent-remote" className="text-[13px] text-muted-foreground">Full control is disabled for this remote connection, so agents and bots cannot be created here. Create them from the machine running the daemon, or enable remote full control.</p>}
          <p id="new-agent-error" role="alert" className="-my-2 min-h-5 text-[13px] text-destructive">{error}</p>
          <DialogFooter><Button type="button" variant="outline" className="h-9 px-4 font-bold" onClick={() => onOpenChange(false)}>Cancel</Button><Button id="new-agent-create" type="submit" className="h-9 px-4 font-bold bg-[var(--send)] text-white hover:bg-[var(--send-hover)]" disabled={busy || locked}>{busy ? "Creating…" : `Create ${draft.kind}`}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
