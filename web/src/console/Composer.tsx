import {
  FileIcon,
  FolderOpen,
  LoaderCircle,
  Paperclip,
  Send,
  Upload,
  X,
} from "lucide-react";
import {
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { AttachmentUpload, ManagedAttachment } from "@/lib/attachments";

export type ComposerProps = {
  idPrefix?: string;
  onSend: (body: string, paths: string[]) => Promise<void>;
  disabled?: boolean;
  placeholder?: string;
  roomKey: string;
  supportsAttachments?: boolean;
  onPickFiles?: () => Promise<string[]>;
  onUpload?: (file: File, onProgress: (loaded: number, total: number) => void) => AttachmentUpload;
  onDeleteUpload?: (id: string) => Promise<void>;
};

type UploadItem = ManagedAttachment & { progress: number };
type ActiveUpload = { name: string; progress: number; cancel: () => void };
type Draft = {
  body: string;
  paths: string[];
  uploads: UploadItem[];
  active: ActiveUpload[];
  revision: number;
};
const EMPTY_DRAFT: Draft = { body: "", paths: [], uploads: [], active: [], revision: 0 };

function pathName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function Composer({
  idPrefix = "composer",
  onSend,
  disabled = false,
  placeholder = "Message the conversation",
  roomKey,
  supportsAttachments = true,
  onPickFiles,
  onUpload,
  onDeleteUpload,
}: ComposerProps) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [sendingByRoom, setSendingByRoom] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const draft = drafts[roomKey] ?? EMPTY_DRAFT;
  const sending = sendingByRoom[roomKey] === true;
  const error = errors[roomKey] ?? "";
  const setError = (message: string) => setErrors((current) => ({ ...current, [roomKey]: message }));
  const setSending = (value: boolean) => setSendingByRoom((current) => ({ ...current, [roomKey]: value }));
  const inputId = `${idPrefix}-input`;
  const updateDraft = (update: (current: Draft) => Draft) =>
    setDrafts((current) => ({
      ...current,
      [roomKey]: update(current[roomKey] ?? EMPTY_DRAFT),
    }));

  const addLocalPaths = (incoming: string[]) => {
    if (!supportsAttachments || disabled) return;
    updateDraft((current) => ({
      ...current,
      paths: [...new Set([...current.paths, ...incoming.filter(Boolean)])],
      revision: current.revision + 1,
    }));
  };

  const uploadFiles = (files: File[]) => {
    if (!supportsAttachments || !onUpload || disabled) return;
    setError("");
    for (const file of files) {
      let cancel = () => {};
      const key = `${file.name}:${file.size}:${file.lastModified}:${crypto.randomUUID()}`;
      const task = onUpload(file, (loaded, total) =>
        updateDraft((current) => ({
          ...current,
          active: current.active.map((item) =>
            item.name === key ? { ...item, progress: total > 0 ? loaded / total : 0 } : item,
          ),
        })),
      );
      cancel = task.cancel;
      updateDraft((current) => ({
        ...current,
        active: [...current.active, { name: key, progress: 0, cancel }],
      }));
      void task.promise
        .then((attachment) =>
          updateDraft((current) => ({
            ...current,
            active: current.active.filter((item) => item.name !== key),
            uploads: [...current.uploads, { ...attachment, progress: 1 }],
            revision: current.revision + 1,
          })),
        )
        .catch((cause: unknown) => {
          updateDraft((current) => ({
            ...current,
            active: current.active.filter((item) => item.name !== key),
          }));
          if (!(cause instanceof DOMException && cause.name === "AbortError"))
            setError(cause instanceof Error ? cause.message : "File upload failed. Your draft is saved.");
        });
    }
  };

  const submit = async () => {
    const sent = drafts[roomKey] ?? EMPTY_DRAFT;
    const body = sent.body.trim();
    if (sending || disabled || sent.active.length > 0 || (body.length === 0 && sent.paths.length === 0 && sent.uploads.length === 0)) return;
    setSending(true);
    setError("");
    try {
      await onSend(body, [...sent.paths, ...sent.uploads.map((item) => item.path)]);
      setDrafts((current) => {
        const latest = current[roomKey] ?? EMPTY_DRAFT;
        return latest.revision === sent.revision
          ? { ...current, [roomKey]: EMPTY_DRAFT }
          : current;
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Message failed to send. Your draft is saved.");
    } finally {
      setSending(false);
    }
  };

  const removeUpload = async (attachment: UploadItem) => {
    if (!onDeleteUpload) return;
    setError("");
    try {
      await onDeleteUpload(attachment.id);
      updateDraft((current) => ({
        ...current,
        uploads: current.uploads.filter((item) => item.id !== attachment.id),
        revision: current.revision + 1,
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Temporary upload could not be removed.");
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0 || !onUpload || disabled) return;
    event.preventDefault();
    uploadFiles(files);
  };
  const onDrop = (event: DragEvent<HTMLFormElement>) => {
    if (!supportsAttachments || disabled) return;
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0 && onUpload) {
      event.preventDefault();
      uploadFiles(files);
      return;
    }
    const paths = event.dataTransfer.getData("text/plain").split(/\r?\n/).map((path) => path.trim().replace(/^file:\/\//, "")).filter((path) => path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path));
    if (paths.length > 0) {
      event.preventDefault();
      addLocalPaths(paths);
    }
  };

  return (
    <form
      id={idPrefix}
      className="composer-shell shrink-0 px-3 pb-3 pt-2 sm:px-5 sm:pb-4"
      onSubmit={(event) => { event.preventDefault(); void submit(); }}
      onDragOver={(event) => {
        if (supportsAttachments && (event.dataTransfer.files.length > 0 || event.dataTransfer.types.includes("text/plain"))) event.preventDefault();
      }}
      onDrop={onDrop}
    >
      <div className="composer-box overflow-hidden rounded-lg border border-foreground/25 bg-background shadow-sm focus-within:border-ring focus-within:ring-1 focus-within:ring-ring">
        {(draft.paths.length > 0 || draft.uploads.length > 0 || draft.active.length > 0) && (
          <div className="flex flex-wrap gap-2 border-b bg-muted/20 p-2" aria-label="Attachments">
            {draft.paths.map((path, index) => (
              <span key={path} title={path} className="attachment-chip">
                <FolderOpen className="size-4 shrink-0" />
                <span className="min-w-0"><span className="block max-w-44 truncate font-medium">{pathName(path)}</span><span className="block text-[10px] text-muted-foreground">Local reference · original stays in place</span></span>
                <Button type="button" size="icon-xs" variant="ghost" aria-label={`Remove ${pathName(path)}`} onClick={() => updateDraft((current) => ({ ...current, paths: current.paths.filter((_, pathIndex) => pathIndex !== index), revision: current.revision + 1 }))}><X /></Button>
              </span>
            ))}
            {draft.uploads.map((attachment) => (
              <span key={attachment.id} title={attachment.path} className="attachment-chip">
                <FileIcon className="size-4 shrink-0" />
                <span className="min-w-0"><span className="block max-w-44 truncate font-medium">{attachment.name}</span><span className="block text-[10px] text-muted-foreground">Temporary upload · {fileSize(attachment.size)}</span></span>
                <Button type="button" size="icon-xs" variant="ghost" aria-label={`Remove temporary upload ${attachment.name}`} onClick={() => void removeUpload(attachment)}><X /></Button>
              </span>
            ))}
            {draft.active.map((item) => (
              <span key={item.name} className="attachment-chip" role="status">
                <LoaderCircle className="size-4 shrink-0 animate-spin" />
                <span className="min-w-0"><span className="block max-w-44 truncate font-medium">{item.name.split(":")[0]}</span><span className="block text-[10px] text-muted-foreground">Uploading {Math.round(item.progress * 100)}%</span></span>
                <Button type="button" size="icon-xs" variant="ghost" aria-label={`Cancel upload ${item.name.split(":")[0]}`} onClick={item.cancel}><X /></Button>
              </span>
            ))}
          </div>
        )}
        <Textarea
          id={inputId}
          rows={2}
          aria-label={placeholder}
          placeholder={placeholder}
          className="max-h-48 min-h-16 resize-none border-0 bg-transparent px-3 py-2.5 shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
          value={draft.body}
          disabled={disabled || sending}
          onChange={(event) => updateDraft((current) => ({ ...current, body: event.target.value, revision: current.revision + 1 }))}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <div className="flex min-h-10 items-center justify-between gap-2 border-t border-border/70 px-2 py-1.5">
          <div className="flex min-w-0 items-center gap-1">
            {supportsAttachments && onUpload && <>
              <input ref={inputRef} className="sr-only" type="file" multiple aria-label="Upload files from this device" onChange={(event) => { uploadFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
              <Button type="button" size="icon-sm" variant="ghost" className="min-h-11 min-w-11" disabled={disabled || sending} aria-label="Upload files from this device" title="Upload files to managed temporary storage" onClick={() => inputRef.current?.click()}><Upload /></Button>
            </>}
            {supportsAttachments && onPickFiles && (
              <Button type="button" size="icon-sm" variant="ghost" className="min-h-11 min-w-11" disabled={disabled || sending} aria-label="Reference local files by path" title="Reference original local files" onClick={() => void onPickFiles().then(addLocalPaths).catch((cause) => setError(cause instanceof Error ? cause.message : "Files could not be selected."))}><Paperclip /></Button>
            )}
            <span className="composer-hint hidden truncate text-[11px] text-muted-foreground sm:inline"><kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> new line</span>
          </div>
          <Button id={`${idPrefix}-send`} type="submit" size="sm" className="min-h-11 min-w-11" aria-label={idPrefix === "thread-composer" ? "Reply" : "Send"} disabled={disabled || sending || draft.active.length > 0 || (draft.body.trim().length === 0 && draft.paths.length === 0 && draft.uploads.length === 0)}>
            {sending ? <LoaderCircle className="animate-spin" /> : <Send />}
            <span className="hidden min-[360px]:inline">{idPrefix === "thread-composer" ? "Reply" : "Send"}</span>
          </Button>
        </div>
      </div>
      {supportsAttachments ? (
        <p className="mt-1.5 px-1 text-[10px] text-muted-foreground">Temporary uploads expire on daemon retention cleanup. Removing before send deletes managed bytes; local originals are never deleted.</p>
      ) : (
        <p className="mt-1.5 px-1 text-[10px] text-muted-foreground">File upload and local path access require full control for this connection.</p>
      )}
      {error && <p role="alert" className="mt-1 px-1 text-xs text-destructive">{error}</p>}
    </form>
  );
}
