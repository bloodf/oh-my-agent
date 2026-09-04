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

/**
 * Purpose: Collect and create one durable room without clearing failed input.
 * Public API: CreateChannelDialog and CreateChannelDialogProps.
 * Upstream deps: shadcn Dialog/form primitives and the console request seam.
 * Downstream consumers: the console shell room rail.
 * Failure modes: API errors stay inline and keep the draft for correction/retry.
 * Performance: one request per submit.
 */

export type ConsoleCall = (
  path: string,
  init?: { method?: string; body?: unknown },
) => Promise<Record<string, unknown>>;

export type CreateChannelDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  call: ConsoleCall;
  onCreated: (id: string) => void;
};

export function CreateChannelDialog({
  open,
  onOpenChange,
  call,
  onCreated,
}: CreateChannelDialogProps) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create room</DialogTitle>
          <DialogDescription>
            Use a channel ID such as #engineering.
          </DialogDescription>
        </DialogHeader>
        <form
          id="new-channel"
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const id = draft.trim();
            if (!id || busy) return;
            setError("");
            setBusy(true);
            void call("/api/channels", { method: "POST", body: { id } })
              .then(() => {
                setDraft("");
                onOpenChange(false);
                onCreated(id);
              })
              .catch((cause) =>
                setError(
                  cause instanceof Error ? cause.message : String(cause),
                ),
              )
              .finally(() => setBusy(false));
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="new-channel-input">Room ID</Label>
            <Input
              id="new-channel-input"
              placeholder="#new-channel"
              autoComplete="off"
              required
              autoFocus
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          </div>
          <p
            id="new-channel-error"
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
            <Button id="new-channel-create" type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create room"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
