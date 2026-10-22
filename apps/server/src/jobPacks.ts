import { NVIDIA_ONLY, choicesOf, isNvidiaRtx, packOfNode, type NodeCatalog, type Wanted } from "@afflatus/core";
import type { Machine } from "./settings";
import { readJson, type JobRow } from "./queueModel";
import type { PodPackState } from "./podPacks";

/**
 * A node pack a render asks for, installed where it runs (the owner, 2026-10-20). An option the user turned on says what it
 * asks for as the recipe builds (BuildContext.wants: Veda, H3's Cache, RTX VSR, the RCAS sharpen); a node the form cannot
 * run without is in its graph all the same (the GGUF loader, Impact's detailer). A machine without the pack is one where
 * the job waits for it: a rented pod installs it at once (podPacks.ts), a ComfyUI of the user's own when its rule says
 * Always, or when its Queue row was told Install and restart (Ask, the default). An option whose pack cannot come there (no
 * ComfyUI-Manager, its install failed, a card that cannot run it, Run without) is done without, and the job says so.
 */

/** What a job's Queue row said of the packs it lacks (jobs.packs): installed for it, or run without. */
export interface PacksSaid {
  install?: string[];
  without?: string[];
}

export const packsSaid = (row: Pick<JobRow, "packs">): PacksSaid => readJson<PacksSaid>(row.packs ?? null, {});

/** The pack an option's nodes are installed as: its last node's (DaSiWa's for RTX VSR); null for a node of no known pack. */
export function packOfWant(w: Pick<Wanted, "nodes">): string | null {
  const pack = packOfNode(w.nodes.at(-1) ?? "");
  return pack && !pack.own ? pack.name : null;
}

/** What a machine can be given: whether its card is an NVIDIA RTX one, and the packs that cannot come to it, with why. */
export interface PackFacts {
  /** Whether its card is an NVIDIA RTX one (RTX VSR runs on nothing else). */
  nvidia: boolean;
  cannot: ReadonlyMap<string, string>;
}

/** Nothing known against a machine: an NVIDIA RTX card (most are), every pack may come. */
export const ANY_PACKS: PackFacts = { nvidia: true, cannot: new Map() };

/** A machine's facts from its ComfyUI's device name, its Manager, and the packs that failed there. */
export function packFacts(device: string | null, manager: boolean | null, failed: ReadonlyMap<string, string>, name: string): PackFacts {
  const cannot = new Map(failed);
  // every pack, by a name no pack has: the queue reads "*" as all of them
  if (manager === false) cannot.set("*", `no ComfyUI-Manager on ${name} to install it`);
  return { nvidia: device === null || isNvidiaRtx(device), cannot };
}

/** Why a pack cannot come to a machine, or null. */
export const cannotWhy = (facts: PackFacts, pack: string): string | null => facts.cannot.get(pack) ?? facts.cannot.get("*") ?? null;

/** Why an option is done without on a machine, before its pack is even looked at: a card that cannot run it, the row said so, or its pack cannot come. */
export function skipWhy(w: Wanted, facts: PackFacts, said: PacksSaid): string | null {
  if (!facts.nvidia && w.nodes.some((n) => NVIDIA_ONLY.includes(n))) return "it runs on an NVIDIA RTX card only";
  const pack = packOfWant(w);
  if (!pack) return "no node pack Afflatus can install brings it";
  if (said.without?.includes(pack)) return "run without it, as asked";
  return cannotWhy(facts, pack);
}

/**
 * The options a job asks for, looked at before it runs (BuildContext.wants): the first node this ComfyUI has, else the
 * one its pack is installed as, so that the graph built says every node the job will need (a node it lacks is a pack to
 * get there); one done without on this machine (skipWhy) is left out, as the render will. `missing`: the options whose
 * nodes it lacks and that will be asked for.
 */
