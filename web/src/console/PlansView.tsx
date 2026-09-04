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
import { MessageBody } from "./Message";

/**
 * Purpose: List, create, and revise durable room plans through the console API.
 * Public API: PlansView and PlansViewProps.
 * Upstream deps: authenticated ConsoleCall plus shadcn card, dialog, and form primitives.
 * Downstream consumers: console workspace shell.
 * Failure modes: request errors and optimistic revision conflicts stay inline and preserve drafts.
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
  draft: "border-muted-foreground/30 text-muted-foreground",
  active: "border-blue-500/40 bg-blue-500/10 text-blue-600 dark:text-blue-300",
  completed:
    "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
};

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

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
  busy,
  error,
  conflict,
  onOpenChange,
  onSubmit,
  onRefresh,
}: {
  open: boolean;
  plan: RoomPlan | null;
  busy: boolean;
  error: string;
  conflict: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (draft: PlanDraft) => Promise<void>;
  onRefresh: () => Promise<void>;
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
                className="h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
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
                  onClick={() => void onRefresh()}
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
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={busy || !draft.title.trim() || !draft.body.trim()}
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
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
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
		setEditing((current) => current ? (next.find((plan) => plan.id === current.id) ?? null) : null);
    } catch (cause) {
      setPlans([]);
      setError(errorMessage(cause));
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
          setError(errorMessage(cause));
        }
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [call, room, version]);

  const openCreate = () => {
    setEditing(null);
    setSaveError("");
    setConflict(false);
    setDialogKey((value) => value + 1);
    setDialogOpen(true);
  };

  const openEdit = (plan: RoomPlan) => {
    setEditing(plan);
    setSaveError("");
    setConflict(false);
    setDialogOpen(true);
    setDialogKey((value) => value + 1);
  };

  const save = async (draft: PlanDraft) => {
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
      const message = errorMessage(cause);
      setSaveError(message);
      setConflict(message === "PLAN_REVISION_CONFLICT");
    } finally {
      setBusy(false);
    }
  };

  const refreshConflict = async () => {
    await refresh();
    setConflict(false);
    setSaveError("");
  };

  return (
    <section
      className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4 sm:p-6"
      aria-labelledby="plans-heading"
    >
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 id="plans-heading" className="text-xl font-semibold">
            Plans
          </h2>
          <p className="truncate text-sm text-muted-foreground">
            Durable work for #{room}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon"
            disabled={loading}
            aria-label="Refresh plans"
            onClick={() => void refresh()}
          >
            <RefreshCw className={loading ? "animate-spin" : ""} />
          </Button>
          <Button type="button" onClick={openCreate}>
            <Plus />
            New plan
          </Button>
        </div>
      </div>

      <div
        className="mx-auto mt-5 w-full max-w-5xl space-y-3"
        aria-live="polite"
      >
        {loading &&
          plans.length === 0 &&
          [0, 1, 2].map((item) => (
            <Skeleton key={item} className="h-36 w-full" />
          ))}
        {error && (
          <Alert variant="destructive">
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
          <div className="rounded-xl border border-dashed p-10 text-center">
            <p className="font-medium">No plans in this room</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Create the first shared plan to keep decisions and next steps
              durable.
            </p>
            <Button type="button" className="mt-4" onClick={openCreate}>
              <Plus />
              Create plan
            </Button>
          </div>
        )}
        {plans.map((plan) => (
          <Card key={plan.id}>
            <CardHeader>
              <CardTitle className="pr-24">{plan.title}</CardTitle>
              <CardDescription>
                Updated{" "}
                {new Intl.DateTimeFormat(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                }).format(new Date(plan.updatedAt))}{" "}
                by {plan.updatedBy}
              </CardDescription>
              <CardAction className="flex items-center gap-1.5">
                <Badge variant="outline" className={STATUS_STYLE[plan.status]}>
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
            <CardContent className="pb-5">
              <MessageBody body={plan.body} />
            </CardContent>
          </Card>
        ))}
      </div>

      <PlanDialog
        key={dialogKey}
        open={dialogOpen}
        plan={editing}
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
