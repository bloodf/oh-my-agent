import { Bot, MessageSquare, Search, SquarePen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeSelector } from "./ThemeSelector";

export function WorkspaceToolbar({ onSearch }: { onSearch: () => void }) {
  return (
    <div role="toolbar" aria-label="Global workspace controls" className="grid h-12 shrink-0 grid-cols-[minmax(0,1fr)_auto] gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(9rem,32rem)_minmax(0,1fr)] items-center bg-[var(--workspace-bar)] px-2 text-[var(--workspace-foreground)]">
      <span className="hidden truncate px-2 text-xs font-semibold sm:block">oh-my-agent</span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-11 justify-start border border-[var(--workspace-border)] bg-[var(--workspace-bar)] text-[var(--workspace-foreground)] hover:bg-[var(--workspace-accent)] hover:text-[var(--workspace-accent-foreground)]"
        aria-label="Search conversations and actions"
        onClick={onSearch}
      >
        <Search className="size-3.5" />
        <span className="truncate">Search</span>
        <kbd className="ml-auto hidden text-[10px] opacity-75 sm:inline">⌘K</kbd>
      </Button>
      <div className="flex justify-end">
        <ThemeSelector />
      </div>
    </div>
  );
}

export function WorkspaceNavigation({ onConversations, onAgents, onNewChat }: {
  onConversations: () => void;
  onAgents: () => void;
  onNewChat: () => void;
}) {
  return (
    <nav aria-label="Workspace" className="hidden w-12 shrink-0 flex-col items-center gap-1 bg-[var(--workspace-bar)] py-2 text-[var(--workspace-foreground)] md:flex">
      <Button type="button" variant="ghost" size="icon" className="text-[var(--workspace-foreground)] hover:bg-[var(--workspace-accent)] hover:text-[var(--workspace-accent-foreground)]" aria-label="Conversations" aria-current="page" onClick={onConversations}><MessageSquare /></Button>
      <Button type="button" variant="ghost" size="icon" className="text-[var(--workspace-foreground)] hover:bg-[var(--workspace-accent)] hover:text-[var(--workspace-accent-foreground)]" aria-label="Manage agents" onClick={onAgents}><Bot /></Button>
      <Button type="button" variant="ghost" size="icon" className="text-[var(--workspace-foreground)] hover:bg-[var(--workspace-accent)] hover:text-[var(--workspace-accent-foreground)]" aria-label="New OMP chat" onClick={onNewChat}><SquarePen /></Button>
    </nav>
  );
}
