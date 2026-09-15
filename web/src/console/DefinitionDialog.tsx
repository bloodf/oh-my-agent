import { useCallback, useEffect, useRef, useState } from "react";
import { Braces, Clock, Cpu, FileText, Hash, Shield, UserRound, Zap, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { AgentInfo } from "@/lib/types";
import type { ConsoleCall } from "./CreateChannelDialog";
import { ModelSection, type ModelCatalog, ProfileSection, RoomsSection, SoulSection } from "./definition/identity-sections";
import { buildPatch, type Definition, forEditing, isBlank } from "./definition/model";
import { SandboxSection, SchedulesSection, WakeSection } from "./definition/policy-sections";
import { type Persona, useProfile } from "./profile";

/**
 * Purpose: The agent settings dialog — every editable field of one agent's
 * definition in sections, its display profile, and the raw JSON as a
 * fallback — saved as a PATCH carrying only what changed.
 * Public API: DefinitionDialog and DefinitionDialogProps.
 * Upstream deps: shadcn Dialog; `/api/agents/:name/definition`,
 * `PATCH /api/agents/:name`, `/api/models`, `/api/channels`, `PUT /api/profile`.
 * Downstream consumers: AgentPanel definition actions.
 * Failure modes: load, JSON parser, and API errors remain inline with the
 * draft intact. A profile write that fails after the definition PATCH landed
 * reports the definition as saved. The account spending ceiling is shown read-only and carried
 * forward on save; a draft that changes it is refused before any request.
 * Performance: one definition, model, and channel read per open; one PATCH
 * and at most one profile PUT per save.
 */

export type DefinitionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string | null;
  call: ConsoleCall;
  onRefresh: () => Promise<void>;
  onNotice: (text: string) => void;
  agents?: AgentInfo[];
  fullControl?: boolean;
};

type SectionId = "soul" | "profile" | "model" | "rooms" | "wake" | "schedules" | "sandbox" | "json";

