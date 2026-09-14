import { DEFAULT_THEME_ID, themes, type WorkspaceTheme } from "./themes";

export type ThemeMode = "light" | "dark" | "system";

export type ThemePreference = {
  /** Kept as `palette` so preferences saved before the curated themes still parse. */
  palette: string;
  mode: ThemeMode;
};

export { themes, type WorkspaceTheme };

const STORAGE_KEY = "oma-theme";
const DEFAULT_THEME: ThemePreference = { palette: DEFAULT_THEME_ID, mode: "light" };
const MODES: Record<ThemeMode, true> = { light: true, dark: true, system: true };
const themeIds = new Set(themes.map(({ id }) => id));
const chromeKeys = new Set(themes.flatMap(({ chrome }) => Object.keys(chrome)));

let preference = DEFAULT_THEME;
let mediaQuery: MediaQueryList | undefined;
let initialized = false;
const subscribers = new Set<() => void>();

/**
 * Reads a stored preference. A known mode survives even when the palette id
 * predates the curated themes; that id falls back to the default theme.
 */
function toPreference(value: unknown): ThemePreference | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.mode !== "string" || MODES[candidate.mode as ThemeMode] !== true) return null;
  const palette =
    typeof candidate.palette === "string" && themeIds.has(candidate.palette)
      ? candidate.palette
      : DEFAULT_THEME_ID;
  return { palette, mode: candidate.mode as ThemeMode };
}

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === null) return DEFAULT_THEME;
    const parsed = toPreference(JSON.parse(stored));
    if (parsed) {
      if (parsed.palette !== (JSON.parse(stored) as { palette?: unknown }).palette) persist(parsed);
      return parsed;
    }
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

function apply(next: ThemePreference): void {
  const root = document.documentElement;
  const dark =
    next.mode === "dark" ||
    (next.mode === "system" && Boolean(mediaQuery?.matches));
  const theme = themes.find(({ id }) => id === next.palette) ?? themes[0];

  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
  root.dataset.workspaceTheme = theme?.id ?? DEFAULT_THEME_ID;
  // Workspace chrome keeps its identity across content modes, as in Slack.
  for (const key of chromeKeys) root.style.removeProperty(`--ws-${key}`);
  for (const [key, value] of Object.entries(theme?.chrome ?? {})) {
    root.style.setProperty(`--ws-${key}`, value);
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
    publish(toPreference(JSON.parse(event.newValue)) ?? DEFAULT_THEME, false);
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

export function setWorkspaceTheme(id: string): void {
  if (themeIds.has(id) && id !== preference.palette) {
    publish({ ...preference, palette: id }, true);
  }
}
