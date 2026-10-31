import { modelStem } from "./modelFiles";
import { shortGpu } from "./text";

/**
 * The GPUs RunPod offers, ranked for the renders that wait (the server's hunt.ts, the Hunt a GPU dialog): which are usable
 * (left out by the user, too small for the files, over the price ceiling), about how long a render takes on each and what
 * it costs, learned from the user's own renders where they rendered on that GPU and guessed from a rough table elsewhere,
 * and how free each is now. Pure: the server reads RunPod, the queue and the record of renders, and hands them here.
 */

export type HuntMode = "value" | "fast" | "cheap";
export type Stock = "free" | "a few free" | "none free";
type Availability = "HIGH" | "MEDIUM" | "LOW" | "NONE";

/** A GPU as RunPod offers it (the server's runpod.ts GpuOffer). */
export interface RankOffer {
  id: string;
  name: string;
  /** Its memory, GB as RunPod says it; 0 when not said. */
  memory: number;
  /** USD an hour. */
  price: number;
  availability: Availability;
  dataCenters: Array<{ id: string; availability: Availability }>;
}

/**
 * The CUDA build a deploy or a hunt takes, as the Deploy dialog sets it: 13.0 only (a host of the GPU with a driver for
 * CUDA 13), 12.8 (any host, the older build), or either (13.0 where such a host is free, else 12.8). The 12.8 build rendered
 * H3 2× slower on an RTX 5090 (2026-10-20): it is never taken without the user's say.
 */
export type CudaPick = "13.0" | "12.8" | "either";

/** Whether a GPU can be deployed now with that pick: on 13.0 only, a host of it with CUDA 13 must be free. */
export const cudaFits = (gpu: { cuda13?: boolean }, pick: CudaPick): boolean => pick !== "13.0" || gpu.cuda13 !== false;

/**
 * An offer as the pick sees it: one with no host free for it is out of stock everywhere (ranked, listed and hunted as
 * such), never deployed on the other build.
 */
export function forCuda<T extends RankOffer & { cuda13?: boolean }>(offer: T, pick: CudaPick): T {
  return cudaFits(offer, pick) ? offer : { ...offer, availability: "NONE", dataCenters: offer.dataCenters.map((d) => ({ ...d, availability: "NONE" as const })) };
}

/** A render the hunt is for: the model files it needs (bytes, when known), and its forecast at the common pace (ms; null when not known). */
export interface RankRender {
  files: Array<{ file: string; size: number | null }>;
  ms: number | null;
  /**
   * What loading its model takes on a pod (ms), left out of `ms`: a load is the pod's disk, not its card, and is added as it
   * is, not at the GPU's pace. Left out, `ms` holds whatever load there is.
   */
  loadMs?: number | null;
  /**
   * Its recipe's family ("minimax-h3", "flux"): a GPU's pace is read on the models of that family where the record compared
   * it on them, its pace overall elsewhere (a card is not as fast against another on every model).
   */
  family?: string | null;
}

/**
 * What the record of renders says of each GPU: its pace against the common pace of every GPU rendered on (1 the common
 * pace, 2 half as fast) and how many renders that rests on, by GPU name as ComfyUI or RunPod gave it; and the files that
 * ran out of memory on a GPU.
 */
export interface Learned {
  /** `families`: its pace on the models of each family it was compared on, on the same scale (forecast.ts paceScales). */
  gpus: Array<{ gpu: string; pace: number; renders: number; families?: Record<string, number> }>;
  /** The GPUs the user rented (RunPod's names): a guess is anchored on one of them first. */
  rented?: string[];
  oom: Array<{ gpu: string; file: string }>;
  /**
   * Every GPU the record has renders on, with how many, compared with another or not. With one GPU alone (the owner's PC
   * before any pod) nothing is compared and `gpus` may say nothing of it, yet its pace is the common pace itself.
   */
  rendered?: Array<{ gpu: string; renders: number }>;
  /**
   * What a deploy bills besides its renders, in ms of the pod's time: the usual boot and the usual idle before the pod
   * stops, from the user's own sessions (costs.ts deployOverhead); null when no session tells it yet.
   */
  overheadMs?: number | null;
  /**
   * How many renders a GPU's pace needs to be taken as learned; LEARNED_RENDERS when not said. The Costs tab gives 1: its
   * paces are a model's own p50 on each GPU, times measured as they are rather than steps compared across machines.
   */
  minRenders?: number;
}

