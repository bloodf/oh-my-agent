import {
  AtSign,
  Bold,
  Code,
  FileIcon,
  FolderOpen,
  Italic,
  Link,
  List,
  ListOrdered,
  LoaderCircle,
  Paperclip,
  Plus,
  SendHorizontal,
  Smile,
  SquareCode,
  Strikethrough,
  Type,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  Fragment,
  useRef,
  useState,
  type ClipboardEvent,
  type ComponentProps,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { AttachmentUpload, ManagedAttachment } from "@/lib/attachments";
import { applyFormat, insertText, type FormatKind, type TextSelection } from "@/lib/markdown-format";
import { EmojiPickerPopover } from "./EmojiPicker";

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

/** [format, label, icon, divider after]. */
const FORMATS: [FormatKind, string, LucideIcon, boolean][] = [
  ["bold", "Bold", Bold, false],
  ["italic", "Italic", Italic, false],
  ["strike", "Strikethrough", Strikethrough, true],
  ["link", "Link", Link, true],
  ["orderedList", "Ordered list", ListOrdered, false],
  ["bulletList", "Bulleted list", List, true],
  ["code", "Code", Code, false],
  ["codeBlock", "Code block", SquareCode, false],
];

const ICON_BUTTON =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 aria-pressed:text-foreground data-[state=open]:bg-muted pointer-coarse:size-11 [&_svg]:size-[18px]";

function ComposerIcon({ label, children, ...props }: { label: string } & ComponentProps<"button">) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label} className={ICON_BUTTON} {...props}>
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

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
  placeholder,
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [showFormatting, setShowFormatting] = useState(true);
  const label = placeholder ?? (roomKey.startsWith("#") ? `Message ${roomKey}` : "Message the conversation");
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

  const locked = disabled || sending;
  /** Applies a pure edit to the draft at the textarea selection, then restores the selection. */
  const edit = (change: (selection: TextSelection) => TextSelection) => {
    if (locked) return;
    const element = textareaRef.current;
    const value = (drafts[roomKey] ?? EMPTY_DRAFT).body;
    const next = change({ value, start: element?.selectionStart ?? value.length, end: element?.selectionEnd ?? value.length });
    updateDraft((current) => ({ ...current, body: next.value, revision: current.revision + 1 }));
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(next.start, next.end);
    });
  };
  const format = (kind: FormatKind) => edit((selection) => applyFormat(kind, selection));
  const insert = (text: string) => edit((selection) => insertText(selection, text));

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const key = event.key.toLowerCase();
    if ((event.metaKey || event.ctrlKey) && !event.altKey && (key === "b" || key === "i")) {
      event.preventDefault();
      format(key === "b" ? "bold" : "italic");
      return;
    }
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
      className="composer-shell shrink-0 bg-background px-3 pb-3 sm:px-5 sm:pb-5"
      onSubmit={(event) => { event.preventDefault(); void submit(); }}
      onDragOver={(event) => {
        if (supportsAttachments && (event.dataTransfer.files.length > 0 || event.dataTransfer.types.includes("text/plain"))) event.preventDefault();
      }}
      onDrop={onDrop}
    >
      <div className="composer-box rounded-lg border border-[var(--composer-border)] bg-background transition-[border-color,box-shadow] focus-within:border-foreground/50 focus-within:shadow-[var(--shadow-float)]">
        {showFormatting && (
          <div role="toolbar" aria-label="Formatting" className="flex h-9 items-center gap-0.5 overflow-x-auto rounded-t-lg px-1 pt-1">
            {FORMATS.map(([kind, label, Icon, divider]) => (
              <Fragment key={kind}>
                <ComposerIcon label={label} disabled={locked} onMouseDown={(event) => event.preventDefault()} onClick={() => format(kind)}>
                  <Icon />
                </ComposerIcon>
                {divider && <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-border" />}
              </Fragment>
            ))}
          </div>
        )}
        {(draft.paths.length > 0 || draft.uploads.length > 0 || draft.active.length > 0) && (
          <div className="flex flex-wrap gap-2 px-3 pt-2" aria-label="Attachments">
            {draft.paths.map((path, index) => (
              <span key={path} title={path} className="attachment-chip">
                <span className="grid size-8 shrink-0 place-items-center rounded-md bg-[#1264A3] text-white"><FolderOpen className="size-4" /></span>
                <span className="min-w-0"><span className="block max-w-44 truncate font-bold">{pathName(path)}</span><span className="block text-[11px] text-muted-foreground">Local reference · original stays in place</span></span>
                <Button type="button" size="icon-xs" variant="ghost" className="pointer-coarse:size-11" aria-label={`Remove ${pathName(path)}`} onClick={() => updateDraft((current) => ({ ...current, paths: current.paths.filter((_, pathIndex) => pathIndex !== index), revision: current.revision + 1 }))}><X /></Button>
              </span>
            ))}
            {draft.uploads.map((attachment) => (
              <span key={attachment.id} title={attachment.path} className="attachment-chip">
                <span className="grid size-8 shrink-0 place-items-center rounded-md bg-[#2EB67D] text-white"><FileIcon className="size-4" /></span>
                <span className="min-w-0"><span className="block max-w-44 truncate font-bold">{attachment.name}</span><span className="block text-[11px] text-muted-foreground">Temporary upload · {fileSize(attachment.size)}</span></span>
                <Button type="button" size="icon-xs" variant="ghost" className="pointer-coarse:size-11" aria-label={`Remove temporary upload ${attachment.name}`} onClick={() => void removeUpload(attachment)}><X /></Button>
              </span>
            ))}
            {draft.active.map((item) => (
              <span key={item.name} className="attachment-chip" role="status">
                <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"><LoaderCircle className="size-4 animate-spin" /></span>
                <span className="min-w-0"><span className="block max-w-44 truncate font-bold">{item.name.split(":")[0]}</span><span className="block text-[11px] text-muted-foreground">Uploading {Math.round(item.progress * 100)}%</span></span>
                <Button type="button" size="icon-xs" variant="ghost" className="pointer-coarse:size-11" aria-label={`Cancel upload ${item.name.split(":")[0]}`} onClick={item.cancel}><X /></Button>
              </span>
            ))}
          </div>
        )}
        <Textarea
          ref={textareaRef}
          id={inputId}
          rows={1}
          aria-label={label}
          placeholder={label}
          className="max-h-60 min-h-[44px] resize-none rounded-none border-0 bg-transparent px-3 py-2 text-[15px] leading-[1.46] shadow-none focus-visible:border-transparent focus-visible:ring-0 disabled:bg-transparent md:text-[15px] dark:bg-transparent dark:disabled:bg-transparent"
          value={draft.body}
          // Read-only, not disabled, while a send is in flight: disabling the
          // focused textarea drops focus to <body>, so everything typed after
          // the send landed went nowhere.
          disabled={disabled}
          readOnly={sending}
          aria-busy={sending}
          onChange={(event) => updateDraft((current) => ({ ...current, body: event.target.value, revision: current.revision + 1 }))}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <div className="flex h-10 items-center gap-0.5 px-1.5 pb-1 pointer-coarse:h-12">
          {supportsAttachments && onUpload && (
            <input ref={inputRef} className="sr-only" tabIndex={-1} type="file" multiple aria-label="Upload files from this device" onChange={(event) => { uploadFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
          )}
          {supportsAttachments && (onUpload || onPickFiles) && (
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <button type="button" aria-label="Attach" disabled={locked} className={`${ICON_BUTTON.replace("rounded-md", "rounded-full")} bg-muted text-foreground/80 hover:bg-foreground/15`}>
                      <Plus />
                    </button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent>Attach</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="start" side="top" className="min-w-64">
                {onUpload && (
                  <DropdownMenuItem aria-label="Upload files from this device" onSelect={() => inputRef.current?.click()}>
                    <Upload />
                    <span className="flex flex-col"><span>Upload from this device</span><span className="text-[11px] text-muted-foreground">Managed temporary storage</span></span>
                  </DropdownMenuItem>
                )}
                {onPickFiles && (
                  <DropdownMenuItem aria-label="Reference local files by path" onSelect={() => void onPickFiles().then(addLocalPaths).catch((cause) => setError(cause instanceof Error ? cause.message : "Files could not be selected."))}>
                    <Paperclip />
                    <span className="flex flex-col"><span>Reference local files by path</span><span className="text-[11px] text-muted-foreground">Originals stay in place</span></span>
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <ComposerIcon label={showFormatting ? "Hide formatting" : "Show formatting"} aria-pressed={showFormatting} onClick={() => setShowFormatting((value) => !value)}>
            <Type />
          </ComposerIcon>
          <EmojiPickerPopover
            side="top"
            tooltip="Emoji"
            onSelect={insert}
            trigger={
              <button type="button" aria-label="Emoji" disabled={locked} className={ICON_BUTTON}>
                <Smile />
              </button>
            }
          />
          <ComposerIcon label="Mention someone" disabled={locked} onMouseDown={(event) => event.preventDefault()} onClick={() => insert("@")}>
            <AtSign />
          </ComposerIcon>
          <span className="flex-1" />
          <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
          <Button
            id={`${idPrefix}-send`}
            type="submit"
            size="icon-sm"
            className="size-8 rounded-md bg-[var(--send)] text-white hover:bg-[var(--send-hover)] disabled:bg-transparent disabled:text-muted-foreground disabled:opacity-100 pointer-coarse:size-11"
            aria-label={idPrefix === "thread-composer" ? "Reply" : "Send"}
            disabled={locked || draft.active.length > 0 || (draft.body.trim().length === 0 && draft.paths.length === 0 && draft.uploads.length === 0)}
          >
            {sending ? <LoaderCircle className="animate-spin" /> : <SendHorizontal />}
          </Button>
        </div>
      </div>
      <div className="mt-1 flex flex-wrap items-start justify-between gap-x-4 px-1 text-[11px] leading-4 text-muted-foreground">
        {supportsAttachments ? (
          <p className="min-w-56 flex-1">Temporary uploads expire on daemon retention cleanup. Removing before send deletes managed bytes; local originals are never deleted.</p>
        ) : (
          <p className="min-w-56 flex-1">File upload and local path access require full control for this connection.</p>
        )}
        <p className="composer-hint hidden shrink-0 whitespace-nowrap sm:block"><kbd className="font-sans font-bold">Enter</kbd> to send · <kbd className="font-sans font-bold">Shift</kbd> + <kbd className="font-sans font-bold">Enter</kbd> for new line</p>
      </div>
      {error && <p role="alert" className="mt-1 px-1 text-xs text-destructive">{error}</p>}
    </form>
  );
}
