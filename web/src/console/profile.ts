/**
 * Purpose: The display profile the console draws authors with — what the
 * operator is called and drawn as, and a name and avatar per agent — read
 * from `/api/profile` and shared through a context so every message,
 * thread, and panel resolves an author the same way.
 *
 * Upstream deps: React context. The wire author (`@you`, a peer name) is
 * never changed; only its presentation is.
 *
 * Downstream consumers: `Message.tsx`, `ProfileDialog.tsx`, `ConsoleShell`
 * (provides it), `useConsole` (loads it).
 */
import { createContext, useContext } from "react";
import { HUMAN_AUTHOR } from "@/lib/types";
import {
  isImageAvatar,
  resolveAvatar,
  type ResolvedAvatar,
} from "../../../src/shared/avatar";

export { isImageAvatar, resolveAvatar, type ResolvedAvatar };

export type Persona = { displayName?: string; avatar?: string };
export type Profile = { operator: Persona; agents: Record<string, Persona> };

export const EMPTY_PROFILE: Profile = { operator: {}, agents: {} };

export const ProfileContext = createContext<Profile>(EMPTY_PROFILE);

export function useProfile(): Profile {
  return useContext(ProfileContext);
}

/** How to draw one author: the profile's name, and a stored avatar if any. */
export function personaFor(profile: Profile, author: string): { name: string; avatar: string } {
  const persona = author === HUMAN_AUTHOR ? profile.operator : profile.agents[author];
  return {
    name: persona?.displayName ?? author,
    avatar: persona?.avatar ?? "",
  };
}
