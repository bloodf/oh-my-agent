import { useState } from "react";
import { Bot, Folder, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ConsoleCall } from "./CreateChannelDialog";

export type CreateAgentDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  call: ConsoleCall;
  onCreated: () => void;
  initialKind?: "agent" | "bot";
  onPickWorkspace?: (initialPath: string) => Promise<string>;
};
type Draft = { name: string; description: string; model: string; workspace: string; spawns: string; rooms: string; body: string; kind: "agent" | "bot"; wakeRooms: boolean; wakeMention: boolean; maxTurns: string; budgetUsd: string; cron: string; prompt: string };
const EMPTY: Draft = { name: "", description: "", model: "", workspace: "", spawns: "", rooms: "", body: "", kind: "agent", wakeRooms: true, wakeMention: false, maxTurns: "", budgetUsd: "", cron: "", prompt: "" };
function list(value: string) { return value.split(",").map((part) => part.trim()).filter(Boolean); }

export function CreateAgentDialog({ open, onOpenChange, call, onCreated, initialKind = "agent", onPickWorkspace }: CreateAgentDialogProps) {
  const [draft, setDraft] = useState<Draft>(() => ({ ...EMPTY, kind: initialKind }));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const field = (key: keyof Draft) => ({ value: String(draft[key]), onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft((current) => ({ ...current, [key]: event.target.value })) });
  const chooseKind = (kind: "agent" | "bot") => setDraft((current) => ({ ...current, kind }));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-1rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>Create {draft.kind}</DialogTitle><DialogDescription>Durable native peer with explicit identity, working directory, wake rules, and lifecycle.</DialogDescription></DialogHeader>
        <div className="grid grid-cols-2 gap-2 rounded-lg bg-muted p-1" role="group" aria-label="Peer type">
          <Button type="button" variant={draft.kind === "agent" ? "secondary" : "ghost"} onClick={() => chooseKind("agent")}><UserRound /> Agent</Button>
          <Button id="new-bot-kind" type="button" variant={draft.kind === "bot" ? "secondary" : "ghost"} onClick={() => chooseKind("bot")}><Bot /> Automated bot</Button>
        </div>
        <p className="text-xs text-muted-foreground">{draft.kind === "bot" ? "Bot is the same durable agent lifecycle with automated room wake and optional schedule configured." : "Agent remains available for DMs and channels; stopped-agent messages wait until it starts."}</p>
        <form id="new-agent" className="grid gap-4" onSubmit={(event) => {
          event.preventDefault(); if (busy) return;
          const rooms = list(draft.rooms); const spawns = list(draft.spawns);
          const payload: Record<string, unknown> = { name: draft.name.trim(), description: draft.description.trim(), body: draft.body, spawns: spawns.length ? spawns : "*" };
          if (rooms.length) payload.rooms = rooms;
          if (draft.model.trim()) payload.model = [draft.model.trim()];
          if (draft.workspace.trim()) payload.workspace = draft.workspace.trim();
          if (draft.kind === "bot") {
            payload.wake = { rooms: draft.wakeRooms, mention: draft.wakeMention };
            const autonomy: Record<string, number> = {};
            if (draft.maxTurns) autonomy.maxTurns = Number(draft.maxTurns);
            if (draft.budgetUsd) autonomy.budgetUsd = Number(draft.budgetUsd);
            if (Object.keys(autonomy).length) payload.autonomy = autonomy;
            if (draft.cron.trim() && draft.prompt.trim()) payload.schedules = [{ cron: draft.cron.trim(), prompt: draft.prompt.trim(), ...(rooms[0] ? { room: rooms[0] } : {}) }];
          }
          setError(""); setBusy(true);
          void call("/api/agents", { method: "POST", body: payload }).then(() => { setDraft({ ...EMPTY, kind: initialKind }); onOpenChange(false); onCreated(); }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(false));
        }}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5"><Label htmlFor="new-agent-name">Name</Label><Input id="new-agent-name" required autoFocus autoComplete="off" {...field("name")} /></div>
            <div className="grid gap-1.5"><Label htmlFor="new-agent-description">Description</Label><Input id="new-agent-description" required {...field("description")} /></div>
            <div className="grid gap-1.5"><Label htmlFor="new-agent-model">Model <span className="font-normal text-muted-foreground">(optional)</span></Label><Input id="new-agent-model" placeholder="provider/model" {...field("model")} /></div>
            <div className="grid gap-1.5"><Label htmlFor="new-agent-rooms">Channels and DMs</Label><Input id="new-agent-rooms" placeholder="#engineering, @operator" {...field("rooms")} /></div>
            <div className="grid gap-1.5 sm:col-span-2"><Label htmlFor="new-agent-workspace">Working directory <span className="font-normal text-muted-foreground">(optional)</span></Label><div className="flex gap-2"><Input id="new-agent-workspace" placeholder="Uses channel workspace when unset" {...field("workspace")} />{onPickWorkspace && <Button type="button" variant="outline" aria-label="Browse agent workspace" onClick={() => void onPickWorkspace(draft.workspace).then((workspace) => setDraft((current) => ({ ...current, workspace })))}><Folder /></Button>}</div><p className="text-xs text-muted-foreground">Explicit peer workspace wins over channel working directory.</p></div>
            <div className="grid gap-1.5 sm:col-span-2"><Label htmlFor="new-agent-spawns">Can spawn <span className="font-normal text-muted-foreground">(blank allows all)</span></Label><Input id="new-agent-spawns" placeholder="reviewer, researcher" {...field("spawns")} /></div>
          </div>
          {draft.kind === "bot" && <fieldset className="grid gap-3 rounded-lg border p-3"><legend className="px-1 text-sm font-medium">Automation</legend><div className="flex flex-wrap gap-5"><label className="flex items-center gap-2 text-sm"><Checkbox checked={draft.wakeRooms} onCheckedChange={(value) => setDraft((current) => ({ ...current, wakeRooms: value === true }))} /> Wake for channel messages</label><label className="flex items-center gap-2 text-sm"><Checkbox checked={draft.wakeMention} onCheckedChange={(value) => setDraft((current) => ({ ...current, wakeMention: value === true }))} /> Wake when mentioned elsewhere</label></div><div className="grid gap-3 sm:grid-cols-2"><div><Label htmlFor="new-agent-max-turns">Maximum turns</Label><Input id="new-agent-max-turns" type="number" min="1" {...field("maxTurns")} /></div><div><Label htmlFor="new-agent-budget">Budget USD</Label><Input id="new-agent-budget" type="number" min="0.01" step="0.01" {...field("budgetUsd")} /></div><div><Label htmlFor="new-agent-cron">Schedule (cron)</Label><Input id="new-agent-cron" placeholder="0 9 * * 1-5" {...field("cron")} /></div><div><Label htmlFor="new-agent-prompt">Scheduled instruction</Label><Input id="new-agent-prompt" placeholder="Post daily status" {...field("prompt")} /></div></div></fieldset>}
          <div className="grid gap-1.5"><Label htmlFor="new-agent-body">Soul / system prompt</Label><Textarea id="new-agent-body" required rows={6} className="font-mono text-xs" {...field("body")} /></div>
          <p id="new-agent-error" role="alert" className="min-h-5 text-xs text-destructive">{error}</p>
          <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button id="new-agent-create" type="submit" disabled={busy}>{busy ? "Creating…" : `Create ${draft.kind}`}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
