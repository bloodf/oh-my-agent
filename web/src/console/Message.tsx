/**
 * Purpose: Renders one safe, interactive room message with Markdown, reactions, and thread access.
 * Public API: Message, MessageProps.
 * Upstream deps: RoomMessage plus shadcn Avatar, Badge, Button, Popover, and Tooltip primitives.
 * Downstream consumers: Transcript and ThreadPanel.
 * Failure modes: Reaction failures stay visible beside the message and can be retried.
 * Performance: Markdown parsing is linear in message length; no unsafe HTML is interpreted.
 */
import { Check, Clock3, Eye, MessageSquare, Plus, X } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { HUMAN_AUTHOR, type RoomMessage } from "@/lib/types";

const REACTIONS = [
  ["👀", "Eyes", Eye],
  ["⏳", "Hourglass", Clock3],
  ["✅", "Check", Check],
  ["❌", "Cross", X],
] as const;

export type MessageProps = {
  message: RoomMessage;
  grouped?: boolean;
  onThread?: (id: number) => void;
  onReact: (id: number, emoji: string) => Promise<void>;
  interactive?: boolean;
};

function roleClass(author: string) {
  if (author === HUMAN_AUTHOR) return "role-you";
  if (author === "system") return "role-system";
  return "role-agent";
}

function initials(author: string) {
  return (
    author
      .replace(/^@/, "")
      .split(/[-_\s]+/)
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?"
  );
}

function timeLabel(createdAt: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(createdAt));
}

function inlineMarkdown(value: string): ReactNode[] {
  const parts = value.split(
    /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g,
  );
  return parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code
          key={index}
          className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("**") && part.endsWith("**"))
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part);
    if (link)
      return (
        <a
          key={index}
          href={link[2]}
          target="_blank"
          rel="noreferrer"
          className="text-primary underline underline-offset-2 hover:text-primary/80"
        >
          {link[1]}
        </a>
      );
    return <Fragment key={index}>{part}</Fragment>;
  });
}

function Prose({ value }: { value: string }) {
  return (
    <>
      {value.split("\n").map((line, index) => {
        const heading = /^(#{1,3})\s+(.+)$/.exec(line);
        if (heading)
          return (
            <p
              key={index}
              className="mt-2 font-semibold text-foreground first:mt-0"
            >
              {inlineMarkdown(heading[2])}
            </p>
          );
        const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
        if (bullet)
          return (
            <div key={index} className="flex gap-2 pl-2">
              <span aria-hidden="true" className="text-muted-foreground">
                •
              </span>
              <span>{inlineMarkdown(bullet[1])}</span>
            </div>
          );
        if (line.startsWith("> "))
          return (
            <blockquote
              key={index}
              className="border-l-2 border-primary/50 pl-3 text-muted-foreground"
            >
              {inlineMarkdown(line.slice(2))}
            </blockquote>
          );
        return (
          <p key={index} className={line ? "min-h-4" : "h-1"}>
            {inlineMarkdown(line)}
          </p>
        );
      })}
    </>
  );
}

export function MessageBody({ body }: { body: string }) {
  const blocks: Array<{
    kind: "prose" | "code";
    value: string;
    language?: string;
  }> = [];
  const fence = /```([^\n]*)\n([\s\S]*?)(?:\n```|$)/g;
  let start = 0;
  for (const match of body.matchAll(fence)) {
    if (match.index > start)
      blocks.push({ kind: "prose", value: body.slice(start, match.index) });
    blocks.push({ kind: "code", language: match[1].trim(), value: match[2] });
    start = match.index + match[0].length;
  }
  if (start < body.length)
    blocks.push({ kind: "prose", value: body.slice(start) });
  if (blocks.length === 0) blocks.push({ kind: "prose", value: body });

  return (
    <div className="body min-w-0 space-y-1 break-words text-sm leading-5 text-foreground/90">
      {blocks.map((block, blockIndex) =>
        block.kind === "prose" ? (
          <Prose key={blockIndex} value={block.value} />
        ) : (
          <div
            key={blockIndex}
            className="overflow-hidden rounded-lg border bg-muted/40"
          >
            {block.language && (
              <div className="border-b px-3 py-1 font-mono text-[10px] text-muted-foreground">
                {block.language}
              </div>
            )}
            <pre className="overflow-x-auto p-3 font-mono text-xs leading-5">
              <code>
                {block.value.split("\n").map((line, lineIndex) => (
                  <span
                    key={lineIndex}
                    className={`block min-w-max ${block.language === "diff" && line.startsWith("+") ? "bg-emerald-500/10 text-emerald-300" : block.language === "diff" && line.startsWith("-") ? "bg-red-500/10 text-red-300" : ""}`}
                  >
                    {line || " "}
                  </span>
                ))}
              </code>
            </pre>
          </div>
        ),
      )}
    </div>
  );
}

