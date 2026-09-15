/**
 * Purpose: Presents room messages and distinct loading, empty, offline, and failed transcript states.
 * Public API: Transcript, TranscriptProps.
 * Upstream deps: RoomMessage, ConsoleStateKind, Message, shadcn Button and Skeleton.
 * Downstream consumers: ConsoleShell.
 * Failure modes: Retry is delegated to caller; scrolling remains user-controlled away from bottom.
 * Performance: One linear render over visible messages; scroll restoration avoids forced bottom jumps.
 */
import { MessageCircle, RefreshCw, Unplug } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { ConsoleStateKind, RoomMessage } from "@/lib/types";
import { Message } from "./Message";

export type TranscriptProps = {
  messages: RoomMessage[];
  status: ConsoleStateKind;
  statusDetail?: string;
  currentRoom: string | null;
  onThread: (id: number) => void;
  onReact: (id: number, emoji: string) => Promise<void>;
  onRetry?: () => void | Promise<void>;
  /** Present while older history exists above the loaded messages. */
  onLoadOlder?: () => void | Promise<void>;
  loadingOlder?: boolean;
  interactive?: boolean;
};

type ScrollSnapshot = { height: number; top: number; nearBottom: boolean };

/** Slack's day label: "Today", "Yesterday", else "Monday, September 8th". */
function dayLabel(date: Date) {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  const day = date.getDate();
  const suffix = day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th";
  const weekday = date.toLocaleDateString("en-US", { weekday: "long" });
  const month = date.toLocaleDateString("en-US", { month: "long" });
  const year = date.getFullYear() === today.getFullYear() ? "" : `, ${date.getFullYear()}`;
  return `${weekday}, ${month} ${day}${suffix}${year}`;
}

