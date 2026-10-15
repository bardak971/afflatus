import type { RankedGpu } from "@afflatus/core";
import type { DeployOverhead, HuntMode, HuntSummary, QueueStatus } from "./api";
import { brief, leftWords, plural, usd } from "./format";

/**
 * The GPU hunt in words, for the Deploy dialog's hunt, the status bar and the hunt's card: what each mode ranks by, a
 * GPU's row, the strip's few words, and when a Resume would undo what the hunt holds.
 */

export const MODES: Array<{ value: HuntMode; label: string; note: string }> = [
  { value: "value", label: "Best value", note: "Best value: the lowest cost a render, the time a render takes on it times its price." },
  { value: "fast", label: "Fastest", note: "Fastest: the shortest render, whatever it costs within your price." },
  { value: "cheap", label: "Cheapest an hour", note: "Cheapest an hour: the lowest price an hour that fits these renders." },
];
export const modeWord = (mode: HuntMode) => MODES.find((m) => m.value === mode)!.label.toLowerCase();

/** When a hunt gives up, in minutes from its start; one kept from before at another length is offered too. */
const GIVE_UP = [30, 60, 120, 240, 480, 720];
export const giveUpOptions = (current: number) => [...new Set([...GIVE_UP, current])].sort((a, b) => a - b);
export const minutesSaid = (n: number) => (n < 60 ? `${n} min` : n % 60 ? `${Math.floor(n / 60)} h ${n % 60} min` : `${n / 60} h`);

/**
 * The price an hour a hunt opens with: the GPU wanted's, up to the next quarter dollar, so that it is in; $1.00 with
 * none (the hunt opened on its own, or RunPod not read yet).
 */
export const ceilingFor = (price: number | null | undefined) => (price ? Math.ceil(price * 4 - 1e-9) / 4 : 1);

/** The first GPU the hunt would deploy, stock aside: the best-ranked usable one. Its row is badged "first pick". */
export const firstPick = (ranking: readonly RankedGpu[] | null | undefined) => ranking?.find((g) => g.fit === "yes") ?? null;

/** A render on that GPU, as its row says it: "$0.025 · 2m 10s"; "not known yet" when it cannot be told. */
export const renderSaid = (g: Pick<RankedGpu, "cost" | "seconds">) => (g.cost === null || g.seconds === null ? "not known yet" : `${usd(g.cost, true)} · ${brief(g.seconds * 1000)}`);

/** A deploy's own cost on that GPU, under its render's: "+$0.071 a deploy"; null when no session tells it yet. */
export const deploySaid = (g: Pick<RankedGpu, "overhead">) => (g.overhead === null ? null : `+${usd(g.overhead, true)} a deploy`);

/** The "?" of the A render column: what a render's cost counts, and what a deploy adds on top, from the user's sessions. */
export function renderWhy(o: DeployOverhead | null): string {
  const render = "A render: its time on that GPU times its price an hour.";
  if (!o) return `${render} A deploy also bills its boot and its idle before it stops; said here once you have a session that ended.`;
  return `${render} + a deploy: what each deploy bills besides its renders, at that GPU's price: your pods' usual boot (${brief(o.bootMs)}) and usual idle before they stop (${brief(o.idleMs)}), from your last ${plural(o.sessions, "session")}. The more renders a deploy takes, the less of it each one carries.`;
}

/** The hunt's title: "Hunting · best value, up to $1.00/h". */
export const huntTitle = (h: { mode: HuntMode; ceiling: number }) => `Hunting · ${modeWord(h.mode)}, up to ${usd(h.ceiling)}/h`;

/**
 * What the status bar says of a hunt: `main` and `more` in the left slot (it holds the renders) or as a chip after the
 * render's (this PC renders meanwhile); null once its pod is up, a machine like any from then.
 */
export function huntStrip(h: HuntSummary, now: number): { main: string; more: string; chip: string } | null {
  if (h.status === "up") return null;
  const ran = leftWords(Math.max(0, now - Date.parse(h.startedAt)));
  if (h.status === "deploying") return { main: h.firstPick ? `${h.firstPick.name} found` : "GPU found", more: "deploying", chip: "Deploying a GPU" };
  return { main: "Hunting", more: h.hold === "rest" ? `${ran} · ${h.held} held` : ran, chip: `Hunting · ${ran}` };
}

/** How far the hunt is to its give-up, 0 to 1, for the card's bar. */
export const huntDone = (h: Pick<HuntSummary, "startedAt" | "giveUpAt">, now: number) => {
  const from = Date.parse(h.startedAt);
  const span = Date.parse(h.giveUpAt) - from;
  return span > 0 ? Math.max(0, Math.min(1, (now - from) / span)) : 1;
};

/**
 * Whether a Resume would take a home machine off the hunt that holds the renders for its GPU: all of them, or one of
 * them by its id (a rented pod is never the hunt's to hold).
 */
export function resumeHoldsHunt(q: Pick<QueueStatus, "hunt" | "machines"> | undefined, machine?: string): boolean {
  if (!q?.hunt || q.hunt.hold !== "rest") return false;
  if (machine === undefined) return true;
  const m = q.machines.find((x) => x.id === machine);
  return Boolean(m && !m.rented);
}
