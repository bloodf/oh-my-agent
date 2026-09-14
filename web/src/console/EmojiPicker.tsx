/**
 * Purpose: The full emoji picker, Slack style, for reactions and the composer.
 * Public API: EmojiPicker, EmojiPickerPopover.
 *
 * Upstream deps: emoji-mart's vanilla `Picker` custom element and the
 * `@emoji-mart/data` set, both loaded on first open into lazy chunks; the
 * theme store for light/dark and the workspace palette; shadcn Popover.
 *
 * Downstream consumers: `Message.tsx` (reactions) and `Composer.tsx` (insert
 * at the caret).
 *
 * Failure modes: a chunk that fails to load shows an inline message; the next
 * open retries. Nothing is fetched at runtime: the native set draws system
 * glyphs and the data ships with the console, so emoji-mart never reaches
 * for its CDN.
 */
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getResolvedThemeMode, getThemePreference, subscribeTheme } from "@/lib/theme";

type PickerModule = { Picker: new (props: Record<string, unknown>) => HTMLElement; data: unknown };

let loading: Promise<PickerModule> | undefined;

function loadPicker(): Promise<PickerModule> {
  loading ??= Promise.all([import("emoji-mart"), import("@emoji-mart/data")]).then(
    ([mart, data]) => ({ Picker: mart.Picker as unknown as PickerModule["Picker"], data: data.default }),
    (error: unknown) => {
      loading = undefined;
      throw error;
    },
  );
  return loading;
}

/** emoji-mart takes its colors as `r, g, b` triples; the console tokens are hex. */
function rgbToken(name: string): string | undefined {
  const hex = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return match ? match.slice(1).map((part) => Number.parseInt(part, 16)).join(", ") : undefined;
}

// Inside a popover the picker shrinks to the room Radix reports on its side,
// so a short phone viewport never pushes the search box off screen.
const HOST =
  "emoji-picker h-[min(435px,calc(var(--radix-popover-content-available-height,451px)-16px))] min-h-[230px] w-[334px] max-w-[calc(100vw-16px)] overflow-hidden rounded-xl border bg-popover shadow-[var(--shadow-float)]";

export function EmojiPicker({
  onSelect,
  onClose,
}: {
  onSelect: (emoji: string) => void;
  onClose?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const select = useEffectEvent((emoji: string) => onSelect(emoji));
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  // Any theme change republishes a new preference object, so the picker is
  // rebuilt with the fresh palette; it cannot restyle its shadow root in place.
  const preference = useSyncExternalStore(subscribeTheme, getThemePreference);

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    loadPicker().then(
      ({ Picker, data }) => {
        if (cancelled || !host) return;
        const picker = new Picker({
          data,
          set: "native",
          theme: getResolvedThemeMode(),
          autoFocus: true,
          navPosition: "top",
          previewPosition: "none",
          skinTonePosition: "search",
          maxFrequentRows: 2,
          perLine: 9,
          emojiSize: 22,
          emojiButtonSize: 34,
          dynamicWidth: false,
          onEmojiSelect: (emoji: { native: string }) => select(emoji.native),
        });
        // Inline style beats the element's own `:host` defaults.
        const vars: Record<string, string | undefined> = {
          "--border-radius": "0px",
          "--shadow": "none",
          "--font-family": "inherit",
          "--rgb-background": rgbToken("--popover"),
          "--rgb-input": rgbToken("--popover"),
          "--rgb-color": rgbToken("--foreground"),
          "--rgb-accent": rgbToken("--link"),
          "--color-border": "var(--border)",
        };
        for (const [key, value] of Object.entries(vars)) if (value) picker.style.setProperty(key, value);
        picker.style.width = "100%";
        picker.style.height = "100%";
        host.replaceChildren(picker);
        setState("ready");
      },
      () => {
        if (!cancelled) setState("failed");
      },
    );
    return () => {
      cancelled = true;
      host?.replaceChildren();
    };
  }, [preference]);

  return (
    <div
      className={`${HOST} relative`}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose?.();
      }}
    >
      <div ref={hostRef} className="size-full" />
      {state === "loading" && (
        <div className="absolute inset-0 flex flex-col gap-3 p-3" aria-busy="true" aria-label="Loading emoji">
          <div className="h-9 animate-pulse rounded-lg bg-muted" />
          <div className="grid grid-cols-9 gap-1">
            {Array.from({ length: 54 }, (_, index) => (
              <div key={index} className="aspect-square animate-pulse rounded-md bg-muted/70" />
            ))}
          </div>
        </div>
      )}
      {state === "failed" && (
        <p role="alert" className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-muted-foreground">
          Emoji could not load. Close and try again.
        </p>
      )}
    </div>
  );
}

/** A trigger that opens the picker; choosing an emoji closes it and focus returns to the trigger. */
export function EmojiPickerPopover({
  trigger,
  onSelect,
  align = "start",
  side,
  tooltip,
}: {
  trigger: ReactNode;
  onSelect: (emoji: string) => void;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
  tooltip?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {tooltip ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>{trigger}</PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
      ) : (
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      )}
      <PopoverContent
        align={align}
        side={side}
        collisionPadding={8}
        className="w-auto rounded-xl bg-transparent p-0 shadow-none"
      >
        <EmojiPicker
          onSelect={(emoji) => {
            setOpen(false);
            onSelect(emoji);
          }}
          onClose={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}
