import { useState } from "react";
import { Folder } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type ConsoleCall = (path: string, init?: { method?: string; body?: unknown }) => Promise<Record<string, unknown>>;
export type CreateChannelDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  call: ConsoleCall;
  onCreated: (id: string) => void;
  onPickWorkspace?: (initialPath: string) => Promise<string>;
};

export function CreateChannelDialog({ open, onOpenChange, call, onCreated, onPickWorkspace }: CreateChannelDialogProps) {
  const [draft, setDraft] = useState({ id: "", workspace: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[32rem]">
        <DialogHeader>
          <DialogTitle>Create channel</DialogTitle>
          <DialogDescription>Make a durable shared conversation. Workspace is context for agents, not an access boundary.</DialogDescription>
        </DialogHeader>
        <form id="new-channel" className="grid gap-5" onSubmit={(event) => {
          event.preventDefault();
          const id = draft.id.trim();
          if (!id || busy) return;
          setError(""); setBusy(true);
          void call("/api/channels", { method: "POST", body: { id, ...(draft.workspace.trim() ? { workspace: draft.workspace.trim() } : {}) } })
            .then(() => { setDraft({ id: "", workspace: "" }); onOpenChange(false); onCreated(id); })
            .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
            .finally(() => setBusy(false));
        }}>
          <div className="grid gap-1.5">
            <Label htmlFor="new-channel-input">Channel name</Label>
            <Input id="new-channel-input" placeholder="#new-channel" autoComplete="off" required autoFocus value={draft.id} onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value }))} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="new-channel-workspace">Working directory <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <div className="flex gap-2">
              <Input id="new-channel-workspace" placeholder="/Users/you/project" value={draft.workspace} onChange={(event) => setDraft((current) => ({ ...current, workspace: event.target.value }))} />
              {onPickWorkspace && <Button type="button" variant="outline" size="icon-lg" aria-label="Browse channel workspace" onClick={() => void onPickWorkspace(draft.workspace).then((workspace) => setDraft((current) => ({ ...current, workspace })))}><Folder /></Button>}
            </div>
            <p className="text-[13px] text-muted-foreground">Agents without an explicit workspace use this directory for channel work.</p>
          </div>
          <p id="new-channel-error" role="alert" className="-my-2 min-h-5 text-[13px] text-destructive">{error}</p>
          <DialogFooter>
            <Button type="button" variant="outline" className="h-9 px-4 font-bold" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button id="new-channel-create" type="submit" className="h-9 px-4 font-bold bg-[var(--send)] text-white hover:bg-[var(--send-hover)]" disabled={busy}>{busy ? "Creating…" : "Create channel"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
