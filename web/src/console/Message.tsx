/**
 * Purpose: Renders one safe, interactive room message with Markdown, reactions, and thread access.
 * Public API: Message, MessageBody, MessageProps.
 * Upstream deps: RoomMessage plus shadcn Avatar, DropdownMenu, Popover, and Tooltip primitives; EmojiPicker for the full set.
 * Downstream consumers: Transcript, ThreadPanel, and PlansView.
 * Failure modes: Reaction and copy failures stay visible beside the message and can be retried.
 * Performance: Markdown parsing is linear in message length; no unsafe HTML is interpreted.
 */
import {
  Check,
  Clock3,
  Copy,
  EllipsisVertical,
  Eye,
  MessageSquareText,
  SmilePlus,
  X,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { MENTION_PATTERN } from "@/lib/markdown-format";
import { HUMAN_AUTHOR, type RoomMessage } from "@/lib/types";
import { EmojiPicker } from "./EmojiPicker";
import { Markdown } from "./Markdown";
import { personaFor, useProfile } from "./profile";

const REACTIONS = [
  ["👀", "Eyes", Eye],
  ["⏳", "Hourglass", Clock3],
  ["✅", "Check", Check],
  ["❌", "Cross", X],
] as const;

/** Slack-like avatar tiles: [background, foreground], picked by author hash. */
const AVATAR_TINTS = [
  ["#1264A3", "#FFFFFF"],
  ["#2EB67D", "#FFFFFF"],
  ["#E01E5A", "#FFFFFF"],
  ["#ECB22E", "#1D1C1D"],
  ["#36C5F0", "#1D1C1D"],
  ["#611F69", "#FFFFFF"],
  ["#E8912D", "#1D1C1D"],
  ["#0B7A75", "#FFFFFF"],
] as const;

export type MessageProps = {
  message: RoomMessage;
  grouped?: boolean;
  onThread?: (id: number) => void;
  onReact: (id: number, emoji: string) => Promise<void>;
  interactive?: boolean;
  /** Loaded replies for the thread summary row (avatars, last reply time). */
  threadReplies?: RoomMessage[];
};

function roleClass(author: string) {
  if (author === HUMAN_AUTHOR) return "role-you";
  if (author === "system") return "role-system";
  return "role-agent";
}

function timeLabel(createdAt: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(createdAt));
}