export function lookAhead(catalog: NodeCatalog, facts: PackFacts = ANY_PACKS, said: PacksSaid = {}): { wants(w: Wanted): string | null; missing: Wanted[]; skipped: Array<{ w: Wanted; why: string }> } {
  const missing: Wanted[] = [];
  // the ones done without there, with why (the form says them)
  const skipped: Array<{ w: Wanted; why: string }> = [];
  return {
    missing, skipped,
    wants(w) {
      const there = w.nodes.find((n) => n in catalog);
      if (there) return there;
      const why = skipWhy(w, facts, said);
      if (why) {
        if (!skipped.some((x) => x.w.input === w.input)) skipped.push({ w, why });
        return null;
      }
      if (!missing.some((m) => m.input === w.input && m.nodes.join() === w.nodes.join())) missing.push(w);
      return w.nodes.at(-1) ?? null;
    },
  };
}

/** The options a render is built with on the ComfyUI it runs on (BuildContext.wants): what it has, and what it is done without. */
export function asBuilt(catalog: NodeCatalog, facts: PackFacts = ANY_PACKS, said: PacksSaid = {}): { wants(w: Wanted): string | null; without: Array<{ w: Wanted; why: string }> } {
  const without: Array<{ w: Wanted; why: string }> = [];
  return {
    without,
    wants(w) {
      const there = w.nodes.find((n) => n in catalog);
      if (there) return there;
      if (!without.some((x) => x.w.input === w.input)) without.push({ w, why: skipWhy(w, facts, said) ?? "its node pack is not on this ComfyUI" });
      return null;
    },
  };
}

/** What a job that ran without an option says: "Ran without Veda (made with the full attention): its node pack veda-sparse-attention is missing, no ComfyUI-Manager on Studio PC to install it." */
export function ranWithoutSaid(w: Wanted, why: string): string {
  const pack = packOfWant(w);
  const what = `Ran without ${w.without}${w.instead ? ` (${w.instead})` : ""}`;
  if (why === "run without it, as asked" || why.startsWith("it runs on")) return `${what}: ${why}.`;
  return `${what}: its node pack${pack ? ` ${pack}` : ""} is missing${why === "its node pack is not on this ComfyUI" ? "" : `, ${why}`}.`;
}

/** The files a node's input offers on a ComfyUI (BuildContext.options): what RTX VSR falls back on. */
export const optionsIn = (catalog: NodeCatalog) => (node: string, input: string): string[] | null => {
  const def = catalog[node];
  return def ? choicesOf(def.input.required?.[input] ?? def.input.optional?.[input]) : null;
};

/**
 * The packs a job lacks on a machine, from what its graph uses there (jobFiles.ts Loaded): those of the options it asks
 * for (`soft`: it could run without them, its row offers Run without), the others it cannot run without (`hard`), and
 * node types of no pack Afflatus knows (`unknown`: its submit says them).
 */
export function packsLacked(loaded: { missingNodes?: string[]; wanted?: Wanted[] } | null): { soft: Array<{ pack: string; without: string }>; hard: string[]; unknown: string[] } {
  const soft: Array<{ pack: string; without: string }> = [];
  for (const w of loaded?.wanted ?? []) {
    const pack = packOfWant(w);
    if (pack && !soft.some((s) => s.pack === pack)) soft.push({ pack, without: w.without });
    else if (pack) soft.find((s) => s.pack === pack)!.without += ` and ${w.without}`;
  }
  const hard: string[] = [];
  const unknown: string[] = [];
  for (const node of loaded?.missingNodes ?? []) {
    const pack = packOfNode(node);
    if (!pack || pack.own) unknown.push(node);
    else if (!soft.some((s) => s.pack === pack.name) && !hard.includes(pack.name)) hard.push(pack.name);
  }
  return { soft, hard, unknown };
}

/** Where a job waiting for node packs on a machine of the user's own stands, for its Queue row (queueView.ts Job.packs). */
export interface PackWait {
  machine: string;
  /** Each pack, with what the render would be without it (absent: it cannot run without it). */
  packs: Array<{ name: string; without?: string }>;
  /** "ask": waits for Install and restart (or Run without); else where its install stands; "restarting": ComfyUI restarts now. */
  state: "ask" | PodPackState | "restarting";
  /** A pack's install that failed, in Manager's words. */
  error?: string;
  /** Installed, waiting for the machine to be free to restart: what it is busy with (work from outside Afflatus). */
  waitsFor?: string;
}

/** Whether a machine of the user's own installs what a render asks for without asking (Settings › Machines). */
export const installsUnasked = (machine: Pick<Machine, "packs" | "rented">): boolean => Boolean(machine.rented) || machine.packs === "always";