/**
 * How many compared renders a GPU's pace rests on before it is taken as learned: one render (a model loaded cold, a slow
 * host) set a GPU's pace at half or twice its truth, and the Hunt said "from 1 of your renders" of it. Below it, a guess.
 */
export const LEARNED_RENDERS = 3;

export interface RankAsk {
  mode: HuntMode;
  /** USD an hour at most. */
  ceiling: number;
  /** GPUs left out by the user, by RunPod's id. */
  leftOut: string[];
  /** The data center a network volume pins the pod to; null: any. */
  dataCenter: string | null;
  /**
   * How many renders wait in all, which a deploy's overhead is shared by: the renders handed to the ranking are the first of
   * the line only (hunt.ts RANKED_RENDERS). Left out, those handed.
   */
  waiting?: number;
  /**
   * Value only: a cost all told within TIE of the cheapest goes to the faster GPU (true when not said). The Costs tab gives
   * false: its guess is the cheapest a render, as it says.
   */
  ties?: boolean;
}

/**
 * In value, GPUs whose cost all told is within this of the cheapest of them are a tie, the faster ranked first: the owner's
 * rule (card #201), since on H3 Video an A40, an L40S and an RTX 6000 Ada came within ~10 % a render while the A40 took
 * 1.7 times as long.
 */
export const TIE = 0.1;

/**
 * How much dearer a guessed GPU is counted in value than its guess says: the rough table (SPEEDS) is a GPU's speed overall,
 * and a model's own kernels move it a lot (the 6000 Ada read 0.95 there and rendered H3 at 0.70). A guess wins over a GPU
 * learned from the user's renders only when it is cheaper by more than this, and never wins a tie against one.
 */
export const GUESS_ERROR = 0.3;

export interface RankedGpu {
  id: string;
  name: string;
  price: number;
  memory: number;
  /** Why it is not usable, as a code and as said; "yes" when it is. */
  fit: "yes" | "small" | "price" | "left";
  fits: string;
  /** About how long a render of those waiting takes there (their mean), and what it costs; null when it cannot be told. */
  seconds: number | null;
  cost: number | null;
  /** From how many of the user's renders on that GPU its time was learned; 0 when it is a guess (or not known). */
  learned: number;
  /** What a deploy of it bills besides its renders: the usual boot and idle at its price (USD); null when not known. */
  overhead: number | null;
  /**
   * What a render costs there all told: `cost` and its share of `overhead` among the renders waiting (USD); null when its
   * time is not known. What value ranks by.
   */
  perRender: number | null;
  /** Whether its time is a guess from another GPU (the rough table), not learned on it: counted GUESS_ERROR dearer in value. */
  guess: boolean;
  /** What the time rests on, as said: "from 12 of your renders", "a guess from your L40S's renders, may be 30 % off", or "not known yet". */
  timeSaid: string;
  /** How free it is, where the pod would go (the volume's data center), else anywhere. */
  stock: Stock;
  /** 1 for the first. */
  rank: number;
}

/**
 * A GPU's name as both sides can be compared: ComfyUI says "cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync", RunPod
 * "NVIDIA GeForce RTX 4090" (its id) or "RTX 4090" (its name): each comes down to "rtx 4090".
 */
