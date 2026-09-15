/**
 * Purpose: Edit the display profile — the operator's name and avatar, and a
 * name and avatar per agent — and save it to the daemon so every console
 * shows the same. An avatar is an emoji, up to four characters, or an image.
 *
 * Upstream deps: shadcn Dialog, Input, Label, Button; the profile context;
 * `AvatarEditor`.
 *
 * Downstream consumers: `WorkspaceToolbar` opens it.
 *
 * Failure modes: the daemon's refusal (a field too long, a bad image, a bad
 * agent name) is shown under the form; nothing is saved until every field is
 * accepted. Only changed personas are sent, so several image avatars never
 * add up past the daemon's request size limit. The draft is seeded on open: a
 * profile broadcast from another console while this one is open never wipes
 * unsaved edits.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AgentInfo } from "@/lib/types";
import { HUMAN_AUTHOR } from "@/lib/types";
import type { ConsoleCall } from "./CreateChannelDialog";
import { AvatarEditor } from "./definition/AvatarEditor";
import { EMPTY_PROFILE, type Persona, type Profile, personaFor, useProfile } from "./profile";

const wire = (persona: Persona | undefined): Persona => ({ displayName: persona?.displayName ?? "", avatar: persona?.avatar ?? "" });
const seed = (profile: Profile): Profile => ({ operator: { ...profile.operator }, agents: { ...profile.agents } });
const samePersona = (a: Persona | undefined, b: Persona | undefined) =>
  (a?.displayName ?? "") === (b?.displayName ?? "") && (a?.avatar ?? "") === (b?.avatar ?? "");

export function ProfileDialog({ open, onOpenChange, call, agents, onSaved }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  call: ConsoleCall;
  agents: AgentInfo[];
  onSaved: (profile: Profile) => void;
}) {
  const profile = useProfile();
  const [draft, setDraft] = useState<Profile>(profile);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  /** The profile the draft was seeded from; null while closed. */
  const [base, setBase] = useState<Profile | null>(null);
  // Adjusting state while rendering. The draft is seeded when the dialog
  // opens, and follows a newer profile only while nothing has been edited.
  if (open && base !== profile && (base === null || JSON.stringify(draft) === JSON.stringify(seed(base)))) {
    setBase(profile);
    setDraft(seed(profile));
    if (base === null) setError("");
  } else if (!open && base !== null) {
    setBase(null);
  }
  const setOperator = (key: keyof Persona, value: string) =>
    setDraft((current) => ({ ...current, operator: { ...current.operator, [key]: value } }));
  const setAgent = (name: string, key: keyof Persona, value: string) =>
    setDraft((current) => ({ ...current, agents: { ...current.agents, [name]: { ...current.agents[name], [key]: value } } }));
  const names = [...new Set([...agents.map((a) => a.name), ...Object.keys(draft.agents)])].sort();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="slack-modal max-h-[calc(100svh-1rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Profile and avatars</DialogTitle>
          <DialogDescription>How you and the agents are shown in every console. Names on the wire do not change.</DialogDescription>
        </DialogHeader>
        <form id="profile-form" className="grid gap-4" onSubmit={(event) => {
          event.preventDefault(); if (busy) return;
          const body: { operator?: Persona; agents?: Record<string, Persona> } = {};
          if (!samePersona(draft.operator, profile.operator)) body.operator = wire(draft.operator);
          const agentsPatch: Record<string, Persona> = {};
          for (const name of names) if (!samePersona(draft.agents[name], profile.agents[name])) agentsPatch[name] = wire(draft.agents[name]);
          if (Object.keys(agentsPatch).length) body.agents = agentsPatch;
          if (!body.operator && !body.agents) { onOpenChange(false); return; }
          setError(""); setBusy(true);
          void call("/api/profile", { method: "PUT", body })
            .then((result) => { onSaved(result.profile as Profile); onOpenChange(false); })
            .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
            .finally(() => setBusy(false));
        }}>
          <fieldset className="grid gap-3 rounded-lg border p-4">
            <legend className="px-1 text-[13px] font-bold text-muted-foreground">You</legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
              <div className="grid gap-1.5"><Label htmlFor="profile-operator-name">Display name</Label><Input id="profile-operator-name" placeholder="@you" maxLength={40} value={draft.operator.displayName ?? ""} onChange={(e) => setOperator("displayName", e.target.value)} /></div>
              <div className="grid gap-1.5"><Label htmlFor="profile-operator-avatar">Avatar</Label><AvatarEditor id="profile-operator-avatar" label="Your avatar" value={draft.operator.avatar ?? ""} onChange={(value) => setOperator("avatar", value)} fallback={personaFor(EMPTY_PROFILE, HUMAN_AUTHOR).avatar} /></div>
            </div>
          </fieldset>
          <fieldset className="grid gap-2 rounded-lg border p-4">
            <legend className="px-1 text-[13px] font-bold text-muted-foreground">Agents</legend>
            <p className="text-[13px] text-muted-foreground">An emoji, up to four characters, or an uploaded image. Leave a field empty to show the agent's own name.</p>
            {names.length === 0 && <p className="py-4 text-center text-[15px] text-muted-foreground">No agents yet.</p>}
            {names.map((name) => (
              <div key={name} className="grid min-h-11 grid-cols-[minmax(0,1fr)] items-center gap-2 border-t pt-2 first-of-type:border-t-0 sm:grid-cols-[7rem_minmax(0,1fr)_auto] sm:border-t-0 sm:pt-0" data-agent={name}>
                <span className="truncate text-[15px] font-bold" title={name}>{name}</span>
                <Input id={`profile-agent-${name}-name`} aria-label={`${name} display name`} placeholder={name} maxLength={40} value={draft.agents[name]?.displayName ?? ""} onChange={(e) => setAgent(name, "displayName", e.target.value)} />
                <AvatarEditor label={`${name} avatar`} placeholder="🤖" value={draft.agents[name]?.avatar ?? ""} onChange={(value) => setAgent(name, "avatar", value)} fallback={personaFor(EMPTY_PROFILE, name).avatar} />
              </div>
            ))}
          </fieldset>
          <p role="alert" className="-my-2 min-h-5 text-[13px] text-destructive">{error}</p>
          <DialogFooter>
            <Button type="button" variant="outline" className="h-9 px-4 font-bold" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button id="profile-save" type="submit" className="h-9 px-4 font-bold bg-[var(--send)] text-white hover:bg-[var(--send-hover)]" disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