const SECTIONS: { id: SectionId; label: string; icon: LucideIcon }[] = [
  { id: "soul", label: "Soul", icon: FileText },
  { id: "profile", label: "Profile", icon: UserRound },
  { id: "model", label: "Model", icon: Cpu },
  { id: "rooms", label: "Rooms & hierarchy", icon: Hash },
  { id: "wake", label: "Wake & autonomy", icon: Zap },
  { id: "schedules", label: "Schedules & automations", icon: Clock },
  { id: "sandbox", label: "Sandbox & tools", icon: Shield },
  { id: "json", label: "Advanced JSON", icon: Braces },
];

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export function DefinitionDialog({ open, onOpenChange, name, call, onRefresh, onNotice, agents = [], fullControl = true }: DefinitionDialogProps) {
  const profile = useProfile();
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [loaded, setLoaded] = useState<Record<string, unknown> | null>(null);
  const [draft, setDraft] = useState<Definition>({});
  const [section, setSection] = useState<SectionId>("soul");
  const [catalog, setCatalog] = useState<ModelCatalog>({ models: [] });
  const [channels, setChannels] = useState<string[]>([]);
  const savedPersona = (name && profile.agents[name]) || {};
  const [persona, setPersona] = useState<Persona>(savedPersona);
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open || !name) return;
    void call(`/api/agents/${encodeURIComponent(name)}/definition`)
      .then((payload) => {
        const definition = { ...(payload.definition as Record<string, unknown>) };
        setPath(typeof payload.filePath === "string" ? payload.filePath : "");
        setLoaded(definition);
        setDraft(forEditing(definition));
      })
      .catch((cause) => setError(message(cause)))
      .finally(() => setBusy(false));
    void call("/api/models").then((result) => setCatalog(result as ModelCatalog)).catch(() => setCatalog({ models: [] }));
    void call("/api/channels")
      .then((result) => setChannels(((result.channels as { id: string }[] | undefined) ?? []).map((channel) => channel.id)))
      .catch(() => setChannels([]));
  }, [call, name, open]);

  // The JSON view always mirrors the draft; typing there is read back on blur
  // and again on save, so the two never disagree about what will be sent.
  useEffect(() => {
    if (textarea.current && loaded) textarea.current.value = JSON.stringify(draft, null, 2);
  }, [draft, loaded]);

  // Focus follows into the editor once there is something to edit.
  useEffect(() => {
    if (loaded) requestAnimationFrame(() => document.getElementById("definition-body")?.focus());
  }, [loaded]);

  /** Write one field; an emptied field the definition never had stays unset. */
  const set = useCallback(<K extends keyof Definition>(key: K, value: Definition[K]) => {
    setDraft((current) => {
      const next = { ...current };
      if (value === undefined || (isBlank(value) && loaded?.[key as string] === undefined)) delete next[key];
      else next[key] = value;
      return next;
    });
  }, [loaded]);

  /** The candidate definition from the JSON view: the loaded one with the JSON laid over it. */
  const readJson = (): Record<string, unknown> => {
    const parsed: unknown = JSON.parse(textarea.current?.value ?? "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Changes must be a JSON object.");
    return { ...forEditing(loaded ?? {}), ...(parsed as Record<string, unknown>) };
  };

  const save = async () => {
    if (!name || !loaded) return;
    const patch = buildPatch(loaded, readJson());
    const personaChanged = (persona.displayName ?? "") !== (savedPersona.displayName ?? "") || (persona.avatar ?? "") !== (savedPersona.avatar ?? "");
    if (Object.keys(patch).length === 0 && !personaChanged) {
      onOpenChange(false);
      return;
    }
    let rebuildRequired = false;
    const patched = Object.keys(patch).length > 0;
    if (patched) {
      const result = await call(`/api/agents/${encodeURIComponent(name)}`, { method: "PATCH", body: patch });
      rebuildRequired = result.rebuildRequired === true;
    }
    if (personaChanged) {
      try {
        await call("/api/profile", { method: "PUT", body: { agents: { [name]: { displayName: persona.displayName ?? "", avatar: persona.avatar ?? "" } } } });
      } catch (cause) {
        if (!patched) throw cause;
        // The definition is already saved; say so rather than implying nothing was.
        await onRefresh().catch(() => {});
        throw new Error(`Saved ${name}'s definition, but its name and avatar were not saved: ${message(cause)}`);
      }
    }
    onNotice(rebuildRequired ? `Saved ${name}. New policy applies on its next turn.` : `Saved ${name}.`);
    await onRefresh();
    onOpenChange(false);
  };

  const disabled = !loaded || busy;
  const budgetUsd = (loaded?.autonomy as Definition["autonomy"])?.budgetUsd;
  const props = { draft, set, disabled };
  // Without full control the daemon accepts only name, description, model,
  // thinking level, and rooms; every other policy field is locked here.
  // Only remote connections are restricted; a loopback console composed
  // without workspace routes also reports fullControl false.
  const locked = !fullControl && document.documentElement.dataset.authMode === "remote";
  const policyProps = { draft, set, disabled: disabled || locked };
  const LOCKED: SectionId[] = ["soul", "wake", "schedules", "sandbox", "json"];
  const current = SECTIONS.find((entry) => entry.id === section);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        id="definition-dialog"
        aria-labelledby="definition-heading"
        className="slack-modal flex h-[min(46rem,calc(100svh-1rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          document.getElementById("definition-body")?.focus();
        }}
      >
        <header className="shrink-0 border-b px-5 py-4 pr-14 sm:px-7">
          <DialogTitle id="definition-heading" className="truncate text-xl font-bold">{name ?? "Agent"} settings</DialogTitle>
          <DialogDescription id="definition-path" className="truncate font-mono text-[13px]">{path || (loaded ? "" : "Loading definition…")}</DialogDescription>
        </header>
        <form
          id="definition-form"
          className="flex min-h-0 flex-1 flex-col sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name || disabled) return;
            setError("");
            setBusy(true);
            void save().catch((cause) => setError(message(cause))).finally(() => setBusy(false));
          }}
        >
          <nav aria-label="Settings sections" className="flex shrink-0 gap-1 overflow-x-auto border-b px-3 py-2 sm:w-60 sm:flex-col sm:overflow-x-visible sm:overflow-y-auto sm:border-r sm:border-b-0 sm:py-3">
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                id={`definition-section-${id}`}
                aria-current={section === id ? "page" : undefined}
                onClick={() => setSection(id)}
                className={`flex h-9 shrink-0 items-center gap-2 rounded-md px-2.5 text-left text-[15px] whitespace-nowrap transition-colors max-sm:h-11 ${section === id ? "bg-[var(--send)] font-semibold text-white" : "text-foreground hover:bg-[var(--surface-hover)]"}`}
              >
                <Icon aria-hidden className="size-4 shrink-0" />
                {label}
              </button>
            ))}
          </nav>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-7" aria-label={current?.label}>
              {locked && LOCKED.includes(section) && (
                <p id="definition-remote" className="mb-4 rounded-md border bg-muted px-3 py-2 text-[13px] text-muted-foreground">
                  Full control is disabled for this remote connection. Only the description, model, thinking level, and rooms can be changed here.
                </p>
              )}
              <div hidden={section !== "soul"} className="flex h-full min-h-[22rem] flex-col"><SoulSection {...policyProps} /></div>
              {name && section === "profile" && <ProfileSection {...props} name={name} persona={persona} onPersona={setPersona} />}
              {section === "model" && <ModelSection {...props} catalog={catalog} />}
              {section === "rooms" && <RoomsSection {...props} channels={channels} agentNames={agents.map((agent) => agent.name).filter((entry) => entry !== name)} fullControl={fullControl} call={call} />}
              {section === "wake" && <WakeSection {...policyProps} budgetUsd={budgetUsd} />}
              {name && section === "schedules" && <SchedulesSection {...policyProps} name={name} call={call} />}
              {section === "sandbox" && <SandboxSection {...policyProps} />}
              <div hidden={section !== "json"} className="grid gap-3">
                <Label id="definition-changes-label" htmlFor="definition-changes">Editable fields as JSON</Label>
                <p className="text-[13px] text-muted-foreground">Every field the sections edit, plus the rest of the definition. A field left out is unchanged.{budgetUsd !== undefined ? " The spending ceiling is managed outside the console and is kept on save." : ""}</p>
                <Textarea
                  ref={textarea}
                  id="definition-changes"
                  rows={20}
                  spellCheck={false}
                  className="font-mono text-[13px] leading-5"
                  aria-label="Definition changes as JSON"
                  disabled={disabled || locked}
                  onBlur={() => {
                    try {
                      setDraft(readJson() as Definition);
                    } catch {
                      // Left as typed; saving reports the parse error.
                    }
                  }}
                />
              </div>
            </div>
            <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t px-5 py-3 sm:px-7">
              <p id="definition-error" role="alert" className="mr-auto min-h-5 min-w-0 basis-full text-[13px] text-destructive sm:basis-auto sm:flex-1">{error}</p>
              <Button id="definition-cancel" type="button" variant="outline" className="h-9 px-4 font-bold max-sm:h-11" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button id="definition-save" type="submit" className="h-9 px-4 font-bold bg-[var(--send)] text-white hover:bg-[var(--send-hover)] max-sm:h-11" disabled={disabled}>{busy && loaded ? "Saving…" : "Save changes"}</Button>
            </footer>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
