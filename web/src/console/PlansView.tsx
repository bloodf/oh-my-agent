import { FilePenLine, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState, type SyntheticEvent } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import type { ConsoleCall } from "./CreateChannelDialog";
import { errorText, formatDate, hasErrorCode } from "./errors";
import { MessageBody } from "./Message";

/**
 * Purpose: List, create, and revise durable room plans through the console API.
 * Public API: PlansView and PlansViewProps.
 * Upstream deps: authenticated ConsoleCall plus shadcn card, dialog, and form primitives.
 * Downstream consumers: console workspace shell.
 * Failure modes: request errors stay inline and preserve drafts. A revision
 * conflict never re-saves a stale draft: refreshing loads the latest server
 * text into the form and keeps the unsaved draft beside it, read-only, and a
 * plan deleted meanwhile disables saving rather than turning the edit into a create.
 * Performance: one list request per room/version refresh and one request per submitted mutation.
 */

type PlanStatus = "draft" | "active" | "completed";

type RoomPlan = {
  id: string;
  room: string;
  title: string;
  body: string;
  status: PlanStatus;
  revision: number;
  author: string;
  updatedBy: string;
  createdAt: number;
  updatedAt: number;
};

type PlanDraft = { title: string; body: string; status: PlanStatus };

export type PlansViewProps = {
  room: string;
  call: ConsoleCall;
  version?: number;
};

const EMPTY_DRAFT: PlanDraft = { title: "", body: "", status: "draft" };
const STATUS_STYLE: Record<PlanStatus, string> = {
  draft: "border-input bg-muted text-muted-foreground",
  active: "border-[var(--reaction-mine-border)]/50 bg-[var(--reaction-mine-bg)] text-[var(--reaction-mine-text)]",
  completed:
    "border-[var(--presence-active)]/50 bg-[var(--presence-active)]/12 text-[var(--send)] dark:text-[var(--presence-active)]",
};
const SEND_BUTTON = "h-9 px-4 font-bold bg-[var(--send)] text-white hover:bg-[var(--send-hover)]";

function isRoomPlan(value: unknown): value is RoomPlan {
  if (!value || typeof value !== "object") return false;
  const plan = value as Partial<RoomPlan>;
  return (
    typeof plan.id === "string" &&
    typeof plan.title === "string" &&
    typeof plan.body === "string" &&
    (plan.status === "draft" ||
      plan.status === "active" ||
      plan.status === "completed") &&
    typeof plan.revision === "number"
  );
}

