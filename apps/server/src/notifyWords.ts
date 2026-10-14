import { FIRST_MACHINE, type Machine, type NotifyKind } from "./settings";

/**
 * What the queue and the rented pods hand to notify.ts: a kind, and what to say. Apart from it, so that they name it
 * without importing the service that sends it.
 */

/** One notice. `asset`: what it is about, sent as a small picture where the user wants one; `key`: what tells two of a kind apart (a machine, a job). */
export interface Notice {
  title: string;
  body: string;
  asset?: string | null;
  key?: string;
}

/** Tell the user something: never throws, never waits (notify.ts sends in the background). */
export type Say = (kind: NotifyKind, notice: Notice) => void;

/** A machine as a notice names it: its own name, else "ComfyUI" (the first one) or its id. Never its address. */
export const machineSaid = (m: Pick<Machine, "id" | "name">) => m.name || (m.id === FIRST_MACHINE ? "ComfyUI" : `ComfyUI ${m.id}`);

/** A length of time in a few words: "42 s", "12 min", "1 h 05". */
export function took(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")}`;
}

/** Dollars as a notice says them: cents below $10, whole dollars from $100. */
export const dollars = (usd: number) => `$${usd < 10 ? usd.toFixed(2) : usd < 100 ? usd.toFixed(1) : Math.round(usd)}`;