export function gpuKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/^cuda:\d+\s*/, "")
    .replace(/\s*:\s*\S+\s*$/, "")
    .replace(/\b(nvidia|geforce|generation)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Rough speeds against an RTX 4090, by name: only to order the GPUs the user never rendered on, from one they did. They
 * are rough (a model's own kernels, its precision and the host move them a lot) and never said as a figure: a time
 * learned from the user's renders always wins over them. The first pattern that matches is taken (the longer names first).
 */
const SPEEDS: Array<[RegExp, number]> = [
  [/\brtx pro 6000\b/, 1.4],
  // the 6000 Ada and the A40 against the L40S at 0.85, as the three ran one H3 Video recipe on 2026-10-31 (card #201's pod
  // series: 5.5, 9.8 and 4.5 s a step, the 6000 Ada's before its host throttled): one recipe, one host each
  [/\brtx 6000 ada\b/, 0.7],
  [/\brtx 4000 ada\b/, 0.3],
  [/\brtx 2000 ada\b/, 0.2],
  [/\b5090\b/, 1.35],
  [/\b5080\b/, 0.85],
  [/\b5070 ti\b/, 0.7],
  [/\b5070\b/, 0.55],
  [/\b4090\b/, 1],
  [/\b4080\b/, 0.75],
  [/\b4070 ti super\b/, 0.6],
  [/\b4070 ti\b/, 0.55],
  [/\b4070 super\b/, 0.5],
  [/\b4070\b/, 0.42],
  [/\b4060 ti\b/, 0.33],
  [/\b4060\b/, 0.27],
  [/\b3090\b/, 0.6],
  [/\b3080\b/, 0.5],
  [/\b3070\b/, 0.33],
  [/\b3060 ti\b/, 0.3],
  [/\b3060\b/, 0.25],
  [/\bb200\b/, 2.6],
  [/\bh200\b/, 2.0],
  [/\bh100\b/, 1.9],
  [/\ba100\b/, 1.1],
  [/\bl40s\b/, 0.85],
  [/\bl40\b/, 0.75],
  [/\bl4\b/, 0.3],
  [/\ba6000\b/, 0.5],
  [/\ba5000\b/, 0.4],
  [/\ba4500\b/, 0.33],
  [/\ba4000\b/, 0.27],
  [/\ba40\b/, 0.39],
];

/** A GPU's rough speed against an RTX 4090; null when the table does not know it (a laptop's is not a desktop's of the same name). */
export function roughSpeed(name: string): number | null {
  const key = gpuKey(name);
  if (/\b(laptop|mobile|max q)\b/.test(key)) return null;
  return SPEEDS.find(([re]) => re.test(key))?.[1] ?? null;
}

const STOCK: Record<Availability, Stock> = { HIGH: "free", MEDIUM: "a few free", LOW: "a few free", NONE: "none free" };
const FREEST: Record<Availability, number> = { HIGH: 0, MEDIUM: 1, LOW: 2, NONE: 3 };
/** A GPU's memory in bytes: RunPod's GB are the card's binary ones (a 24 GB card holds 24 GiB). */
const GIB = 1024 ** 3;
/**
 * A model file as both sides name it: a waiting render's file ("models/Flux.safetensors") and the record's model
 * ("flux", render_stats.model_file) come down to its name without folder nor extension, in lower case.
 */
const fileKey = (file: string) => modelStem(file).toLowerCase();

/** How free a GPU is: in the pinned data center, else the freest of what RunPod says overall and per data center. */
function stockOf(o: RankOffer, dataCenter: string | null): Stock {
  if (dataCenter) return STOCK[o.dataCenters.find((d) => d.id === dataCenter)?.availability ?? "NONE"];
  const best = [o.availability, ...o.dataCenters.map((d) => d.availability)].sort((a, b) => FREEST[a] - FREEST[b])[0]!;
  return STOCK[best];
}

/**
 * The GPUs whose pace is learned: from LEARNED_RENDERS compared renders. The record's paces come either with every GPU
 * rendered on (one compared with nothing at 1, `renders` all its rows) or with the compared ones alone (`renders` those
 * compared): either way a GPU under LEARNED_RENDERS is a guess. With none learned and one GPU alone in the record, that GPU
 * is the common pace (1): the owner's PC before any pod, which the table's guesses are anchored on.
 */
function learnedGpus(learned: Learned): Learned["gpus"] {
  const least = Math.max(1, learned.minRenders ?? LEARNED_RENDERS);
  const known = learned.gpus.filter((g) => g.renders >= least && g.pace > 0);
  if (known.length || !learned.rendered?.length) return known;
  const keys = new Set(learned.rendered.map((g) => gpuKey(g.gpu)));
  const renders = learned.rendered.reduce((n, g) => n + g.renders, 0);
  return keys.size === 1 && renders >= least ? [{ gpu: learned.rendered[0]!.gpu, pace: 1, renders }] : [];
}

/**
 * The GPUs ranked for these renders: the usable ones first, by the mode's key (value: what a render costs all told, its time
 * there at its price and its share of the usual boot and idle among the renders waiting, a guessed GPU counted GUESS_ERROR
 * dearer and a tie within TIE going to the faster; fast: time; cheap: price), then the rest. Value counts the overhead
 * because a deploy pays it whatever the GPU's pace: with one render waiting and 10 min of usual boot and idle, a $2/h GPU 5
 * times faster than a $0.50/h one cost about 4 times as much for the session.
 */
export function rankGpus(offers: readonly RankOffer[], renders: readonly RankRender[], learned: Learned, ask: RankAsk): RankedGpu[] {
  const timed = renders.filter((r) => r.ms !== null && r.ms > 0);
  const largest = Math.max(0, ...renders.flatMap((r) => r.files.map((f) => f.size ?? 0)));
  const needed = new Set(renders.flatMap((r) => r.files.map((f) => fileKey(f.file))));
  const known = learnedGpus(learned).map((g) => ({ ...g, key: gpuKey(g.gpu) }));
  // a GPU's pace on a render: on its family's models where it was compared on them, else overall
  const paceFor = (g: (typeof known)[number], r: RankRender) => (r.family ? g.families?.[r.family] : undefined) ?? g.pace;
  // a render's seconds there, the mean of those waiting: each at the pace its family reads, its load added as it is
  const meanSeconds = (pace: (r: RankRender) => number) => timed.reduce((a, r) => a + r.ms! * pace(r) + Math.max(0, r.loadMs ?? 0), 0) / timed.length / 1000;
  // the GPU a guess is anchored on: a learned one the table knows, a rented one first (a home card shares its memory with
  // the desktop and spills the larger models), then the one with the most renders behind it
  const rented = new Set((learned.rented ?? []).map(gpuKey));
  const anchor = known.filter((g) => roughSpeed(g.gpu) !== null).sort((a, b) => Number(rented.has(b.key)) - Number(rented.has(a.key)) || b.renders - a.renders)[0] ?? null;
  const ceilingSaid = `over your $${ask.ceiling.toFixed(2)}/h`;
  const waiting = Math.max(1, ask.waiting ?? renders.length);
  const rows = offers.map((o): RankedGpu => {
    const keys = new Set([gpuKey(o.id), gpuKey(o.name)]);
    const own = known.filter((g) => keys.has(g.key)).sort((a, b) => b.renders - a.renders)[0];
    let seconds: number | null = null;
    let learnedFrom = 0;
    if (timed.length && own) {
      seconds = meanSeconds((r) => paceFor(own, r));
      learnedFrom = own.renders;
    } else if (timed.length && anchor) {
      const speed = roughSpeed(o.name) ?? roughSpeed(o.id);
      if (speed) seconds = meanSeconds((r) => (paceFor(anchor, r) * roughSpeed(anchor.gpu)!) / speed);
    }
    const guess = seconds !== null && !learnedFrom;
    const oom = learned.oom.some((x) => keys.has(gpuKey(x.gpu)) && needed.has(fileKey(x.file)));
    const small = (o.memory > 0 && largest > o.memory * GIB) || oom;
    const fit: RankedGpu["fit"] = ask.leftOut.includes(o.id) ? "left" : small ? "small" : o.price > ask.ceiling ? "price" : "yes";
    const fits = fit === "left" ? "left out by you" : fit === "small" ? "too small for these files" : fit === "price" ? ceilingSaid : "yes";
    const timeSaid = learnedFrom ? `from ${learnedFrom} of your renders` : guess ? `a guess from your ${shortGpu(anchor!.gpu)}'s renders, may be ${Math.round(GUESS_ERROR * 100)} % off` : "not known yet";
    const overhead = learned.overheadMs ? (o.price * learned.overheadMs) / 3_600_000 : null;
    const cost = seconds === null ? null : (o.price * seconds) / 3600;
    const perRender = cost === null ? null : cost + (overhead ?? 0) / waiting;
    return { id: o.id, name: o.name, price: o.price, memory: o.memory, fit, fits, seconds: seconds === null ? null : Math.round(seconds), cost, learned: learnedFrom, overhead, perRender, guess, timeSaid, stock: stockOf(o, ask.dataCenter), rank: 0 };
  });
  // a GPU whose time is not known comes after those whose time is, by its price ("value" falls back to the price with none known)
  const value = (g: RankedGpu): number | null => (g.perRender === null ? null : g.perRender * (g.guess ? 1 + GUESS_ERROR : 1));
  const key = (g: RankedGpu): number | null => (ask.mode === "cheap" ? g.price : ask.mode === "fast" ? g.seconds : value(g));
  const order = (a: RankedGpu, b: RankedGpu) => {
    if ((a.fit === "yes") !== (b.fit === "yes")) return a.fit === "yes" ? -1 : 1;
    const ka = key(a);
    const kb = key(b);
    if (ka !== null && kb !== null && ka !== kb) return ka - kb;
    if ((ka === null) !== (kb === null)) return ka === null ? 1 : -1;
    // value at the same cost all told: the lower cost a render
    if (ask.mode === "value" && a.cost !== null && b.cost !== null && a.cost !== b.cost) return a.cost - b.cost;
    return a.price - b.price || a.name.localeCompare(b.name);
  };
  const sorted = rows.sort(order);
  return (ask.mode === "value" && ask.ties !== false ? tied(sorted, value) : sorted).map((g, i) => ({ ...g, rank: i + 1 }));
}

/**
 * Value's ties: the usable GPUs with a cost all told (the head of the order), cut into runs within TIE of each run's
 * cheapest, each run put fastest first. A learned GPU goes before a guessed one in its run whatever their times: a guess
 * never wins a tie. Runs rather than a comparator within TIE, so that the order holds whichever two are compared.
 */
function tied(sorted: readonly RankedGpu[], value: (g: RankedGpu) => number | null): RankedGpu[] {
  const head = sorted.findIndex((g) => g.fit !== "yes" || value(g) === null);
  const end = head === -1 ? sorted.length : head;
  const out: RankedGpu[] = [];
  for (let i = 0; i < end; ) {
    const cheapest = value(sorted[i]!)!;
    let j = i + 1;
    while (j < end && value(sorted[j]!)! <= cheapest * (1 + TIE)) j++;
    out.push(...sorted.slice(i, j).sort((a, b) => Number(a.guess) - Number(b.guess) || a.seconds! - b.seconds! || value(a)! - value(b)!));
    i = j;
  }
  return [...out, ...sorted.slice(end)];
}

/** The GPU to deploy now: the best-ranked usable one that is free where the pod would go; null when none is. */
export const firstFree = (ranked: readonly RankedGpu[]): RankedGpu | null => ranked.find((g) => g.fit === "yes" && g.stock !== "none free") ?? null;