export function Message({
  message,
  grouped = false,
  onThread,
  onReact,
  interactive = true,
}: MessageProps) {
  const [pendingEmoji, setPendingEmoji] = useState<string | null>(null);
  const [error, setError] = useState("");
  const groupedReactions = new Map<string, string[]>();
  for (const reaction of message.reactions)
    groupedReactions.set(reaction.emoji, [
      ...(groupedReactions.get(reaction.emoji) ?? []),
      reaction.actor,
    ]);

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

  return (
    <article
      data-id={String(message.id)}
      className={`message group relative grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-2 rounded-lg px-2 py-1 hover:bg-muted/30 focus-within:bg-muted/30 ${roleClass(message.author)} ${grouped ? "grouped" : "mt-3"}`}
    >
      {grouped ? (
        <span />
      ) : (
        <Avatar size="sm" className="mt-0.5">
          <AvatarFallback
            className={
              message.author === HUMAN_AUTHOR
                ? "bg-amber-500/15 text-amber-300"
                : message.author === "system"
                  ? "bg-muted text-muted-foreground"
                  : "bg-sky-500/15 text-sky-300"
            }
          >
            {initials(message.author)}
          </AvatarFallback>
        </Avatar>
      )}
      <div className="min-w-0">
        {!grouped && (
          <div className="meta mb-0.5 flex items-baseline gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className={`author ${roleClass(message.author)} cursor-default text-xs font-semibold`}>
                  {message.author}
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
              className="timestamp text-[11px] text-muted-foreground"
              dateTime={new Date(message.createdAt).toISOString()}
            >
              {timeLabel(message.createdAt)}
            </time>
          </div>
        )}
        <MessageBody body={message.body} />
        {(message.mentions?.length ?? 0) > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {message.mentions?.map((mention) => (
              <Badge
                key={mention}
                variant="outline"
                className="mention h-5 border-sky-400/30 text-sky-300"
              >
                @{mention.replace(/^@/, "")}
              </Badge>
            ))}
          </div>
        )}
        {!interactive && groupedReactions.size > 0 && (
          <div className="mt-1 flex min-h-7 flex-wrap items-center gap-1">
            {[...groupedReactions].map(([emoji, actors]) => (
              <Badge
                key={emoji}
                variant="outline"
                className={`reaction h-6 rounded-full px-2 font-normal ${actors.includes(HUMAN_AUTHOR) ? "mine border-primary/50 bg-primary/10 text-primary" : "text-muted-foreground"}`}
              >
                {emoji}{" "}{actors.length}
              </Badge>
            ))}
          </div>
        )}
        {interactive && (
          <div className="mt-1 flex min-h-7 flex-wrap items-center gap-1">
            {[...groupedReactions].map(([emoji, actors]) => (
              <Button
                key={emoji}
                type="button"
                size="xs"
                variant="outline"
                disabled={pendingEmoji !== null}
                aria-label={`${actors.includes(HUMAN_AUTHOR) ? "Remove" : "Add"} ${emoji} reaction`}
                aria-pressed={actors.includes(HUMAN_AUTHOR)}
                className={`reaction h-6 rounded-full px-2 font-normal ${actors.includes(HUMAN_AUTHOR) ? "mine border-primary/50 bg-primary/10 text-primary" : "text-muted-foreground"}`}
                onClick={() => void toggleReaction(emoji)}
              >
                {emoji}{" "}
                <span>{actors.length}</span>
              </Button>
            ))}
            <Popover>
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Add reaction"
                      className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100"
                    >
                      <Plus />
                    </Button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent>Add reaction</TooltipContent>
              </Tooltip>
              <PopoverContent
                align="start"
                className="w-auto flex-row gap-1 p-1"
              >
                {REACTIONS.map(([emoji, label, Icon]) => (
                  <Tooltip key={emoji}>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        disabled={pendingEmoji !== null}
                        aria-label={label}
                        onClick={() => void toggleReaction(emoji)}
                      >
                        <span aria-hidden="true">{emoji}</span>
                        <Icon className="sr-only" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{label}</TooltipContent>
                  </Tooltip>
                ))}
              </PopoverContent>
            </Popover>
            {onThread && (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="thread-open text-muted-foreground opacity-0 transition-opacity hover:text-primary group-hover:opacity-100 group-focus-within:opacity-100"
                onClick={() => onThread(message.id)}
              >
                <MessageSquare />
                {message.replyCount > 0
                  ? `${message.replyCount} ${message.replyCount === 1 ? "reply" : "replies"}`
                  : "Reply"}
              </Button>
            )}
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