function PlanDialog({
  open,
  plan,
  unsaved,
  gone,
  busy,
  error,
  conflict,
  onOpenChange,
  onSubmit,
  onRefresh,
}: {
  open: boolean;
  plan: RoomPlan | null;
  /** The draft a conflict refresh replaced, shown read-only so nothing typed is lost. */
  unsaved: PlanDraft | null;
  /** The edited plan no longer exists on the server. */
  gone: boolean;
  busy: boolean;
  error: string;
  conflict: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (draft: PlanDraft) => Promise<void>;
  onRefresh: (draft: PlanDraft) => Promise<void>;
}) {
  const [draft, setDraft] = useState<PlanDraft>(() => plan ? { title: plan.title, body: plan.body, status: plan.status } : EMPTY_DRAFT);

  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onSubmit(draft);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{plan ? "Edit plan" : "Create plan"}</DialogTitle>
          <DialogDescription>
            {plan
              ? "Save against the revision you opened. Conflicting changes will not be overwritten."
              : "Share a durable Markdown plan with everyone in this room."}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <div className="space-y-1.5">
            <Label htmlFor="plan-title">Title</Label>
            <Input
              id="plan-title"
              autoFocus
              required
              maxLength={200}
              value={draft.title}
              onChange={(event) =>
                setDraft((value) => ({ ...value, title: event.target.value }))
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="plan-body">Plan</Label>
            <Textarea
              id="plan-body"
              required
              className="min-h-56 resize-y font-mono"
              value={draft.body}
              onChange={(event) =>
                setDraft((value) => ({ ...value, body: event.target.value }))
              }
            />
          </div>
          {plan && (
            <div className="space-y-1.5">
              <Label htmlFor="plan-status">Status</Label>
              <select
                id="plan-status"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-[15px] outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
                value={draft.status}
                onChange={(event) =>
                  setDraft((value) => ({
                    ...value,
                    status: event.target.value as PlanStatus,
                  }))
                }
              >
                <option value="draft">Draft</option>
                <option value="active">Active</option>
                <option value="completed">Completed</option>
              </select>
            </div>
          )}
          {unsaved && (
            <div className="space-y-1.5">
              <Label htmlFor="plan-unsaved">Your unsaved draft</Label>
              <p className="text-[13px] text-muted-foreground">
                The form now shows the latest saved plan (revision {plan?.revision}). Copy anything you still need from your draft, then save.
              </p>
              <Textarea
                id="plan-unsaved"
                readOnly
                className="min-h-32 resize-y font-mono"
                value={`# ${unsaved.title}\n\n${unsaved.body}`}
              />
            </div>
          )}
          {gone && (
            <Alert variant="destructive">
              <AlertTitle>This plan no longer exists</AlertTitle>
              <AlertDescription>
                It was removed after you opened it. Your draft stays in the form to copy; saving is disabled.
              </AlertDescription>
            </Alert>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertTitle>
                {conflict ? "This plan changed" : "Could not save plan"}
              </AlertTitle>
              <AlertDescription>{error}</AlertDescription>
              {conflict && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => void onRefresh(draft)}
                >
                  Refresh latest plan
                </Button>
              )}
            </Alert>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="h-9 px-4 font-bold"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className={SEND_BUTTON}
              disabled={busy || gone || !draft.title.trim() || !draft.body.trim()}
            >
              {busy ? "Saving…" : plan ? "Save changes" : "Create plan"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function PlansView({ room, call, version }: PlansViewProps) {
  const [plans, setPlans] = useState<RoomPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogKey, setDialogKey] = useState(0);
  const [editing, setEditing] = useState<RoomPlan | null>(null);
  const [saveError, setSaveError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [unsaved, setUnsaved] = useState<PlanDraft | null>(null);
  const [gone, setGone] = useState(false);
  const [busy, setBusy] = useState(false);

  /** Re-read the room's plans; answers the list, or null when the read failed. */
  const refresh = useCallback(async (): Promise<RoomPlan[] | null> => {
    setLoading(true);
    setError("");
    try {
      const payload = await call(
        `/api/channels/${encodeURIComponent(room)}/plans`,
      );
      const next = Array.isArray(payload.plans)
        ? payload.plans.filter(isRoomPlan)
        : [];
      setPlans(next);
      return next;
    } catch (cause) {
      setPlans([]);
      setError(errorText(cause));
      return null;
    } finally {
      setLoading(false);
    }
  }, [call, room]);

  useEffect(() => {
    let current = true;
    void call(`/api/channels/${encodeURIComponent(room)}/plans`)
      .then((payload) => {
        if (!current) return;
        setError("");
        setPlans(Array.isArray(payload.plans) ? payload.plans.filter(isRoomPlan) : []);
      })
      .catch((cause) => {
        if (current) {
          setPlans([]);
          setError(errorText(cause));
        }
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [call, room, version]);

  const resetDialog = () => {
    setSaveError("");
    setConflict(false);
    setUnsaved(null);
    setGone(false);
  };

  const openCreate = () => {
    setEditing(null);
    resetDialog();
    setDialogKey((value) => value + 1);
    setDialogOpen(true);
  };

  const openEdit = (plan: RoomPlan) => {
    setEditing(plan);
    resetDialog();
    setDialogOpen(true);
    setDialogKey((value) => value + 1);
  };

  const save = async (draft: PlanDraft) => {
    if (gone) return;
    setBusy(true);
    setSaveError("");
    setConflict(false);
    try {
      const path = editing
        ? `/api/channels/${encodeURIComponent(room)}/plans/${encodeURIComponent(editing.id)}`
        : `/api/channels/${encodeURIComponent(room)}/plans`;
      const body = editing
        ? { ...draft, expectedRevision: editing.revision }
        : { title: draft.title, body: draft.body };
      const payload = await call(path, {
        method: editing ? "PATCH" : "POST",
        body,
      });
      if (!isRoomPlan(payload.plan))
        throw new Error("Server returned an invalid plan.");
      const saved = payload.plan;
      setPlans((current) =>
        editing
          ? current.map((plan) => (plan.id === saved.id ? saved : plan))
          : [saved, ...current],
      );
      setDialogOpen(false);
      setEditing(null);
    } catch (cause) {
      const isConflict = hasErrorCode(cause, "PLAN_REVISION_CONFLICT");
      setConflict(isConflict);
      setSaveError(
        isConflict
          ? "Someone saved this plan after you opened it. Refresh to load their version before saving again."
          : errorText(cause),
      );
    } finally {
      setBusy(false);
    }
  };

  /**
   * Load the latest server copy into the form. The stale draft is never kept
   * as the editable text: it moves to a read-only block, so the next save
   * carries only what the user sees against the revision it was read at.
   */
  const refreshConflict = async (draft: PlanDraft) => {
    if (!editing) return;
    const next = await refresh();
    if (next === null) {
      setSaveError("Could not load the latest plan. Try again.");
      return;
    }
    const latest = next.find((plan) => plan.id === editing.id);
    setConflict(false);
    setSaveError("");
    if (latest) {
      setUnsaved(draft);
      setEditing(latest);
      setDialogKey((value) => value + 1);
    } else {
      // Keep editing the vanished plan so the dialog never flips to Create.
      setGone(true);
    }
  };

  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto px-4 py-5 sm:px-8 sm:py-7"
      aria-labelledby="plans-heading"
    >
      <div className="flex w-full min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="min-w-40 flex-1 basis-0">
          <h2 id="plans-heading" className="text-[22px] leading-7 font-black">
            Plans
          </h2>
          <p className="truncate text-[15px] text-muted-foreground">
            Durable work for {room.startsWith("#") ? room : `#${room}`}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon-lg"
            disabled={loading}
            aria-label="Refresh plans"
            onClick={() => void refresh()}
          >
            <RefreshCw className={loading ? "animate-spin" : ""} />
          </Button>
          <Button type="button" className={SEND_BUTTON} onClick={openCreate}>
            <Plus />
            New plan
          </Button>
        </div>
      </div>

      <div
        className="mt-6 grid w-full min-w-0 grid-cols-[repeat(auto-fill,minmax(min(100%,22rem),1fr))] items-start gap-4"
        aria-live="polite"
      >
        {loading &&
          plans.length === 0 &&
          [0, 1, 2].map((item) => (
            <Skeleton key={item} className="h-40 w-full rounded-lg" />
          ))}
        {error && (
          <Alert variant="destructive" className="col-span-full">
            <AlertTitle>Could not load plans</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => void refresh()}
            >
              Try again
            </Button>
          </Alert>
        )}
        {!loading && !error && plans.length === 0 && (
          <div className="col-span-full rounded-lg border border-dashed px-6 py-14 text-center">
            <p className="text-lg font-black">No plans in this room</p>
            <p className="mx-auto mt-1 max-w-sm text-[15px] text-muted-foreground">
              Create the first shared plan to keep decisions and next steps
              durable.
            </p>
            <Button type="button" className={`mt-5 ${SEND_BUTTON}`} onClick={openCreate}>
              <Plus />
              Create plan
            </Button>
          </div>
        )}
        {plans.map((plan) => (
          <Card key={plan.id} className="min-w-0 gap-0 py-0 shadow-[0_1px_3px_rgb(0_0_0/6%)] transition-shadow hover:shadow-[var(--shadow-float)]">
            <CardHeader className="border-b py-4">
              <CardTitle className="pr-24 text-lg leading-6 font-black">{plan.title}</CardTitle>
              <CardDescription className="text-[13px]">
                Updated{" "}
                {formatDate(plan.updatedAt, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}{" "}
                by {plan.updatedBy}
              </CardDescription>
              <CardAction className="flex items-center gap-1.5">
                <Badge variant="outline" className={`capitalize ${STATUS_STYLE[plan.status]}`}>
                  {plan.status}
                </Badge>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Edit ${plan.title}`}
                  onClick={() => openEdit(plan)}
                >
                  <FilePenLine />
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="max-w-prose min-w-0 py-4 text-[15px] leading-[1.46]">
              <MessageBody body={plan.body} />
            </CardContent>
          </Card>
        ))}
      </div>

      <PlanDialog
        key={dialogKey}
        open={dialogOpen}
        plan={editing}
        unsaved={unsaved}
        gone={gone}
        busy={busy}
        error={saveError}
        conflict={conflict}
        onOpenChange={(open) => {
          if (!busy) setDialogOpen(open);
        }}
        onSubmit={save}
        onRefresh={refreshConflict}
      />
    </section>
  );
}
