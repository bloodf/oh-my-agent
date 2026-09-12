/**
 * Purpose: Edit the display profile — the operator's name and avatar, and a
 * name and avatar per agent — and save it to the daemon so every console
 * shows the same.
 *
 * Upstream deps: shadcn Dialog, Input, Label, Button; the profile context.
 *
 * Downstream consumers: `WorkspaceToolbar` opens it.
 *
 * Failure modes: the daemon's refusal (a field too long, a bad agent name)
 * is shown under the form; nothing is saved until every field is accepted.
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AgentInfo } from "@/lib/types";
import type { ConsoleCall } from "./CreateChannelDialog";
import { type Persona, type Profile, useProfile } from "./profile";

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
  useEffect(() => {
    if (open) {
      setDraft({ operator: { ...profile.operator }, agents: { ...profile.agents } });
      setError("");
    }
  }, [open, profile]);
  const setOperator = (key: keyof Persona, value: string) =>
    setDraft((current) => ({ ...current, operator: { ...current.operator, [key]: value } }));
  const setAgent = (name: string, key: keyof Persona, value: string) =>
    setDraft((current) => ({ ...current, agents: { ...current.agents, [name]: { ...current.agents[name], [key]: value } } }));
  const names = [...new Set([...agents.map((a) => a.name), ...Object.keys(draft.agents)])].sort();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-1rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Profile and avatars</DialogTitle>
          <DialogDescription>How you and the agents are shown in every console. Names on the wire do not change.</DialogDescription>
        </DialogHeader>
        <form id="profile-form" className="grid gap-4" onSubmit={(event) => {
          event.preventDefault(); if (busy) return;
          setError(""); setBusy(true);
          const agentsPatch: Record<string, Persona> = {};
          for (const name of names) agentsPatch[name] = { displayName: draft.agents[name]?.displayName ?? "", avatar: draft.agents[name]?.avatar ?? "" };
          void call("/api/profile", { method: "PUT", body: { operator: { displayName: draft.operator.displayName ?? "", avatar: draft.operator.avatar ?? "" }, agents: agentsPatch } })
            .then((result) => { onSaved(result.profile as Profile); onOpenChange(false); })
            .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
            .finally(() => setBusy(false));
        }}>
          <fieldset className="grid gap-3 rounded-lg border p-3">
            <legend className="px-1 text-sm font-medium">You</legend>
            <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-3">
              <div className="grid gap-1.5"><Label htmlFor="profile-operator-name">Display name</Label><Input id="profile-operator-name" placeholder="@you" maxLength={40} value={draft.operator.displayName ?? ""} onChange={(e) => setOperator("displayName", e.target.value)} /></div>
              <div className="grid gap-1.5"><Label htmlFor="profile-operator-avatar">Avatar</Label><Input id="profile-operator-avatar" placeholder="🙂" maxLength={8} value={draft.operator.avatar ?? ""} onChange={(e) => setOperator("avatar", e.target.value)} /></div>
            </div>
          </fieldset>
          <fieldset className="grid gap-2 rounded-lg border p-3">
            <legend className="px-1 text-sm font-medium">Agents</legend>
            <p className="text-xs text-muted-foreground">An emoji or up to four characters for the avatar. Leave a field empty to show the agent's own name.</p>
            {names.length === 0 && <p className="text-xs text-muted-foreground">No agents yet.</p>}
            {names.map((name) => (
              <div key={name} className="grid grid-cols-[7rem_minmax(0,1fr)_6rem] items-center gap-2" data-agent={name}>
                <span className="truncate text-sm font-medium" title={name}>{name}</span>
                <Input aria-label={`${name} display name`} placeholder={name} maxLength={40} value={draft.agents[name]?.displayName ?? ""} onChange={(e) => setAgent(name, "displayName", e.target.value)} />
                <Input aria-label={`${name} avatar`} placeholder="🤖" maxLength={8} value={draft.agents[name]?.avatar ?? ""} onChange={(e) => setAgent(name, "avatar", e.target.value)} />
              </div>
            ))}
          </fieldset>
          <p role="alert" className="min-h-5 text-xs text-destructive">{error}</p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button id="profile-save" type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
