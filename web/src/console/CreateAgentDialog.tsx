import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ConsoleCall } from "./CreateChannelDialog";

/**
 * Purpose: Author a validated agent definition through the console API.
 * Public API: CreateAgentDialog and CreateAgentDialogProps.
 * Upstream deps: shadcn Dialog/form primitives and the console request seam.
 * Downstream consumers: the console shell agent creation action.
 * Failure modes: parser/API errors remain inline; every draft survives failure.
 * Performance: one request per submit.
 */

export type CreateAgentDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  call: ConsoleCall;
  onCreated: () => void;
};

type Draft = {
  name: string;
  description: string;
  model: string;
  workspace: string;
  spawns: string;
  rooms: string;
  body: string;
};

const EMPTY: Draft = {
  name: "",
  description: "",
  model: "",
  workspace: "",
  spawns: "",
  rooms: "",
  body: "",
};

function list(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function CreateAgentDialog({
  open,
  onOpenChange,
  call,
  onCreated,
}: CreateAgentDialogProps) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const field = (key: keyof Draft) => ({
    value: draft[key],
    onChange: (
      event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => setDraft((current) => ({ ...current, [key]: event.target.value })),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Create agent</DialogTitle>
          <DialogDescription>
            Write its identity, optional runtime preferences, and soul.
          </DialogDescription>
        </DialogHeader>
        <form
          id="new-agent"
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (busy) return;
            const payload: Record<string, unknown> = {
              name: draft.name.trim(),
              description: draft.description.trim(),
              body: draft.body,
            };
            const rooms = list(draft.rooms);
            const spawns = list(draft.spawns);
            payload.spawns = spawns.length > 0 ? spawns : "*";
            if (rooms.length) payload.rooms = rooms;
            if (draft.model.trim()) payload.model = [draft.model.trim()];
            if (draft.workspace.trim())
              payload.workspace = draft.workspace.trim();
            setError("");
            setBusy(true);
            void call("/api/agents", { method: "POST", body: payload })
              .then(() => {
                setDraft(EMPTY);
                onOpenChange(false);
                onCreated();
              })
              .catch((cause) =>
                setError(
                  cause instanceof Error ? cause.message : String(cause),
                ),
              )
              .finally(() => setBusy(false));
          }}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="new-agent-name">Name</Label>
              <Input
                id="new-agent-name"
                required
                autoFocus
                autoComplete="off"
                {...field("name")}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="new-agent-description">Description</Label>
              <Input
                id="new-agent-description"
                required
                {...field("description")}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="new-agent-model">Model (optional)</Label>
              <Input
                id="new-agent-model"
                placeholder="provider/model"
                {...field("model")}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="new-agent-workspace">Workspace (optional)</Label>
              <Input
                id="new-agent-workspace"
                placeholder="/path/to/project"
                {...field("workspace")}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="new-agent-spawns">
                Can spawn (blank allows all)
              </Label>
              <Input
                id="new-agent-spawns"
                placeholder="reviewer, researcher"
                {...field("spawns")}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="new-agent-rooms">Rooms</Label>
              <Input
                id="new-agent-rooms"
                placeholder="#engineering, #ops"
                {...field("rooms")}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="new-agent-body">Soul / system prompt</Label>
            <Textarea
              id="new-agent-body"
              required
              rows={8}
              className="font-mono text-xs"
              {...field("body")}
            />
          </div>
          <p
            id="new-agent-error"
            role="alert"
            className="min-h-5 text-xs text-destructive"
          >
            {error}
          </p>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button id="new-agent-create" type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create agent"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
