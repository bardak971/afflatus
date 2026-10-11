import { useQuery } from "@tanstack/react-query";
import { create } from "zustand";
import { api, type UpdateFlow, type UpdatesView } from "./api";
import { dayOf, daysBack } from "./format";
import { queryKeys } from "./queryKeys";

/**
 * Afflatus's own updates on the page: the news (the rail's dot, a banner for a security fix), the Updates part of Settings →
 * About, and the restart that follows an update. The pure parts are here, apart from the screens, so that they are tested
 * without a page.
 */

/** Where Afflatus stands; the "updates" event and a reconnect read it again, nothing polls. */
export const useUpdates = () => useQuery({ queryKey: queryKeys.updates(), queryFn: api.updates, staleTime: 5 * 60_000 });

/**
 * What the Updates part of About shows, in the order of a release's life (the mock's states): nothing new, a newer version
 * to take, an update waiting for the queue, under way, failed; and a newer version for Docker, for a checkout, and for a
 * bundle opened from another computer, which are told rather than offered the button.
 */
export type AboutState = "none" | "available" | "waiting" | "updating" | "failed" | "docker" | "sources" | "elsewhere";

export function aboutState(v: UpdatesView): AboutState {
  // an update under way (or the one that just failed) is said first: it is what happens now
  if (v.flow?.phase === "failed") return "failed";
  if (v.flow?.phase === "waiting") return "waiting";
  if (v.flow) return "updating";
  if (!v.newer || !v.latest) return "none";
  if (v.install === "docker") return "docker";
  if (v.install === "sources") return "sources";
  return v.here ? "available" : "elsewhere";
}

/** What the Afflatus row says beside its version: "Updated today" after an update to it, "Up to date" after a check, else nothing. */
export function versionNote(v: UpdatesView, now = new Date()): { text: string; good: boolean } | null {
  if (v.last?.kind === "updated" && v.last.to === v.version.replace(/^v(?=\d)/, "")) {
    const ago = daysBack(new Date(v.last.at), now);
    return { text: ago === 0 ? "Updated today" : ago === 1 ? "Updated yesterday" : `Updated ${dayOf(v.last.at, now.getTime())}`, good: true };
  }
  if (v.checkedAt && !v.checkError && !v.newer && !v.flow) return { text: "Up to date", good: true };
  return null;
}

/** The news this browser has not seen: the version the rail's dot names, or null (nothing newer, or About already seen for it). */
export function newsOf(v: UpdatesView | undefined, seen: string | null): string | null {
  if (!v?.newer || !v.latest) return null;
  return v.latest.version === seen ? null : v.latest.version;
}

/**
 * Whether an "updates" event needs the view read again. The event carries the flow only: a download's progress (the same
 * phase again) is written in place, but a phase that changes, an update that starts or ends, and an event with no flow
 * (a check that got its answer) may change the rest of the view.
 */
export function readsAgain(before: UpdateFlow | null | undefined, after: UpdateFlow | null): boolean {
  if (!after || !before) return true;
  return before.phase !== after.phase || before.version !== after.version;
}

/** The steps of an update under way, as the card lists them, each done, now or to come; and how far the bar is. */
export function stepsOf(flow: UpdateFlow, running: string): { steps: Array<{ label: string; at: "done" | "now" | "later"; note?: string }>; done: number } {
  const order = ["downloading", "verifying", "unpacking", "starting"] as const;
  const labels = ["Downloading", "Checking its signature", `Unpacking beside ${running}`, `Starting ${flow.version}`];
  // past the start check (waiting, switching, restarting) every step is done
  const at = (order as readonly string[]).indexOf(flow.phase);
  const now = at < 0 ? order.length : at;
  const mb = (bytes: number) => Math.round(bytes / 2 ** 20);
  const steps = labels.map((label, i) => ({
    label,
    at: i < now ? ("done" as const) : i === now ? ("now" as const) : ("later" as const),
    note: i === 0 && flow.phase === "downloading" && flow.total > 0 ? `${mb(flow.bytes)} of ${mb(flow.total)} MB` : undefined,
  }));
  // the download is most of the wait: it fills the bar to 80%, each step after it a little more
  const got = flow.total > 0 ? Math.min(1, flow.bytes / flow.total) : 0;
  const done = flow.phase === "downloading" ? 0.8 * got : at < 0 ? 1 : 0.8 + 0.05 * at;
  return { steps, done };
}

// ---------------------------------------------------------------- what this browser remembers

const SEEN_KEY = "afflatus.updates.seen";
const SECURITY_KEY = "afflatus.updates.security";
const MOVE_KEY = "afflatus.updates.move";

function readKey(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeKey(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // no storage here: the news is said again on the next page
  }
}

/**
 * What this browser has seen of the news, by version: the release About was opened on (the dot goes), the security
 * banner closed, and the 0.3 library left where it was ("Start empty"), by its folder.
 */
export const useUpdatesSeen = create<{
  seen: string | null;
  security: string | null;
  moveDeclined: string | null;
  see(version: string): void;
  closeSecurity(version: string): void;
  declineMove(from: string): void;
}>((set) => ({
  seen: readKey(SEEN_KEY),
  security: readKey(SECURITY_KEY),
  moveDeclined: readKey(MOVE_KEY),
  see: (version) => {
    writeKey(SEEN_KEY, version);
    set({ seen: version });
  },
  closeSecurity: (version) => {
    writeKey(SECURITY_KEY, version);
    set({ security: version });
  },
  declineMove: (from) => {
    writeKey(MOVE_KEY, from);
    set({ moveDeclined: from });
  },
}));

// ---------------------------------------------------------------- the restart

/**
 * An update, Go back or the move restarting the server: the page says "Restarting…" over everything, and reads itself
 * again when the server is back (live.ts, on its next hello). `from`: the version that was running.
 */
export const useRestarting = create<{ from: string | null; since: number | null; begin(from: string): void }>((set, get) => ({
  from: null,
  since: null,
  begin: (from) => {
    if (get().since === null) set({ from, since: Date.now() });
  },
}));

/** A view or an event that says the server is restarting starts the overlay. */
export function followRestart(version: string, flow: UpdateFlow | null | undefined): void {
  if (flow?.phase === "restarting") useRestarting.getState().begin(version);
}

/**
 * Whether a hello from the server, while the page waits for it to restart, is the server back: one of another version,
 * or any hello on a connection opened again (the old server's own connection was the page's first).
 */
export const backFromRestart = (from: string | null, version: string | undefined, reconnect: boolean): boolean =>
  from !== null && ((Boolean(version) && version !== from) || reconnect);
