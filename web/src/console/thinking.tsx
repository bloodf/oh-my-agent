/**
 * Who is mid-turn: actors holding ⏳ on loaded messages. AvatarTile reads this
 * so a default blobatar can take the thinking pose.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { RoomMessage } from "@/lib/types";
import { thinkingActors } from "../../../src/shared/avatar";

const ThinkingContext = createContext<ReadonlySet<string>>(new Set());

export function ThinkingProvider({
  messages,
  children,
}: {
  messages: RoomMessage[];
  children: ReactNode;
}) {
  const actors = useMemo(() => thinkingActors(messages), [messages]);
  return (
    <ThinkingContext.Provider value={actors}>{children}</ThinkingContext.Provider>
  );
}

export function useThinking(author: string): boolean {
  return useContext(ThinkingContext).has(author);
}
