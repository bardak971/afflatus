import { useQuery } from "@tanstack/react-query";
import { hasRentedScreen } from "@afflatus/core";
import { create } from "zustand";
import { api, type GoBackCheck, type UpdateFlow, type UpdatesView } from "./api";
import { ask } from "./Confirm";
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

/**
 * Go back's question (About's and the command bar's): what it restores, and what keeps billing on RunPod after it, which the
 * version before has no screen for, or (0.5.0 on) which its library does not know. Null when it is refused (`check.refused`
 * says why).
 */
export function goBackQuestion(version: string, check: GoBackCheck): { title: string; text: string; yes: string } | null {
  if (check.refused) return null;
  // a version with the Rented GPUs screen (0.5.0 on) shows what bills there itself, but only the pods its library (as at
  // the update) has: the server names a stopped pod added or deployed since, whose disk would bill unseen there
  const billed = hasRentedScreen(version)
    ? check.billing.length ? ` Still billed on RunPod after it, pods added or deployed since the update, which the library of ${version} does not know: ${check.billing.join("; ")}.` : ""
    : check.billing.length
    ? ` Still billed on RunPod after it, with no Rented GPUs screen in ${version} to see or remove them: ${check.billing.join("; ")}.`
    : check.unknown ? ` RunPod did not answer: what stays billed there (stopped pods' disks, volumes) could not be read, and ${version} has no Rented GPUs screen.` : "";
  return {
    title: `Go back to ${version}?`,
    text: `Going back restores the library as it was at the update: what was made since stays in the folder, not in the list. Afflatus restarts on ${version}.${billed}`,
    yes: `Go back to ${version}`,
  };
}

/** Go back asked: refused (its reason thrown) while a rented GPU runs or a hunt is on; else whether the user said go. */
export async function askGoBack(version: string): Promise<boolean> {
  const check = await api.goBackCheck();
  const question = goBackQuestion(version, check);
  if (!question) throw new Error(check.refused ?? "Going back is refused now.");
  return ask(question);
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

/**
 * Whether a newer release is said to the user unasked (the rail's dot, the security banner): only while the checks are on,
 * or once Check now was pressed in this page. A check left from before the switch was turned off says nothing.
 */
export const tellsNews = (v: UpdatesView | undefined, asked: boolean): boolean => Boolean(v?.newer && v.latest && (v.checks || asked));

/**
 * The news this browser has not seen: the version the rail's dot names, or null (nothing newer, the checks off and
 * nothing asked, or About already seen for it).
 */
export function newsOf(v: UpdatesView | undefined, seen: string | null, asked = false): string | null {
  if (!tellsNews(v, asked)) return null;
  return v!.latest!.version === seen ? null : v!.latest!.version;
}

/** A newer release that fixes a security issue, to be said in a banner (tellsNews), or null. */
export const securityNews = (v: UpdatesView | undefined, asked: boolean) => (tellsNews(v, asked) && v!.latest!.security ? v!.latest! : null);

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
 * banner closed, and the 0.3 library left where it was ("Start empty"), by its folder. `asked`: Check now was pressed in
 * this page, which says the news even with the checks off (not kept: the next page goes by the switch again).
 */
export const useUpdatesSeen = create<{
  seen: string | null;
  security: string | null;
  moveDeclined: string | null;
  asked: boolean;
  ask(): void;
  see(version: string): void;
  closeSecurity(version: string): void;
  declineMove(from: string): void;
}>((set) => ({
  seen: readKey(SEEN_KEY),
  security: readKey(SECURITY_KEY),
  moveDeclined: readKey(MOVE_KEY),
  asked: false,
  ask: () => set({ asked: true }),
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
 * or any hello on a connection opened again (the old server's own connection was the page's first). The versions are
 * compared without the tag's "v": the hello says the build's name (v0.4.1), the view the bare one (0.4.1).
 */
export const backFromRestart = (from: string | null, version: string | undefined, reconnect: boolean): boolean =>
  from !== null && ((Boolean(version) && bare(version!) !== bare(from)) || reconnect);

const bare = (v: string) => v.trim().replace(/^v(?=\d)/, "");
