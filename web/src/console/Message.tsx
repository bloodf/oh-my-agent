/**
 * Purpose: Renders one safe, interactive room message with Markdown, reactions, and thread access.
 * Public API: Message, MessageProps.
 * Upstream deps: RoomMessage plus shadcn Avatar, Badge, Button, Popover, and Tooltip primitives.
 * Downstream consumers: Transcript and ThreadPanel.
 * Failure modes: Reaction failures stay visible beside the message and can be retried.
 * Performance: Markdown parsing is linear in message length; no unsafe HTML is interpreted.
 */
import { Check, Clock3, Eye, MessageSquare, Plus, X } from "lucide-react";
import { useState } from "react";
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
import { Markdown } from "./Markdown";
import { personaFor, useProfile } from "./profile";

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


function timeLabel(createdAt: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(createdAt));
}

export function MessageBody({ body }: { body: string }) {
  return (
    <div className="body min-w-0 space-y-1 break-words text-sm leading-5 text-foreground/90">
      <Markdown body={body} />
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
  const persona = personaFor(useProfile(), message.author);
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
      className={`message group relative grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-2.5 px-2 py-1.5 sm:px-4 hover:bg-muted/45 focus-within:bg-muted/45 ${roleClass(message.author)} ${grouped ? "grouped" : "mt-3"}`}
    >
      {grouped ? (
        <time className="timestamp self-start pt-0.5 text-center text-[9px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100" dateTime={new Date(message.createdAt).toISOString()} aria-label={`Sent ${new Date(message.createdAt).toLocaleString()}`}>{timeLabel(message.createdAt)}</time>
      ) : (
        <Avatar className="mt-0.5 size-9 rounded-lg">
          <AvatarFallback
            className={
              message.author === HUMAN_AUTHOR
                ? "rounded-lg bg-amber-500/15 text-amber-800 dark:text-amber-300"
                : message.author === "system"
                  ? "rounded-lg bg-muted text-muted-foreground"
                  : "rounded-lg bg-primary/10 text-primary"
            }
          >
            {persona.avatar}
          </AvatarFallback>
        </Avatar>
      )}
      <div className="min-w-0 max-w-[80ch]">
        {!grouped && (
          <div className="meta mb-0.5 flex items-baseline gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className={`author ${roleClass(message.author)} cursor-default text-sm font-semibold`} data-author={message.author}>
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
                className="mention h-5 border-primary/30 bg-primary/5 text-primary"
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
                      className="message-secondary-action min-h-11 min-w-11 transition-opacity data-[state=open]:opacity-100"
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
                className={`thread-open min-h-11 text-muted-foreground transition-opacity hover:text-primary ${message.replyCount > 0 ? "font-medium text-primary" : "message-secondary-action"}`}
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
