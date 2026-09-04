/**
 * Purpose: Collects per-room message drafts and attachment paths with keyboard, picker, paste, and text-drop support.
 * Public API: Composer, ComposerProps.
 * Upstream deps: React, shadcn Button and Textarea, daemon-backed path picker and clipboard-image saver callbacks.
 * Downstream consumers: ConsoleShell and ThreadPanel.
 * Failure modes: Picker, clipboard-image, and send failures retain exact draft paths and expose an inline retryable error.
 * Performance: Stores path strings only; existing file bytes never enter browser memory.
 */
import { FileIcon, LoaderCircle, Paperclip, Send, X } from "lucide-react";
import {
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export type ComposerProps = {
  idPrefix?: string;
  onSend: (body: string, paths: string[]) => Promise<void>;
  disabled?: boolean;
  placeholder?: string;
  roomKey: string;
  supportsAttachments?: boolean;
  onPickFiles?: () => Promise<string[]>;
  onPasteImage?: (file: File) => Promise<string>;
};

type Draft = { body: string; paths: string[]; revision: number };
const EMPTY_DRAFT: Draft = { body: "", paths: [], revision: 0 };

function pathName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function Composer({
  idPrefix = "composer",
  onSend,
  disabled = false,
  placeholder = "Message the room",
  roomKey,
  supportsAttachments = true,
  onPickFiles,
  onPasteImage,
}: ComposerProps) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const draft = drafts[roomKey] ?? EMPTY_DRAFT;
  const inputId = `${idPrefix}-input`;
  const sendId = `${idPrefix}-send`;

  const updateDraft = (update: (current: Draft) => Draft) =>
    setDrafts((current) => ({
      ...current,
      [roomKey]: update(current[roomKey] ?? EMPTY_DRAFT),
    }));
  const addPaths = (incoming: string[]) => {
    if (!supportsAttachments || disabled) return;
    updateDraft((current) => ({
      ...current,
      paths: [...new Set([...current.paths, ...incoming.filter(Boolean)])],
      revision: current.revision + 1,
    }));
  };
  const pickFiles = async () => {
    if (!onPickFiles || pending || disabled) return;
    setPending(true);
    setError("");
    try {
      addPaths(await onPickFiles());
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Files could not be selected.",
      );
    } finally {
      setPending(false);
    }
  };
  const submit = async () => {
    const sent = drafts[roomKey] ?? EMPTY_DRAFT;
    const body = sent.body.trim();
    if (pending || disabled || (body.length === 0 && sent.paths.length === 0))
      return;
    setPending(true);
    setError("");
    try {
      await onSend(body, sent.paths);
      setDrafts((current) => {
        const latest = current[roomKey] ?? EMPTY_DRAFT;
        return latest.revision === sent.revision
          ? { ...current, [roomKey]: EMPTY_DRAFT }
          : current;
      });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Message failed to send. Your draft is saved.",
      );
    } finally {
      setPending(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    )
      return;
    event.preventDefault();
    void submit();
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!supportsAttachments || !onPasteImage || disabled || pending) return;
    const images = Array.from(event.clipboardData.files).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (images.length === 0) return;
    event.preventDefault();
    setPending(true);
    setError("");
    void Promise.all(images.map(onPasteImage))
      .then(addPaths)
      .catch((cause: unknown) =>
        setError(
          cause instanceof Error
            ? cause.message
            : "Clipboard image could not be saved.",
        ),
      )
      .finally(() => setPending(false));
  };
  const onDrop = (event: DragEvent<HTMLFormElement>) => {
    if (!supportsAttachments) return;
    const paths = event.dataTransfer
      .getData("text/plain")
      .split(/\r?\n/)
      .map((path) => path.trim().replace(/^file:\/\//, ""))
      .filter((path) => path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path));
    if (paths.length === 0) return;
    event.preventDefault();
    addPaths(paths);
  };

  return (
    <form
      id={idPrefix}
      className="border-t bg-background/95 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onDragOver={(event) => {
        if (
          supportsAttachments &&
          event.dataTransfer.types.includes("text/plain")
        )
          event.preventDefault();
      }}
      onDrop={onDrop}
    >
      {draft.paths.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5" aria-label="Attachments">
          {draft.paths.map((path, index) => (
            <span
              key={path}
              title={path}
              className="inline-flex max-w-full items-center gap-1 rounded-md border bg-muted/40 py-1 pl-2 pr-1 text-xs"
            >
              <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="max-w-56 truncate">{pathName(path)}</span>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                disabled={disabled || pending}
                aria-label={`Remove ${pathName(path)}`}
                onClick={() =>
                  updateDraft((current) => ({
                    ...current,
                    paths: current.paths.filter(
                      (_, pathIndex) => pathIndex !== index,
                    ),
                    revision: current.revision + 1,
                  }))
                }
              >
                <X />
              </Button>
            </span>
          ))}
        </div>
      )}
      <div className="rounded-xl border bg-muted/20 p-1.5 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30">
        <Textarea
          id={inputId}
          rows={1}
          aria-label={placeholder}
          placeholder={placeholder}
          className="max-h-48 min-h-10 resize-none border-0 bg-transparent px-2 shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
          value={draft.body}
          disabled={disabled || pending}
          onChange={(event) =>
            updateDraft((current) => ({
              ...current,
              body: event.target.value,
              revision: current.revision + 1,
            }))
          }
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <div className="flex items-center justify-between gap-2 border-t border-border/60 px-1 pt-1.5">
          <div className="flex items-center gap-1">
            {supportsAttachments && onPickFiles && (
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                disabled={disabled || pending}
                aria-label="Attach files"
                onClick={() => void pickFiles()}
              >
                <Paperclip />
              </Button>
            )}
            <span className="composer-hint hidden text-[11px] text-muted-foreground sm:inline">
              <kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> new line
            </span>
          </div>
          <Button
            id={sendId}
            type="submit"
            size="sm"
            disabled={
              disabled ||
              pending ||
              (draft.body.trim().length === 0 && draft.paths.length === 0)
            }
          >
            {pending ? <LoaderCircle className="animate-spin" /> : <Send />}
            {idPrefix === "thread-composer" ? "Reply" : "Send"}
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
