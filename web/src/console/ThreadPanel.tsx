/**
 * Purpose: Hosts focused thread replies in a desktop split panel or mobile overlay with focus restoration.
 * Public API: ThreadPanel, ThreadPanelProps.
 * Upstream deps: Message, Composer, RoomMessage, shadcn Button.
 * Downstream consumers: ConsoleShell.
 * Failure modes: Send and reaction errors remain local to child controls; close always restores opener focus.
 * Performance: Renders only selected thread messages and uses no global listeners while closed.
 */
import { MessageSquare, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import type { RoomMessage } from "@/lib/types";
import { Composer } from "./Composer";
import { Message } from "./Message";

export type ThreadPanelProps = {
  root: RoomMessage | null;
  messages: RoomMessage[];
  onClose: () => void;
  onReact: (id: number, emoji: string) => Promise<void>;
  onSend: (body: string, paths: string[]) => Promise<void>;
  onPickFiles?: () => Promise<string[]>;
  onPasteImage?: (file: File) => Promise<string>;
};

export function ThreadPanel({
  root,
  messages,
  onClose,
  onReact,
  onSend,
  onPickFiles,
  onPasteImage,
}: ThreadPanelProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousRootRef = useRef<RoomMessage | null>(null);
  useEffect(() => {
    if (root && previousRootRef.current?.id !== root.id)
      closeRef.current?.focus();
    previousRootRef.current = root;
  }, [root]);

  useEffect(() => {
    if (!root) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      const rootId = root.id;
      onClose();
      queueMicrotask(() =>
        document
          .querySelector<HTMLElement>(
            `.message[data-id="${rootId}"] .thread-open`,
          )
          ?.focus(),
      );
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [root, onClose]);

  const close = () => {
    if (!root) return;
    const rootId = root.id;
    onClose();
    queueMicrotask(() =>
      document
        .querySelector<HTMLElement>(
          `.message[data-id="${rootId}"] .thread-open`,
        )
        ?.focus(),
    );
  };
  const replies = root
    ? messages.filter(
        (message) =>
          message.id !== root.id &&
          (message.threadRootId === root.id || message.parentId === root.id),
      )
    : [];

  return (
    <aside
      id="thread"
      role="complementary"
      aria-label="Thread"
      aria-labelledby="thread-title"
      hidden={!root}
      className="fixed inset-0 z-40 flex min-w-0 flex-col border-l bg-background shadow-2xl md:static md:z-auto md:w-[min(26rem,42vw)] md:shrink-0 md:shadow-none"
    >
      <header className="flex h-12 shrink-0 items-center justify-between border-b px-3">
        <div className="flex min-w-0 items-center gap-2">
          <MessageSquare className="size-4 text-muted-foreground" />
          <span id="thread-title" className="truncate text-sm font-semibold">
            Thread
          </span>
          {root && (
            <span className="text-xs text-muted-foreground">
              {replies.length} {replies.length === 1 ? "reply" : "replies"}
            </span>
          )}
        </div>
        <Button
          ref={closeRef}
          id="thread-close"
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Close thread"
          onClick={close}
        >
          <X />
        </Button>
      </header>
      {root && <div className="shrink-0 border-b px-2 py-3"><Message message={root} onReact={onReact} /></div>}
      <div
        id="thread-messages"
        role="log"
        aria-label="Thread messages"
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto px-2 py-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {root && (replies.length === 0 ? (
          <div className="mx-auto flex min-h-40 max-w-xs flex-col items-center justify-center text-center">
            <MessageSquare className="mb-2 size-6 text-muted-foreground" />
            <p className="text-sm font-medium">No replies yet</p>
            <p className="mt-1 text-xs text-muted-foreground">Continue this conversation without crowding the room.</p>
          </div>
        ) : replies.map((message, index) => (
          <Message
            key={message.id}
            message={message}
            grouped={index > 0 && replies[index - 1]?.author === message.author}
            onReact={onReact}
          />
        )))}
      </div>
      {root && (
        <Composer
          idPrefix="thread-composer"
          roomKey={`${root.room}:thread:${root.id}`}
          placeholder="Reply in thread"
          onSend={onSend}
          onPickFiles={onPickFiles}
          onPasteImage={onPasteImage}
        />
      )}
    </aside>
  );
}
