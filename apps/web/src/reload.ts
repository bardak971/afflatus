/**
 * A tab left open across an upgrade asks for chunks of the old build, which the server no longer has: the
 * first click on a screen not yet opened fails to load it. The page is then read again once, by itself;
 * should that not cure it, the error boundary (ErrorBoundary.tsx) says so and offers the reload.
 */

const KEY = "afflatus.reloaded-at";
/** Within this long of the last reload, another one would only go round in circles. */
export const RELOAD_GAP_MS = 10_000;

/** Whether to reload now, given when the page last reloaded for this (null: never). */
export const mayReload = (last: number | null, now: number): boolean => last === null || !Number.isFinite(last) || now - last > RELOAD_GAP_MS;

function lastReload(): number | null {
  try {
    const v = sessionStorage.getItem(KEY);
    return v === null ? null : Number(v);
  } catch {
    return null;
  }
}

/** Reload the page, unless it was just reloaded for the same reason. True when it reloads. */
export function reloadOnce(): boolean {
  const now = Date.now();
  if (!mayReload(lastReload(), now)) return false;
  try {
    sessionStorage.setItem(KEY, String(now));
  } catch {
    // no session storage: no way to tell a second time from the first, so once is all it gets
    return false;
  }
  location.reload();
  return true;
}

/** Vite says when a chunk could not be fetched: the page is read again rather than left to fail. */
export function reloadOnStaleChunks(): void {
  window.addEventListener("vite:preloadError", (e) => {
    if (reloadOnce()) e.preventDefault();
  });
}
