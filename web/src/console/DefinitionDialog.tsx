import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ConsoleCall } from "./CreateChannelDialog";

/**
 * Purpose: Load and patch one agent definition as editable JSON.
 * Public API: DefinitionDialog and DefinitionDialogProps.
 * Upstream deps: shadcn Dialog primitives and console definition endpoints.
 * Downstream consumers: AgentPanel definition actions.
 * Failure modes: load, JSON parser, and API errors remain inline with draft intact.
 * Performance: one GET per open and one PATCH per save attempt.
 */

export type DefinitionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string | null;
  call: ConsoleCall;
  onRefresh: () => Promise<void>;
  onNotice: (text: string) => void;
};

export function DefinitionDialog({
  open,
  onOpenChange,
  name,
  call,
  onRefresh,
  onNotice,
}: DefinitionDialogProps) {
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open || !name) return;
    void call(`/api/agents/${encodeURIComponent(name)}/definition`)
      .then((payload) => {
        const definition = {
          ...(payload.definition as Record<string, unknown>),
        };
        delete definition.name;
        delete definition.sha256;
        setPath(typeof payload.filePath === "string" ? payload.filePath : "");
        const value = JSON.stringify(definition, null, 2);
        requestAnimationFrame(() => {
          if (!textarea.current) return;
          textarea.current.value = value;
          setLoaded(true);
          requestAnimationFrame(() => textarea.current?.focus());
        });
      })
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => setBusy(false));
  }, [call, name, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        id="definition-dialog"
        aria-labelledby="definition-heading"
        className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-2xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          textarea.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle id="definition-heading">
            Edit {name ?? "agent"} definition
          </DialogTitle>
          <DialogDescription
            id="definition-path"
            className="truncate font-mono text-xs"
          >
            {path || "Loading definition…"}
          </DialogDescription>
        </DialogHeader>
        <form
          id="definition-form"
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name || busy || !textarea.current) return;
            let changes: unknown;
            try {
              changes = JSON.parse(textarea.current.value);
              if (
                typeof changes !== "object" ||
                changes === null ||
                Array.isArray(changes)
              ) {
                throw new Error("Changes must be a JSON object.");
              }
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
              return;
            }
            setError("");
            setBusy(true);
            void call(`/api/agents/${encodeURIComponent(name)}`, {
              method: "PATCH",
              body: changes,
            })
              .then(async (result) => {
                onNotice(
                  result.rebuildRequired
                    ? `Saved ${name}. New policy applies on its next turn.`
                    : `Saved ${name}.`,
                );
                await onRefresh();
                onOpenChange(false);
              })
              .catch((cause) =>
                setError(
                  cause instanceof Error ? cause.message : String(cause),
                ),
              )
              .finally(() => setBusy(false));
          }}
        >
          <Label id="definition-changes-label" htmlFor="definition-changes">
            Editable fields as JSON
          </Label>
          <Textarea
            ref={textarea}
            id="definition-changes"
            rows={16}
            aria-label="Definition changes as JSON"
            disabled={!loaded || busy}
          />
          <p
            id="definition-error"
            role="alert"
            className="min-h-5 text-xs text-destructive"
          >
            {error}
          </p>
          <DialogFooter>
            <Button
              id="definition-cancel"
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button id="definition-save" type="submit" disabled={!loaded || busy}>
              {busy ? "Saving…" : "Save definition"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
