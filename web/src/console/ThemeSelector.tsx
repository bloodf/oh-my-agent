import { useMemo, useState, useSyncExternalStore } from "react";
import { Check, Monitor, Moon, Palette, Search, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  getThemePreference,
  getResolvedThemeMode,
  setThemeMode,
  setWorkspaceTheme,
  subscribeTheme,
  themes,
  type ThemeMode,
  type WorkspaceTheme,
} from "@/lib/theme";

const modes: Array<{
  id: ThemeMode;
  name: string;
  icon: typeof Sun;
}> = [
  { id: "light", name: "Light", icon: Sun },
  { id: "dark", name: "Dark", icon: Moon },
  { id: "system", name: "System", icon: Monitor },
];

export function ThemeSelector() {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const theme_ = useSyncExternalStore(
    subscribeTheme,
    getThemePreference,
    getThemePreference,
  );
  const resolvedMode = getResolvedThemeMode();
  const palettes = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    return query.length === 0
      ? themes
      : themes.filter(({ name }) => name.toLocaleLowerCase().includes(query));
  }, [filter]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setFilter("");
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="ws-control h-7 min-w-7 px-1.5 hover:bg-[var(--ws-hover-strong)]" aria-label="Appearance" title="Appearance">
          <Palette />
          <span className="hidden text-[13px] lg:inline">Appearance</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="slack-modal flex max-h-[calc(100svh-1rem)] w-[calc(100%-1rem)] flex-col gap-5 overflow-hidden p-5 sm:max-w-2xl sm:p-7">
        <DialogHeader>
          <DialogTitle className="text-[22px] font-black tracking-tight">Appearance</DialogTitle>
          <DialogDescription>
            Pick a sidebar theme and whether messages use a light or dark canvas.
          </DialogDescription>
        </DialogHeader>

        <fieldset>
          <legend className="mb-2 text-[13px] font-bold text-foreground">
            Color mode
          </legend>
          <div className="grid grid-cols-3 gap-1 rounded-lg border bg-muted p-1">
            {modes.map(({ id, name, icon: Icon }) => (
              <Button
                key={id}
                type="button"
                variant={theme_.mode === id ? "secondary" : "ghost"}
                className="min-h-11"
                aria-pressed={theme_.mode === id}
                onClick={() => setThemeMode(id)}
              >
                <Icon />
                {name}
              </Button>
            ))}
          </div>
        </fieldset>

        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={`Search ${themes.length} themes`}
            aria-label="Search color palettes"
            className="h-10 pl-8"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
          {palettes.length === 0 ? (
            <p role="status" className="py-12 text-center text-sm text-muted-foreground">
              No themes match “{filter.trim()}”.
            </p>
          ) : (
            <div
              role="group"
              aria-label={`${themes.length} sidebar themes`}
              className="grid grid-cols-1 gap-3 min-[430px]:grid-cols-2 sm:grid-cols-3"
            >
              {palettes.map((theme) => {
                const selected = theme.id === theme_.palette;
                return (
                  <Button
                    key={theme.id}
                    type="button"
                    aria-pressed={selected}
                    aria-label={theme.name}
                    variant="outline"
                    className={`h-auto flex-col items-stretch gap-2 rounded-xl p-2 text-left ${selected ? "border-[var(--ring)] ring-2 ring-[var(--ring)]/40" : ""}`}
                    onClick={() => setWorkspaceTheme(theme.id)}
                  >
                    <ThemePreview theme={theme} dark={resolvedMode === "dark"} />
                    <span className="flex items-center gap-2 px-1 pb-0.5 text-[13px] font-bold">
                      <span className="min-w-0 flex-1 truncate">{theme.name}</span>
                      <Check className={selected ? "size-4 opacity-100" : "size-4 opacity-0"} aria-hidden="true" />
                    </span>
                  </Button>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A miniature workspace: rail, sidebar with an active row, and the message canvas. */
function ThemePreview({ theme, dark }: { theme: WorkspaceTheme; dark: boolean }) {
  const c = theme.chrome;
  return (
    <span aria-hidden="true" className="flex h-20 overflow-hidden rounded-lg border">
      <span className="w-4 shrink-0" style={{ background: c.rail }} />
      <span className="flex w-16 shrink-0 flex-col gap-1 p-1.5" style={{ background: `linear-gradient(180deg, ${c.sidebar}, ${c["sidebar-end"]})` }}>
        <span className="h-1.5 w-9 rounded-sm" style={{ background: c.text, opacity: 0.85 }} />
        <span className="h-1.5 w-11 rounded-sm" style={{ background: c["text-dim"], opacity: 0.5 }} />
        <span className="h-2.5 w-full rounded-sm" style={{ background: c.active }} />
        <span className="h-1.5 w-10 rounded-sm" style={{ background: c["text-dim"], opacity: 0.5 }} />
      </span>
      <span className="flex flex-1 flex-col gap-1.5 p-2" style={{ background: dark ? "#1a1d21" : "#ffffff" }}>
        <span className="flex items-center gap-1"><span className="size-2.5 rounded-sm bg-[#e8912d]" /><span className="h-1.5 w-8 rounded-sm" style={{ background: dark ? "#e8e8e8" : "#1d1c1d" }} /></span>
        <span className="h-1.5 w-full rounded-sm" style={{ background: dark ? "#35373b" : "#dddddd" }} />
        <span className="h-1.5 w-3/4 rounded-sm" style={{ background: dark ? "#35373b" : "#dddddd" }} />
      </span>
    </span>
  );
}
