import { useMemo, useState } from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { AgentInfo } from "@/lib/types";
import type { ConsoleCall } from "./CreateChannelDialog";

/**
 * Purpose: Confirm and execute destructive agent stop operations with subtree truth.
 * Public API: KillDialog and KillDialogProps.
 * Upstream deps: shadcn AlertDialog/Checkbox and the console operations API.
 * Downstream consumers: AgentPanel operation rows.
 * Failure modes: failed stops remain open with the selected scope intact.
 * Performance: subtree naming is linear in the supplied agent list.
 */

export type KillDialogProps = {
  name: string | null;
  agents: AgentInfo[];
  onOpenChange: (open: boolean) => void;
  call: ConsoleCall;
  onRefresh: () => Promise<void>;
  onNotice: (text: string) => void;
};

export function KillDialog({
  name,
  agents,
  onOpenChange,
  call,
  onRefresh,
  onNotice,
}: KillDialogProps) {
  const [keepChildren, setKeepChildren] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const descendants = useMemo(() => {
    if (!name) return [];
    const found: string[] = [];
    const pending = [name];
    while (pending.length) {
      const parent = pending.shift();
      for (const agent of agents) {
        if (agent.parent !== parent || found.includes(agent.name)) continue;
        found.push(agent.name);
        pending.push(agent.name);
      }
    }
    return found;
  }, [agents, name]);

  const setOpen = (open: boolean) => {
    if (!open && busy) return;
    onOpenChange(open);
    if (!open) {
      setKeepChildren(false);
      setError("");
    }
  };

  if (name === null) return <dialog id="ops-kill-dialog" />;

  return (
    <AlertDialog open={name !== null} onOpenChange={setOpen}>
      <AlertDialogContent
        asChild
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          requestAnimationFrame(() => document.getElementById("ops-kill-cancel")?.focus());
        }}
      >
        <dialog
          id="ops-kill-dialog"
          open={name !== null}
          aria-labelledby="ops-kill-heading"
          aria-describedby="ops-kill-detail"
        >
          <AlertDialogHeader>
            <AlertDialogTitle id="ops-kill-heading">
              Stop {name ?? "agent"}
            </AlertDialogTitle>
            <AlertDialogDescription id="ops-kill-detail">
              {keepChildren
                ? `Stop ${name ?? "this agent"}. Children remain running and move to root.`
                : descendants.length
                  ? `Stop ${name ?? "this agent"} and its subtree: ${descendants.join(", ")}.`
                  : `Stop ${name ?? "this agent"}. It has no known children.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label
            id="ops-kill-keep-label"
            htmlFor="ops-kill-keep"
            className="flex min-h-10 items-center gap-3 rounded-lg border p-3 text-sm"
          >
            <Checkbox
              id="ops-kill-keep"
              checked={keepChildren}
              aria-checked={keepChildren}
              onCheckedChange={(value) => setKeepChildren(value === true)}
            />
            Keep children running
          </label>
          <p
            id="ops-kill-error"
            role="alert"
            className="min-h-5 text-xs text-destructive"
          >
            {error}
          </p>
          <AlertDialogFooter>
            <Button
              id="ops-kill-cancel"
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              id="ops-kill-confirm"
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (!name || busy) return;
                setError("");
                setBusy(true);
                void call(`/api/agents/${encodeURIComponent(name)}/kill`, {
                  method: "POST",
                  body: { keepChildren },
                })
                  .then(async (result) => {
                    onNotice(
                      result.cascaded
                        ? `Stopped ${String(result.name)} and everything under it.`
                        : `Stopped ${String(result.name)}. Its children are still running.`,
                    );
                    await onRefresh();
                    onOpenChange(false);
                    setKeepChildren(false);
                    setError("");
                  })
                  .catch((cause) =>
                    setError(
                      cause instanceof Error ? cause.message : String(cause),
                    ),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? "Stopping…" : "Stop subtree"}
            </Button>
          </AlertDialogFooter>
        </dialog>
      </AlertDialogContent>
    </AlertDialog>
  );
}
