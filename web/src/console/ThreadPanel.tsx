/**
 * Purpose: Hosts focused thread replies in a desktop split panel or mobile overlay with focus restoration.
 * Public API: ThreadPanel, ThreadPanelProps.
 * Layout: docks beside the channel (resizable, width persisted) when the measured row keeps
 * the channel its minimum; otherwise it is a full-window overlay with the same close behavior.
 * Upstream deps: Message, Composer, RoomMessage, shadcn Button.
 * Downstream consumers: ConsoleShell.
 * Failure modes: Send and reaction errors remain local to child controls; close always restores opener focus.
 * Performance: Renders only selected thread messages and uses no global listeners while closed.
 */
import { MessageSquare, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import type { RoomMessage } from "@/lib/types";
import type { AttachmentUpload } from "@/lib/attachments";
import { CHANNEL_MIN, THREAD, canDockThread, clampThread, readStoredWidth, storeWidth } from "@/lib/panel-size";
import { PanelResizeHandle } from "./ChannelRail";
import { Composer } from "./Composer";
import { Message } from "./Message";

/** Mirrors clampThread in CSS so the docked width tracks the row without re-rendering. */
const DOCKED_WIDTH = `clamp(${THREAD.min}px, min(var(--thread-width), ${THREAD.share * 100}%, calc(100% - ${CHANNEL_MIN}px)), ${THREAD.max}px)`;

export type ThreadPanelProps = {
  root: RoomMessage | null;
  messages: RoomMessage[];
  onClose: () => void;
  onReact: (id: number, emoji: string) => Promise<void>;
  onSend: (body: string, paths: string[]) => Promise<void>;
  onPickFiles?: () => Promise<string[]>;
  onUpload?: (file: File, onProgress: (loaded: number, total: number) => void) => AttachmentUpload;
  onDeleteUpload?: (id: string) => Promise<void>;
};

export function ThreadPanel({
  root,
  messages,
  onClose,
  onReact,
  onSend,
  onPickFiles,
  onUpload,
  onDeleteUpload,
}: ThreadPanelProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(() => readStoredWidth(THREAD.key, THREAD.fallback));
  const [docked, setDocked] = useState(false);
  const available = () => asideRef.current?.parentElement?.clientWidth ?? 0;
  const clampWidth = (next: number) => clampThread(next, available());
  const applyWidth = (next: number) => asideRef.current?.style.setProperty("--thread-width", `${next}px`);
  const commitWidth = (next: number) => { setWidth(next); storeWidth(THREAD.key, next); };
  // Only the dock/overlay flip re-renders; the width itself follows the row through CSS.
  useLayoutEffect(() => {
    const row = asideRef.current?.parentElement;
    if (!root || !row) return;
    const measure = () => setDocked(canDockThread(row.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [root]);
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
      ref={asideRef}
      id="thread"
      role="complementary"
      aria-label="Thread"
      aria-labelledby="thread-title"
      hidden={!root}
      data-docked={docked ? "true" : "false"}
      style={{ "--thread-width": `${width}px`, width: docked ? DOCKED_WIDTH : undefined } as CSSProperties}
      className={
        docked
          ? "relative flex min-w-0 shrink-0 flex-col border-l bg-background"
          : "fixed inset-0 z-40 flex min-w-0 flex-col bg-background shadow-2xl"
      }
    >
      {docked && (
        <PanelResizeHandle
          label="Resize thread"
          value={width}
          clamp={clampWidth}
          direction={-1}
          apply={applyWidth}
          commit={commitWidth}
          reset={() => { applyWidth(THREAD.fallback); commitWidth(THREAD.fallback); }}
          className="-left-[3px]"
        />
      )}
      <header className="flex h-[49px] shrink-0 items-center justify-between border-b pr-2 pl-4">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 id="thread-title" className="truncate text-[15px] font-black">
            Thread
          </h2>
          {root && (
            <span className="truncate text-[13px] text-muted-foreground">{root.room}</span>
          )}
        </div>
        <Button
          ref={closeRef}
          id="thread-close"
          type="button"
          size="icon-sm"
          variant="ghost"
          className="size-8 text-muted-foreground pointer-coarse:size-11"
          aria-label="Close thread"
          onClick={close}
        >
          <X />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pt-2 pb-3">
        {root && (
          <div className="thread-root">
            <Message message={root} onReact={onReact} />
            <div className="relative mt-1 mb-1 flex items-center gap-3 px-5" role="separator" aria-label={`${replies.length} ${replies.length === 1 ? "reply" : "replies"}`}>
              <span className="shrink-0 text-[13px] text-muted-foreground">
                {replies.length} {replies.length === 1 ? "reply" : "replies"}
              </span>
              <span className="h-px flex-1 bg-border" />
            </div>
          </div>
        )}
        <div
          id="thread-messages"
          role="log"
          aria-label="Thread messages"
          tabIndex={0}
          className="outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          {root && (replies.length === 0 ? (
            <div className="mx-auto flex min-h-32 max-w-xs flex-col items-center justify-center px-6 text-center">
              <MessageSquare className="mb-2 size-6 text-muted-foreground" />
              <p className="text-[15px] font-bold">No replies yet</p>
              <p className="mt-1 text-[13px] text-muted-foreground">Continue this conversation without crowding the room.</p>
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
      </div>
      {root && (
        <Composer
          idPrefix="thread-composer"
          roomKey={`${root.room}:thread:${root.id}`}
          placeholder="Reply in thread"
          onSend={onSend}
          onPickFiles={onPickFiles}
          onUpload={onUpload}
          onDeleteUpload={onDeleteUpload}
        />
      )}
    </aside>
  );
}