export function Transcript({
  messages,
  status,
  statusDetail = "",
  currentRoom,
  onThread,
  onReact,
  onRetry,
  onLoadOlder,
  loadingOlder = false,
  interactive = true,
}: TranscriptProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const snapshotRef = useRef<ScrollSnapshot>({
    height: 0,
    top: 0,
    nearBottom: true,
  });
  const previousRoomRef = useRef(currentRoom);
  const firstIdRef = useRef(messages[0]?.id);
  const retryRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const snapshot = snapshotRef.current;
    const topBeforeUpdate = element.scrollTop;
    const wasNearBottom = snapshot.height === 0 || snapshot.height - topBeforeUpdate - element.clientHeight < 72;
    const firstId = messages[0]?.id;
    const prepended =
      firstId !== undefined &&
      firstIdRef.current !== undefined &&
      firstId < firstIdRef.current;
    firstIdRef.current = firstId;
    if (previousRoomRef.current !== currentRoom) {
      element.scrollTop = element.scrollHeight;
      previousRoomRef.current = currentRoom;
    } else if (wasNearBottom) {
      element.scrollTop = element.scrollHeight;
    } else if (prepended) {
      // Older history went in above: keep the messages in view where they were.
      element.scrollTop = topBeforeUpdate + element.scrollHeight - snapshot.height;
    } else if (element.scrollHeight !== snapshot.height) {
      element.scrollTop = topBeforeUpdate;
    }
    snapshotRef.current = {
      height: element.scrollHeight,
      top: element.scrollTop,
      nearBottom:
        element.scrollHeight - element.scrollTop - element.clientHeight < 72,
    };
  }, [messages, status, currentRoom]);

  useEffect(() => {
    if ((status !== "offline" && status !== "load-failure") || !onRetry) return;
    const active = document.activeElement;
    if (active === document.body || active === null || active === containerRef.current) retryRef.current?.focus();
  }, [status, onRetry]);

  const captureScroll = () => {
    const element = containerRef.current;
    if (!element) return;
    snapshotRef.current = {
      height: element.scrollHeight,
      top: element.scrollTop,
      nearBottom:
        element.scrollHeight - element.scrollTop - element.clientHeight < 72,
    };
  };
  const roots = messages.filter((message) => message.parentId === null);
  const repliesByRoot = new Map<number, RoomMessage[]>();
  for (const message of messages) {
    const rootId = message.threadRootId ?? message.parentId;
    if (message.parentId === null || rootId === null) continue;
    repliesByRoot.set(rootId, [...(repliesByRoot.get(rootId) ?? []), message]);
  }
  const showState = status !== null || roots.length === 0;
  const effectiveState = status ?? "empty";

  return (
    <div
      id="messages"
      ref={containerRef}
      role="log"
      aria-label="Conversation transcript"
      aria-live="polite"
      tabIndex={0}
      onScroll={captureScroll}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-background pt-2 pb-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      {showState ? (
        <section
          id="state"
          role="status"
          data-state={effectiveState}
          className="mx-auto flex min-h-64 max-w-md flex-col items-center justify-center px-6 text-center"
        >
          {effectiveState === "connecting" ? (
            <div
              className="w-full space-y-5"
              aria-label="Connecting to conversation"
            >
              <div className="flex gap-3">
                <Skeleton className="size-7 shrink-0 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3 w-28" />
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-4/5" />
                </div>
              </div>
              <div className="flex gap-3">
                <Skeleton className="size-7 shrink-0 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-3 w-3/4" />
                </div>
              </div>
              <p className="state-title pt-4 text-sm font-medium">Connecting</p>
              <p className="state-detail text-xs text-muted-foreground">
                {statusDetail || "Reaching the daemon."}
              </p>
            </div>
          ) : (
            <>
              <div className="mb-3 flex size-10 items-center justify-center rounded-full border bg-muted/40 text-muted-foreground">
                {effectiveState === "empty" ? (
                  <MessageCircle />
                ) : effectiveState === "offline" ? (
                  <Unplug />
                ) : (
                  <RefreshCw />
                )}
              </div>
              <h2 className="state-title font-medium">
                {effectiveState === "empty"
                  ? `${currentRoom ?? "This conversation"} is quiet`
                  : effectiveState === "offline"
                    ? "Daemon offline"
                    : "Transcript failed to load"}
              </h2>
              <p className="state-detail mt-1 max-w-sm text-sm text-muted-foreground">
                {effectiveState === "empty"
                  ? "Start the conversation when you are ready."
                  : statusDetail || "Conversation data is unavailable."}
              </p>
              {effectiveState === "empty" ? (
                <Button
                  type="button"
                  variant="outline"
                  className="state-action mt-4"
                  onClick={() =>
                    document.getElementById("composer-input")?.focus()
                  }
                >
                  Write the first message
                </Button>
              ) : onRetry ? (
                <Button
                  ref={retryRef}
                  type="button"
                  variant="outline"
                  className="state-action mt-4"
                  onClick={() => void onRetry()}
                >
                  <RefreshCw />
                  Retry
                </Button>
              ) : null}
            </>
          )}
        </section>
      ) : (
        <div id="state" role="status" hidden />
      )}
      {!showState && onLoadOlder && (
        <div className="flex justify-center py-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            id="load-older"
            disabled={loadingOlder}
            onClick={() => void onLoadOlder()}
          >
            {loadingOlder ? "Loading older messages" : "Load older messages"}
          </Button>
        </div>
      )}
      {roots.map((message, index) => {
        const previous = roots[index - 1];
        const date = new Date(message.createdAt);
        const sameDay = previous !== undefined && new Date(previous.createdAt).toDateString() === date.toDateString();
        return (
          <Fragment key={message.id}>
            {!sameDay && (
              <div className="date-divider mx-0 mt-4 mb-1 first:mt-1" role="separator" aria-label={dayLabel(date)}>
                <span>
                  <time dateTime={date.toISOString()}>{dayLabel(date)}</time>
                </span>
              </div>
            )}
            <Message
              message={message}
              grouped={sameDay && previous?.author === message.author}
              onThread={onThread}
              onReact={onReact}
              interactive={interactive}
              threadReplies={repliesByRoot.get(message.id)}
            />
          </Fragment>
        );
      })}
    </div>
  );
}
