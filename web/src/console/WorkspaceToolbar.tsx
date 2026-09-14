import type { ComponentType, ReactNode } from "react";
import { Bot, House, Search, SquarePen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HUMAN_AUTHOR } from "@/lib/types";
import { ThemeSelector } from "./ThemeSelector";
import { isImageAvatar, personaFor, useProfile } from "./profile";

/** Square avatar tile: an uploaded image, an emoji, or initials from the profile, sized by the caller. */
export function AvatarTile({ author, className = "", children }: { author: string; className?: string; children?: ReactNode }) {
  const { avatar } = personaFor(useProfile(), author);
  const image = isImageAvatar(avatar);
  const glyph = !image && [...avatar].length <= 2 && /\p{Extended_Pictographic}/u.test(avatar);
  return (
    <span aria-hidden className={`relative inline-flex shrink-0 select-none items-center justify-center rounded-md bg-[var(--ws-tile)] font-bold leading-none text-[var(--ws-tile-text)] ${glyph ? "text-[0.9em]" : "text-[0.6em] uppercase"} ${className}`}>
      {image ? <img src={avatar} alt="" className="size-full rounded-[inherit] object-cover" /> : avatar}
      {children}
    </span>
  );
}

export function WorkspaceToolbar({ onSearch, onProfile }: { onSearch: () => void; onProfile: () => void }) {
  return (
    <div role="toolbar" aria-label="Global workspace controls" className="ws-toolbar-surface relative z-10 flex h-11 shrink-0 items-center gap-2 px-2 md:pr-3 md:pl-0">
      <span aria-hidden className="hidden w-[316px] shrink-0 md:block" />
      <div className="flex min-w-0 flex-1 justify-center">
        <button
          type="button"
          aria-label="Search conversations and actions"
          onClick={onSearch}
          className="flex h-7 w-full max-w-[720px] min-w-0 items-center gap-2 rounded-md border border-[var(--ws-border)] bg-[var(--ws-search)] px-2.5 text-[13px] text-[var(--ws-text-dim)] shadow-[inset_0_1px_0_rgb(255_255_255/6%)] transition-colors hover:bg-[var(--ws-search-hover)] hover:text-[var(--ws-text)]"
        >
          <Search aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">Search oh-my-agent</span>
          <kbd className="ml-auto hidden rounded border border-[var(--ws-border)] px-1 font-sans text-[10px] leading-4 opacity-80 sm:inline">⌘K</kbd>
        </button>
      </div>
      <div className="flex shrink-0 items-center justify-end gap-1 md:min-w-[120px]">
        <ThemeSelector />
        <Button type="button" variant="ws" size="icon-sm" id="open-profile" className="rounded-md" aria-label="Profile and avatars" title="Profile and avatars" onClick={onProfile}>
          <AvatarTile author={HUMAN_AUTHOR} className="size-6 text-[18px] shadow-[0_0_0_1px_var(--ws-border)]" />
        </Button>
      </div>
    </div>
  );
}

function RailButton({ icon: Icon, label, ariaLabel, current, onClick }: { icon: ComponentType<{ className?: string }>; label: string; ariaLabel: string; current?: boolean; onClick: () => void }) {
  return (
    <div className="flex w-full flex-col items-center gap-0.5">
      <Button
        type="button"
        variant="ws"
        aria-label={ariaLabel}
        aria-current={current ? "page" : undefined}
        onClick={onClick}
        className={`peer size-10 rounded-lg p-0 [&_svg:not([class*='size-'])]:size-5 ${current ? "bg-[var(--ws-hover-strong)] text-[var(--ws-text)] shadow-[inset_0_0_0_1px_var(--ws-border)]" : ""}`}
      >
        <Icon />
      </Button>
      <span aria-hidden className={`text-[11px] leading-3.5 font-semibold ${current ? "text-[var(--ws-text)]" : "text-[var(--ws-text-dim)] peer-hover:text-[var(--ws-text)]"}`}>{label}</span>
    </div>
  );
}

export function WorkspaceNavigation({ onConversations, onAgents, onNewChat, connected = true }: {
  onConversations: () => void;
  onAgents: () => void;
  onNewChat: () => void;
  connected?: boolean;
}) {
  return (
    <nav aria-label="Workspace" className="ws-rail-surface hidden w-16 shrink-0 flex-col items-center gap-3 pt-2.5 pb-3 md:flex">
      <span aria-hidden title="oh-my-agent" className="mb-1 flex size-9 items-center justify-center rounded-lg bg-[var(--ws-tile)] text-[11px] font-black tracking-tight text-[var(--ws-tile-text)] shadow-[0_1px_2px_rgb(0_0_0/35%),0_0_0_1px_rgb(255_255_255/18%)]">OMA</span>
      <RailButton icon={House} label="Home" ariaLabel="Conversations" current onClick={onConversations} />
      <RailButton icon={Bot} label="Agents" ariaLabel="Manage agents" onClick={onAgents} />
      <RailButton icon={SquarePen} label="New chat" ariaLabel="New OMP chat" onClick={onNewChat} />
      <span
        role="img"
        aria-label={connected ? "Daemon connected" : "Daemon reconnecting"}
        title={connected ? "Daemon connected" : "Daemon reconnecting"}
        className={`mt-auto size-2.5 rounded-full shadow-[0_0_0_3px_color-mix(in_srgb,var(--ws-rail)_70%,black)] ${connected ? "bg-[var(--presence-active)]" : "bg-[var(--presence-parked)]"}`}
      />
    </nav>
  );
}
