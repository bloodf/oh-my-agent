/**
 * Purpose: One avatar editor for every persona — an emoji or up to four
 * characters, an uploaded image, or a blobatar of the wire name when empty —
 * and a small dialog that saves one agent's avatar on its own.
 *
 * Public API: `AvatarEditor`, `AvatarDialog`.
 *
 * Upstream deps: shadcn Input/Button/Dialog; canvas for the downscale; the
 * profile context and `PUT /api/profile`.
 *
 * Downstream consumers: `ProfileDialog`, the agent settings dialog's Profile
 * section, `AgentPanel` (clicking a member's avatar), `CreateAgentDialog`.
 *
 * Failure modes: an unsupported file, an unreadable image, or an image that
 * stays over the daemon's 200 KB cap after re-encoding is refused under the
 * editor and the current avatar is kept. The daemon validates again.
 */
import { useId, useRef, useState } from "react";
import { ImageUp, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Blobatar } from "@blobatar/react";
import type { ConsoleCall } from "../CreateChannelDialog";
import { isImageAvatar, resolveAvatar, useProfile } from "../profile";

const MAX_EDGE = 256;
const MAX_BYTES = 200_000;
const ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

function decodedBytes(dataUrl: string): number {
  const data = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
}

/**
 * Read an image file, fit it inside 256×256, and re-encode it: WebP where the
 * browser can encode it, PNG otherwise, and JPEG as a last resort when a PNG
 * would exceed the cap. Animated GIFs keep their first frame.
 */
async function imageToAvatar(file: File): Promise<string> {
  if (!ACCEPT.split(",").includes(file.type)) throw new Error("Choose a PNG, JPEG, WebP, or GIF image.");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("That image could not be read.");
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  let url = canvas.toDataURL("image/webp", 0.86);
  if (!url.startsWith("data:image/webp")) url = canvas.toDataURL("image/png");
  if (decodedBytes(url) > MAX_BYTES) url = canvas.toDataURL("image/jpeg", 0.82);
  if (decodedBytes(url) > MAX_BYTES) throw new Error("That image is still over 200 KB after resizing.");
  return url;
}

/** The preview tile: the image, the glyph, or a blobatar from `name`. */
function Preview({ value, name }: { value: string; name: string }) {
  const resolved = resolveAvatar(value || undefined, name);
  if (resolved.kind === "image") {
    return <img src={resolved.src} alt="" className="size-10 shrink-0 rounded-lg border object-cover" />;
  }
  if (resolved.kind === "glyph") {
    return (
      <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-lg border bg-muted text-lg font-bold">
        {resolved.text}
      </span>
    );
  }
  return (
    <span aria-hidden className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg border">
      <Blobatar name={name} animate="hover" className="size-full" />
    </span>
  );
}

export function AvatarEditor({ id, label, value, onChange, name, placeholder = "🙂" }: {
  id?: string;
  /** Accessible name of the text field, e.g. `reviewer avatar`. */
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Wire identity used as the blobatar seed when the field is empty. */
  name: string;
  placeholder?: string;
}) {
  const file = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const errorId = useId();
  const image = isImageAvatar(value);
  return (
    <div className="grid min-w-0 gap-1" data-avatar-editor>
      <div className="flex min-w-0 items-center gap-1.5">
        <Preview value={value} name={name} />
        <Input
          id={id}
          aria-label={label}
          aria-describedby={error ? errorId : undefined}
          className="w-20 min-w-0 flex-1 text-center sm:w-24 sm:flex-none"
          placeholder={image ? "Image" : placeholder}
          maxLength={8}
          value={image ? "" : value}
          onChange={(event) => { setError(""); onChange(event.target.value); }}
        />
        <Button type="button" variant="outline" size="icon" className="max-sm:size-11" aria-label={`Upload image for ${label}`} title="Upload image" onClick={() => file.current?.click()}>
          <ImageUp />
        </Button>
        <Button type="button" variant="ghost" size="icon" className="max-sm:size-11" aria-label={`Remove ${label}`} title="Remove avatar" disabled={!value} onClick={() => { setError(""); onChange(""); }}>
          <X />
        </Button>
        <input
          ref={file}
          type="file"
          accept={ACCEPT}
          className="hidden"
          tabIndex={-1}
          aria-hidden
          onChange={(event) => {
            const chosen = event.target.files?.[0];
            event.target.value = "";
            if (!chosen) return;
            setError("");
            void imageToAvatar(chosen).then(onChange).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
          }}
        />
      </div>
      {error && <p id={errorId} role="alert" className="text-[13px] text-destructive">{error}</p>}
    </div>
  );
}

/** Save one agent's avatar, keeping its display name. */
export function AvatarDialog({ name, onOpenChange, call, onNotice }: {
  name: string | null;
  onOpenChange: (open: boolean) => void;
  call: ConsoleCall;
  onNotice: (text: string) => void;
}) {
  const profile = useProfile();
  const persona = name ? profile.agents[name] : undefined;
  // Mounted per agent (keyed by name), so the draft starts from the saved avatar.
  const [value, setValue] = useState(persona?.avatar ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={name !== null} onOpenChange={onOpenChange}>
      <DialogContent id="avatar-dialog" className="slack-modal sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{name} avatar</DialogTitle>
          <DialogDescription>An emoji, up to four characters, or an image. Empty draws a blobatar. Every console shows the same.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name || busy) return;
            setError(""); setBusy(true);
            void call("/api/profile", { method: "PUT", body: { agents: { [name]: { displayName: persona?.displayName ?? "", avatar: value } } } })
              .then(() => { onNotice(`Saved ${name}'s avatar.`); onOpenChange(false); })
              .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
              .finally(() => setBusy(false));
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="avatar-dialog-value">Avatar</Label>
            <AvatarEditor id="avatar-dialog-value" label={`${name ?? "agent"} avatar`} value={value} onChange={setValue} name={name ?? "agent"} placeholder="🤖" />
          </div>
          <p role="alert" className="-my-2 min-h-5 text-[13px] text-destructive">{error}</p>
          <DialogFooter>
            <Button type="button" variant="outline" className="h-9 px-4 font-bold" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button id="avatar-dialog-save" type="submit" className="h-9 px-4 font-bold bg-[var(--send)] text-white hover:bg-[var(--send-hover)]" disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