function lastReplyLabel(createdAt: number) {
  const minutes = Math.round((Date.now() - createdAt) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const date = new Date(createdAt);
  if (date.toDateString() === new Date().toDateString()) return `today at ${timeLabel(createdAt)}`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function MessageAvatar({ author, label, size = "md" }: { author: string; label: string; size?: "md" | "xs" }) {
  let hash = 0;
  for (const char of author) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const [background, color] = AVATAR_TINTS[hash % AVATAR_TINTS.length] ?? AVATAR_TINTS[0];
  const system = author === "system";
  const tile = size === "md" ? "size-9 rounded-lg" : "size-5 rounded-[4px]";
  // Profile avatars may be uploaded images, stored as data URLs.
  if (label.startsWith("data:image/")) {
    return <img src={label} alt="" className={`${tile} shrink-0 object-cover`} />;
  }
  return (
    <Avatar className={size === "md" ? "size-9 rounded-lg after:rounded-lg" : "size-5 rounded-[4px] after:rounded-[4px]"}>
      <AvatarFallback
        className={`${size === "md" ? "rounded-lg text-[13px]" : "rounded-[4px] text-[9px]"} font-bold ${system ? "bg-muted text-muted-foreground" : ""}`}
        style={system ? undefined : { background, color }}
      >
        {label}
      </AvatarFallback>
    </Avatar>
  );
}

export function MessageBody({ body }: { body: string }) {
  return (
    <div className="body min-w-0 break-words text-[15px] leading-[1.46] text-foreground">
      <Markdown body={body} />
    </div>
  );
}

const TOOLBAR_BUTTON =
  "inline-flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted pointer-coarse:size-11 [&_svg]:size-[18px]";

/** Tooltip around any trigger (the trigger itself may be a Popover/Menu trigger). */
function Tip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The add-reaction popover: the quick status row first, and "More emoji"
 * swaps it for the full picker in place, anchored to the same trigger.
 */
function ReactionPicker({
  trigger,
  disabled,
  onPick,
}: {
  trigger: ReactNode;
  disabled: boolean;
  onPick: (emoji: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const change = (next: boolean) => {
    setOpen(next);
    if (!next) setFull(false);
  };
  return (
    <Popover open={open} onOpenChange={change}>
      <Tip label="Add reaction">
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      </Tip>
      {full ? (
        <PopoverContent align="end" collisionPadding={8} className="w-auto rounded-xl bg-transparent p-0 shadow-none">
          <EmojiPicker
            onSelect={(emoji) => {
              change(false);
              onPick(emoji);
            }}
            onClose={() => change(false)}
          />
        </PopoverContent>
      ) : (
        <PopoverContent align="end" className="w-auto flex-row gap-1 p-1">
          {REACTIONS.map(([emoji, label, Icon]) => (
            <Tooltip key={emoji}>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="text-lg"
                  disabled={disabled}
                  aria-label={label}
                  onClick={() => onPick(emoji)}
                >
                  <span aria-hidden="true">{emoji}</span>
                  <Icon className="sr-only" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{label}</TooltipContent>
            </Tooltip>
          ))}
          <span aria-hidden="true" className="mx-0.5 w-px self-stretch bg-border" />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" size="icon" variant="ghost" aria-label="More emoji" onClick={() => setFull(true)}>
                <SmilePlus />
              </Button>
            </TooltipTrigger>
            <TooltipContent>More emoji</TooltipContent>
          </Tooltip>
        </PopoverContent>
      )}
    </Popover>
  );
}

export function Message({
  message,
  grouped = false,
  onThread,
  onReact,
  interactive = true,
  threadReplies = [],
}: MessageProps) {
  const profile = useProfile();
  const persona = personaFor(profile, message.author);
  const [pendingEmoji, setPendingEmoji] = useState<string | null>(null);
  const [error, setError] = useState("");
  const groupedReactions = new Map<string, string[]>();
  for (const reaction of message.reactions)
    groupedReactions.set(reaction.emoji, [
      ...(groupedReactions.get(reaction.emoji) ?? []),
      reaction.actor,
    ]);
  // Mentions written inline already render as chips inside the body.
  const inline = new Set(
    [...message.body.matchAll(MENTION_PATTERN)].map((match) => match[0].slice(1).toLowerCase()),
  );
  const extraMentions = (message.mentions ?? []).filter(
    (mention) => !inline.has(mention.replace(/^@/, "").toLowerCase()),
  );
  const replyAuthors = [...new Set(threadReplies.map((reply) => reply.author))].slice(0, 4);
  const lastReply = threadReplies.at(-1);
  const replyWord = message.replyCount === 1 ? "reply" : "replies";

  const toggleReaction = async (emoji: string) => {
    if (pendingEmoji) return;
    setPendingEmoji(emoji);
    setError("");
    try {
      await onReact(message.id, emoji);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Reaction failed. Try again.",
      );
    } finally {
      setPendingEmoji(null);
    }
  };

  const copyText = async () => {
    setError("");
    try {
      await navigator.clipboard.writeText(message.body);
    } catch {
      setError("Copy failed. Select the text instead.");
    }
  };

  const picker = (trigger: ReactNode) => (
    <ReactionPicker trigger={trigger} disabled={pendingEmoji !== null} onPick={(emoji) => void toggleReaction(emoji)} />
  );

  const pill = "reaction inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[13px] leading-none outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:h-8";
  const minePill = "mine border-[var(--reaction-mine-border)] bg-[var(--reaction-mine-bg)] text-[var(--reaction-mine-text)]";
  const otherPill = "border-transparent bg-muted/70 text-foreground hover:border-foreground/30 hover:bg-background";

  return (
    <article
      data-id={String(message.id)}
      className={`message group relative grid grid-cols-[36px_minmax(0,1fr)] gap-x-2 px-5 ${grouped ? "grouped py-0.5" : "py-2"} ${roleClass(message.author)}`}
    >
      {grouped ? (
        <time
          className="timestamp self-start pr-1 text-right text-[11px] leading-[22px] whitespace-nowrap text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
          dateTime={new Date(message.createdAt).toISOString()}
          aria-label={`Sent ${new Date(message.createdAt).toLocaleString()}`}
        >
          {timeLabel(message.createdAt)}
        </time>
      ) : (
        <div className="pt-0.5">
          <MessageAvatar author={message.author} label={persona.avatar} />
        </div>
      )}
      <div className="min-w-0">
        {!grouped && (
          <div className="meta flex items-baseline gap-2 leading-[22px]">
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className={`author ${roleClass(message.author)} cursor-default truncate text-[15px] font-black hover:underline`}
                  data-author={message.author}
                >
                  {persona.name}
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {message.author === HUMAN_AUTHOR
                  ? "You"
                  : message.author === "system"
                    ? "System message"
                    : `Agent ${message.author}`}
              </TooltipContent>
            </Tooltip>
            <time
              className="timestamp shrink-0 cursor-default text-[12px] text-muted-foreground hover:text-[var(--link)] hover:underline"
              dateTime={new Date(message.createdAt).toISOString()}
              title={new Date(message.createdAt).toLocaleString()}
            >
              {timeLabel(message.createdAt)}
            </time>
          </div>
        )}
        <MessageBody body={message.body} />
        {extraMentions.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {extraMentions.map((mention) => (
              <span
                key={mention}
                className="mention rounded bg-[var(--mention-bg)] px-0.5 text-[15px] font-medium text-[var(--mention-text)]"
              >
                @{mention.replace(/^@/, "")}
              </span>
            ))}
          </div>
        )}
        {!interactive && groupedReactions.size > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {[...groupedReactions].map(([emoji, actors]) => (
              <span key={emoji} className={`${pill} ${actors.includes(HUMAN_AUTHOR) ? minePill : otherPill}`}>
                {emoji}{" "}{actors.length}
              </span>
            ))}
          </div>
        )}
        {interactive && groupedReactions.size > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {[...groupedReactions].map(([emoji, actors]) => {
              const mine = actors.includes(HUMAN_AUTHOR);
              return (
                <button
                  key={emoji}
                  type="button"
                  disabled={pendingEmoji !== null}
                  aria-label={`${mine ? "Remove" : "Add"} ${emoji} reaction`}
                  aria-pressed={mine}
                  className={`${pill} ${mine ? minePill : otherPill} disabled:cursor-wait`}
                  onClick={() => void toggleReaction(emoji)}
                >
                  {emoji}{" "}
                  <span className="font-medium">{actors.length}</span>
                </button>
              );
            })}
            {picker(
              <button
                type="button"
                aria-label="Add reaction"
                className="message-secondary-action inline-flex h-6 items-center rounded-full border border-transparent bg-muted/70 px-2 text-muted-foreground outline-none transition hover:border-foreground/30 hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:opacity-100 pointer-coarse:hidden [&_svg]:size-4"
              >
                <SmilePlus />
              </button>,
            )}
          </div>
        )}
        {interactive && onThread && message.replyCount > 0 && (
          <button
            type="button"
            className="thread-open group/thread mt-1 flex w-full max-w-[36rem] items-center gap-2 rounded-lg border border-transparent p-1 text-left outline-none transition-colors hover:border-border hover:bg-background focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
            onClick={() => onThread(message.id)}
          >
            {replyAuthors.length > 0 && (
              <span className="flex gap-1" aria-hidden="true">
                {replyAuthors.map((author) => (
                  <MessageAvatar key={author} author={author} label={personaFor(profile, author).avatar} size="xs" />
                ))}
              </span>
            )}
            <span className="text-[13px] font-bold text-[var(--link)] group-hover/thread:underline">
              {message.replyCount} {replyWord}
            </span>
            <span className="text-[13px] text-muted-foreground group-hover/thread:hidden group-focus-visible/thread:hidden">
              {lastReply ? `Last reply ${lastReplyLabel(lastReply.createdAt)}` : ""}
            </span>
            <span className="hidden text-[13px] text-muted-foreground group-hover/thread:inline group-focus-visible/thread:inline">
              View thread
            </span>
          </button>
        )}
        {interactive && (
          <div
            role="toolbar"
            aria-label="Message actions"
            className="hover-toolbar message-secondary-action transition-opacity has-[[data-state=open]]:opacity-100 pointer-fine:pointer-events-none pointer-fine:group-hover:pointer-events-auto pointer-fine:group-focus-within:pointer-events-auto pointer-fine:has-[[data-state=open]]:pointer-events-auto pointer-coarse:static pointer-coarse:-ml-3 pointer-coarse:w-fit pointer-coarse:border-0 pointer-coarse:bg-transparent pointer-coarse:p-0 pointer-coarse:shadow-none"
          >
            {picker(
              <button type="button" aria-label="Add reaction" className={TOOLBAR_BUTTON}>
                <SmilePlus />
              </button>,
            )}
            {onThread && (
              <Tip label="Reply in thread">
                <button
                  type="button"
                  aria-label="Reply in thread"
                  className={`${TOOLBAR_BUTTON} ${message.replyCount === 0 ? "thread-open" : ""}`}
                  onClick={() => onThread(message.id)}
                >
                  <MessageSquareText />
                </button>
              </Tip>
            )}
            <DropdownMenu>
              <Tip label="More actions">
                <DropdownMenuTrigger asChild>
                  <button type="button" aria-label="More actions" className={TOOLBAR_BUTTON}>
                    <EllipsisVertical />
                  </button>
                </DropdownMenuTrigger>
              </Tip>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => void copyText()}>
                  <Copy />
                  Copy message text
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
        {error && (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
    </article>
  );
}
