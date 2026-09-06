import palettesData from "./theme-palettes.json";

export type ThemeMode = "light" | "dark" | "system";

type ThemePalette = {
  id: string;
  name: string;
  light: Record<string, string>;
  dark: Record<string, string>;
};

export type ThemePreference = {
  palette: string;
  mode: ThemeMode;
};

export const themePalettes = palettesData as ThemePalette[];

const STORAGE_KEY = "oma-theme";
const DEFAULT_THEME: ThemePreference = { palette: "slack", mode: "light" };
const MODES: Record<ThemeMode, true> = { light: true, dark: true, system: true };
const paletteIds = new Set(themePalettes.map(({ id }) => id));
const paletteKeys = new Set(
  themePalettes.flatMap(({ light, dark }) => [
    ...Object.keys(light),
    ...Object.keys(dark),
  ]),
);

let preference = DEFAULT_THEME;
let mediaQuery: MediaQueryList | undefined;
let initialized = false;
const subscribers = new Set<() => void>();

function isThemePreference(value: unknown): value is ThemePreference {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.palette === "string" &&
    paletteIds.has(candidate.palette) &&
    typeof candidate.mode === "string" &&
    MODES[candidate.mode as ThemeMode] === true
  );
}

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === null) return DEFAULT_THEME;
    const parsed: unknown = JSON.parse(stored);
    if (isThemePreference(parsed)) return parsed;
  } catch {
    // Storage and malformed values both recover to the safe default.
  }
  persist(DEFAULT_THEME);
  return DEFAULT_THEME;
}

function persist(next: ThemePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Preferences remain usable for this page when storage is unavailable.
  }
}

let colorContext: CanvasRenderingContext2D | null | undefined;
function readableForeground(background: string | string[], foreground: string, minimum = 4.5): string {
  colorContext ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!colorContext) return foreground;
  const luminance = (color: string) => {
    colorContext!.fillStyle = color;
    colorContext!.fillRect(0, 0, 1, 1);
    const pixels = colorContext!.getImageData(0, 0, 1, 1).data;
    let value = 0;
    for (let index = 0; index < 3; index++) {
      const channel = pixels[index] / 255;
      value += (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][index];
    }
    return value;
  };
  const surfaces = (Array.isArray(background) ? background : [background]).map(luminance);
  const fg = luminance(foreground);
  if (surfaces.every(bg => (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05) >= minimum)) return foreground;
  const black = Math.min(...surfaces.map(bg => (bg + 0.05) / 0.05));
  const white = Math.min(...surfaces.map(bg => 1.05 / (bg + 0.05)));
  const target = black >= white ? "#000000" : "#ffffff";
  for (let weight = 2; weight <= 100; weight += 2) {
    const candidate = `color-mix(in srgb, ${foreground} ${100 - weight}%, ${target})`;
    const value = luminance(candidate);
    if (surfaces.every(bg => (Math.max(bg, value) + 0.05) / (Math.min(bg, value) + 0.05) >= minimum)) return candidate;
  }
  return target;
}


function apply(next: ThemePreference): void {
  const root = document.documentElement;
  const dark =
    next.mode === "dark" ||
    (next.mode === "system" && Boolean(mediaQuery?.matches));
  const palette =
    themePalettes.find(({ id }) => id === next.palette) ?? themePalettes[0];

  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
  if (palette) {
    // Workspace identity stays stable across content modes, as in Slack.
    root.style.setProperty("--workspace-bar", palette.light.primary);
    root.style.setProperty(
      "--workspace-foreground",
      readableForeground(palette.light.primary, palette.light["primary-foreground"]),
    );
  }
  for (const key of paletteKeys) root.style.removeProperty(`--${key}`);
  if (palette) {
    for (const [key, value] of Object.entries(dark ? palette.dark : palette.light)) {
      root.style.setProperty(`--${key}`, value);
    }
    const tokens = dark ? palette.dark : palette.light;
    root.style.setProperty("--primary-foreground", readableForeground(tokens.primary, tokens["primary-foreground"]));
    root.style.setProperty("--secondary-foreground", readableForeground(tokens.secondary, tokens["secondary-foreground"]));
    root.style.setProperty("--accent-foreground", readableForeground(tokens.accent, tokens["accent-foreground"]));
    root.style.setProperty("--muted-foreground", readableForeground([tokens.background, tokens.muted, tokens.card, tokens.popover], tokens["muted-foreground"], 7));
  }
}

function publish(next: ThemePreference, save: boolean): void {
  preference = next;
  apply(next);
  if (save) persist(next);
  for (const subscriber of subscribers) subscriber();
}

function handleSystemChange(): void {
  if (preference.mode === "system") publish({ ...preference }, false);
}

function handleStorage(event: StorageEvent): void {
  if (event.key !== STORAGE_KEY) return;
  if (event.newValue === null) {
    publish(DEFAULT_THEME, false);
    return;
  }
  try {
    const next: unknown = JSON.parse(event.newValue);
    publish(isThemePreference(next) ? next : DEFAULT_THEME, false);
  } catch {
    publish(DEFAULT_THEME, false);
  }
}

export function initializeTheme(): void {
  if (initialized) return;
  initialized = true;
  mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  mediaQuery.addEventListener("change", handleSystemChange);
  window.addEventListener("storage", handleStorage);
  preference = readPreference();
  apply(preference);
}

export function getThemePreference(): ThemePreference {
  return preference;
}

export function getResolvedThemeMode(): "light" | "dark" {
  return preference.mode === "dark" || (preference.mode === "system" && mediaQuery?.matches) ? "dark" : "light";
}

export function subscribeTheme(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

export function setThemeMode(mode: ThemeMode): void {
  if (mode !== preference.mode) publish({ ...preference, mode }, true);
}

export function setThemePalette(palette: string): void {
  if (paletteIds.has(palette) && palette !== preference.palette) {
    publish({ ...preference, palette }, true);
  }
}
