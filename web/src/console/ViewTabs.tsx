import type { ReactNode } from "react";
import { Folder } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * Purpose: The view tab row under the channel header — Conversation, Plans,
 * Changes, Artifacts — with the working directory chip.
 * Public API: ViewTabs, ConsoleView.
 * Upstream deps: shadcn Tabs.
 * Downstream consumers: ConsoleShell and the storybook frame, so the two
 * cannot drift apart on this row.
 * Failure modes: none; purely presentational.
 */
export type ConsoleView = "conversation" | "plans" | "changes" | "artifacts";

export function ViewTabs({
  view,
  onViewChange,
  changesDisabled = false,
  directory,
  children,
}: {
  view: string;
  onViewChange: (view: ConsoleView) => void;
  changesDisabled?: boolean;
  directory?: string;
  /** Extra controls before the directory chip, such as a chat's Stop button. */
  children?: ReactNode;
}) {
  return (
    <div className="@container/tabs flex h-9 min-w-0 shrink-0 items-center gap-3 border-b pr-3 pl-2 sm:pr-4 sm:pl-3">
      <Tabs value={view} onValueChange={(next) => onViewChange(next as ConsoleView)} className="h-full min-w-0 overflow-x-auto overscroll-x-contain [scrollbar-width:none]">
        <TabsList variant="line" className="h-full">
          <TabsTrigger value="conversation">Conversation</TabsTrigger>
          <TabsTrigger value="plans">Plans</TabsTrigger>
          <TabsTrigger value="changes" disabled={changesDisabled}>
            Changes
          </TabsTrigger>
          <TabsTrigger value="artifacts">Artifacts</TabsTrigger>
        </TabsList>
      </Tabs>
      <span className="flex-1" />
      {children}
      {directory && (
        <span title={directory} className="hidden h-6 max-w-[45%] min-w-0 shrink-[999] items-center gap-1.5 rounded-md bg-muted px-2 text-[12px] text-muted-foreground @[34rem]/tabs:flex">
          <Folder aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">{directory}</span>
        </span>
      )}
    </div>
  );
}
