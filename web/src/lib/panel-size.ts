/**
 * Purpose: Width bounds and persistence for the resizable sidebar and thread panel.
 * Public API: SIDEBAR, THREAD, CHANNEL_MIN, clampSidebar, clampThread, canDockThread, readStoredWidth, storeWidth.
 * Downstream consumers: ChannelRail, ThreadPanel.
 * Failure modes: blocked or throwing storage falls back to defaults and never throws.
 */

export const SIDEBAR = { min: 220, max: 420, fallback: 260, share: 0.4, key: "oma-sidebar-width" } as const;
export const THREAD = { min: 320, max: 720, fallback: 400, share: 0.5, key: "oma-thread-width" } as const;
/** The channel column keeps at least this much room beside a docked thread. */
export const CHANNEL_MIN = 480;
export const RESIZE_STEP = 16;

const clamp = (value: number, min: number, max: number) => Math.round(Math.min(Math.max(value, min), Math.max(min, max)));

/** 220–420px, and never more than 40% of the viewport. */
export function clampSidebar(width: number, viewport: number): number {
  return clamp(width, SIDEBAR.min, Math.min(SIDEBAR.max, viewport * SIDEBAR.share));
}

/** 320–720px, never more than 50% of the space right of the sidebar, and leaves the channel its minimum. */
export function clampThread(width: number, available: number): number {
  return clamp(width, THREAD.min, Math.min(THREAD.max, available * THREAD.share, available - CHANNEL_MIN));
}

/** The thread docks beside the channel only when both keep their minimums. */
export function canDockThread(available: number): boolean {
  return available >= THREAD.min + CHANNEL_MIN;
}

export function readStoredWidth(key: string, fallback: number): number {
  try {
    const value = Number(globalThis.localStorage?.getItem(key) ?? Number.NaN);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  } catch {
    return fallback;
  }
}

export function storeWidth(key: string, width: number): void {
  try {
    globalThis.localStorage?.setItem(key, String(Math.round(width)));
  } catch {
    // Storage can be blocked (private mode, sandbox); the width still applies for this session.
  }
}
