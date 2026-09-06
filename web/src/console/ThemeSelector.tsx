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
  setThemePalette,
  subscribeTheme,
  themePalettes,
  type ThemeMode,
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
  const theme = useSyncExternalStore(
    subscribeTheme,
    getThemePreference,
    getThemePreference,
  );
  const resolvedMode = getResolvedThemeMode();
  const palettes = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    return query.length === 0
      ? themePalettes
      : themePalettes.filter(({ name }) =>
          name.toLocaleLowerCase().includes(query),
        );
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
        <Button type="button" variant="ghost" size="sm" className="min-h-11 min-w-11" aria-label="Appearance">
          <Palette />
          <span className="hidden sm:inline">Appearance</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[calc(100svh-1rem)] w-[calc(100%-1rem)] flex-col gap-3 overflow-hidden p-3 sm:max-w-2xl sm:p-4">
        <DialogHeader>
          <DialogTitle>Appearance</DialogTitle>
          <DialogDescription>
            Choose a color palette and how light or dark mode follows your device.
          </DialogDescription>
        </DialogHeader>

        <fieldset>
          <legend className="mb-1.5 text-xs font-medium text-muted-foreground">
            Mode
          </legend>
          <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
            {modes.map(({ id, name, icon: Icon }) => (
              <Button
                key={id}
                type="button"
                variant={theme.mode === id ? "secondary" : "ghost"}
                className="min-h-11"
                aria-pressed={theme.mode === id}
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
            placeholder={`Search ${themePalettes.length} palettes`}
            aria-label="Search color palettes"
            className="h-10 pl-8"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
          {palettes.length === 0 ? (
            <p role="status" className="py-12 text-center text-sm text-muted-foreground">
              No palettes match “{filter.trim()}”.
            </p>
          ) : (
            <div
              role="group"
              aria-label={`${themePalettes.length} color palettes`}
              className="grid grid-cols-1 gap-2 min-[430px]:grid-cols-2 sm:grid-cols-3"
            >
              {palettes.map((palette) => {
                const selected = palette.id === theme.palette;
                return (
                  <Button
                    key={palette.id}
                    type="button"
                    aria-pressed={selected}
                    variant="outline"
                    className="h-auto min-h-12 justify-start gap-2 px-2 py-2 text-left"
                    onClick={() => setThemePalette(palette.id)}
                  >
                    <span className="flex shrink-0 -space-x-1" aria-hidden="true">
                      {["background", "primary", "accent", "foreground"].map(
                        (key) => (
                          <span
                            key={key}
                            className="size-5 rounded-full border border-black/15 shadow-sm"
                            style={{ backgroundColor: palette[resolvedMode][key] }}
                          />
                        ),
                      )}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{palette.name}</span>
                    <Check
                      className={selected ? "opacity-100" : "opacity-0"}
                      aria-hidden="true"
                    />
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
