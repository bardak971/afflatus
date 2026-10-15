import { gpuKey, roughly, roughSpeed, secondsOf, type BuiltGraph, type MediaFacts, type Recipe } from "@afflatus/core";
import { sql } from "kysely";
import type { Db } from "./db";

/**
 * What a render will take, learned from the renders this machine has done with the same model: nothing is
 * assumed about the card. Each past render is a point (how much it sampled per step, what a step cost);
 * a card that runs out of memory for a size does not slow down gradually, it starts streaming the model's
 * weights and a step costs several times more, so the points split into those at the usual pace and those
 * past that cliff, and a form is placed against both.
 */

/**
 * A count this large is no frame count: it is a node's "all of them" (ImageFromBatch's 4096 takes every frame of a batch),
 * and read as frames it made a 250 s SCAIL window say 6.2 h. The longest video sampled here is a few hundred frames.
 */
const MAX_FRAMES = 2000;

/**
 * The sampled work of a graph: the canvas one step samples in pixels, how many frames of it (1 for a picture), and the
 * steps. The canvas is its first pass's when the recipe says it (a picture redrawn in tiles samples a tile at a time, an
 * edit reads its pictures beside its canvas), else its largest node size, else the picture it is handed (`built.pixels`).
 */
export function workOf(built: BuiltGraph): { pixels: number; frames: number; steps: number } {
  let pixels = 0;
  let frames = 1;
  for (const node of Object.values(built.graph)) {
    const i = node.inputs;
    const w = i.width;
    const h = i.height;
    if (typeof w === "number" && typeof h === "number" && w * h > pixels) pixels = w * h;
    for (const key of ["length", "frames", "num_frames", "video_frames", "frame_count"]) {
      const v = i[key];
      if (typeof v === "number" && v > frames && v < MAX_FRAMES) frames = v;
    }
  }
  const declared = built.passes?.[0]?.pixels;
  // the recipe's own count wins: its nodes may count frames in their own terms (a continuation window), or not at all (a latent loaded from a file)
  return { pixels: declared && declared > 0 ? declared : pixels || built.pixels || 0, frames: built.frames && built.frames > 0 ? built.frames : frames, steps: Math.max(1, built.totalSteps) };
}

/**
 * A graph whose nodes say no size (a background removal, an imported workflow that reads its picture as it is) with the
 * largest picture it is handed as its canvas (`media`, the facts the build was given): recorded with no work, its renders
 * were never placed against each other and its forecast stayed the recipe's usual time on any picture.
 */
export function sizedFrom(built: BuiltGraph, media: Readonly<Record<string, MediaFacts>>): BuiltGraph {
  if (workOf(built).pixels) return built;
  const largest = Math.max(0, ...Object.values(media).map((m) => (m.width > 0 && m.height > 0 ? m.width * m.height : 0)));
  return largest ? { ...built, pixels: largest } : built;
}

/** One sampled chunk of a part made in chunks: its work per step (pixels × its frames) and its steps. */
export interface Chunk {
  work: number;
  steps: number;
}

/**
 * The chunks a graph samples, when its passes say their frames (a Motion transfer part, made in one chunk or several: one
 * carried on from the clip before runs into a short last chunk) or their canvas (a picture redrawn in tiles after a pass at
 * its first size, an edit's second pass reading fewer pictures); null for a graph whose passes do not say them. The work
 * recorded of a render stays its first chunk's, the one its measured step (the first pass's) is the pace of.
 */
export function chunksOf(built: BuiltGraph, pixels: number): Chunk[] | null {
  const passes = built.passes ?? [];
  if (!passes.length || !pixels) return null;
  if (passes.every((p) => p.frames && p.frames > 0)) return passes.map((p) => ({ work: (p.pixels ?? pixels) * p.frames!, steps: Math.max(1, p.steps) }));
  // a picture's passes: one frame each, at the canvas each says
  if (passes.every((p) => p.pixels && p.pixels > 0)) return passes.map((p) => ({ work: p.pixels!, steps: Math.max(1, p.steps) }));
  return null;
}

/** What of a recorded render `workOfRow` reads. */
export interface RecordedWork {
  recipe_id: string;
  kind: "image" | "video" | "audio" | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  work: number | null;
}

/**
 * A recorded render's work as it is measured now. Until 2026-10-10 the frames of a graph whose nodes do not say them
 * plainly (H3's continuation window, a finish that loads its latent from a file) were not read: those renders were
 * recorded with the work of one frame, a hundred times too small, and taken at that they made the model's other renders
 * look a hundred times slower per unit of work. The rows are the owner's record and are not rewritten: a video whose
 * work is less than two of its own frames is read with its frames, from its length at its recipe's speed. Null when that
 * speed is not known (the row is then left out), or when the row has no work. The other way, a video whose work counts
 * more than eight times the frames its length holds was read with a count that is not its frames (a Motion transfer once
 * counted the 4096 of a frame-picking node, 2026-10-14, migration 0072): such a row is left out too, or it would say the
 * model keeps its pace up to fifty times the work it ever sampled. Eight, not two: a part sampled at 576 and filed at 384
 * holds 2.25 times its pixels in work, and a 4096-frame count is fifty times a five-second window's.
 */
export function workOfRow(r: RecordedWork, fpsOf: (recipeId: string) => number | undefined): number | null {
  if (r.work === null) return null;
  if (r.kind !== "video" || !r.width || !r.height || !r.duration_ms) return r.work;
  const fps = fpsOf(r.recipe_id);
  // its length is often read half a frame short (141 frames at 24 a second come out 5854 ms): a quarter of a frame up takes both
  const frames = fps ? Math.max(1, Math.round((r.duration_ms * fps) / 1000 + 0.25)) : null;
  if (frames !== null && r.work > r.width * r.height * frames * 8) return null;
  // a video is many frames, even sampled at a quarter of the size it is shown at (an upscale after it): less than two is none counted
  if (r.work >= r.width * r.height * 2) return r.work;
  return frames !== null ? r.work * frames : null;
}

/** One past render of a model: how much it sampled per step (pixels × frames), and what one step cost. */
export interface Point {
  work: number;
  stepMs: number;
}

export interface Forecast {
  ms: number;
  /** usual: within what this model rendered at its usual pace; untested: larger than any render so far, the pace assumed to hold; over: past where the card slowed down before. */
  pace: "usual" | "untested" | "over";
  /** The largest work that rendered at the usual pace. */
  fitsUpTo: number;
  samples: number;
  /** What loading the model adds, included in `ms`: 0 when it is the one in memory. A batch of renders loads it once. */
  loadMs: number;
}

// the middle of an even count is the mean of its two middle values: the upper one alone made a machine's third render of a
// model read as slow as its slower second (11.6 s said, 6.2 s taken)
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return 0;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/** How many times the usual cost per unit of work a step must cost to count as past the cliff: a card streaming its weights costs three to four times. */
const OVER = 2;

/**
 * How many times the largest render on record a form may be and still be priced from the record: past that, a line drawn
 * from the renders says nothing (a 4096-frame count once made a five-second window read 6.2 hours), and none is said.
 */
const REACH = 8;

/**
 * The forecast from the points alone: `extraMs` is what surrounds the sampling (finishing, the passes after, the load). A
 * part made in `chunks` is priced chunk by chunk, each at its own size (its pace and its fit are its largest's, `work`).
 * `stepMs`, when renders of the very same form measured it: what a step of `work` costs, which the points' blend between
 * sizes is brought to. Null with no points, or for a form more than REACH times the largest of them.
 */
export function forecastFrom(points: Point[], work: number, steps: number, extraMs: number, chunks?: readonly Chunk[] | null, stepMs?: number | null): Forecast | null {
  const pts = points.filter((p) => p.work > 0 && p.stepMs > 0).sort((a, b) => a.work - b.work);
  if (!pts.length || work <= 0 || work > REACH * pts[pts.length - 1]!.work) return null;
  const cost = (p: Point) => p.stepMs / p.work;
  // the usual cost per unit: the middle of the smaller half of the renders, which no card has trouble with
  const usual = median(pts.slice(0, Math.max(1, Math.ceil(pts.length / 2))).map(cost));
  const over = pts.filter((p) => cost(p) > OVER * usual);
  const fine = pts.filter((p) => cost(p) <= OVER * usual);
  const fitsUpTo = fine.length ? fine[fine.length - 1]!.work : 0;
  // a cliff is two slow renders or more, all larger than the largest at the usual pace: one slow render (the machine busy
  // with something else, a model loaded from a cold disk) or slow ones among usual ones of their size say nothing of the card
  const past = over.filter((p) => p.work > fitsUpTo);
  const cliffAt = past.length >= 2 ? past[0]!.work : null;
  /** What one step of this much work costs. */
  const blended = (w: number): number => {
    if (cliffAt !== null && w >= cliffAt) return w * median(past.map(cost));
    // the cost of the nearest usual renders by size, blended between the one below and the one above; past the largest, that one's
    const below = [...fine].reverse().find((p) => p.work <= w);
    const above = fine.find((p) => p.work >= w);
    const c = below && above && above.work > below.work ? cost(below) + ((cost(above) - cost(below)) * (w - below.work)) / (above.work - below.work) : cost(above ?? below ?? pts[0]!);
    return w * c;
  };
  // the same form measured: its settings' own step (a context window steps three times slower than the model's others of
  // that size), each chunk at it as the blend would scale it
  const measured = stepMs && stepMs > 0 && blended(work) > 0 ? stepMs / blended(work) : 1;
  const stepAt = (w: number): number => blended(w) * measured;
  const pace: Forecast["pace"] = cliffAt !== null && work >= cliffAt ? "over" : work > fitsUpTo * 1.1 ? "untested" : "usual";
  const sampling = chunks?.length ? chunks.reduce((sum, c) => sum + c.steps * stepAt(c.work), 0) : steps * stepAt(work);
  return { ms: Math.round(sampling + extraMs), pace, fitsUpTo, samples: pts.length, loadMs: 0 };
}

/** What a form is besides its work: what tells the renders like it from the model's others. */
export interface Like {
  /** Its recipe: an upscale or a fix-face with a model is not priced like its text-to-picture. */
  recipeId?: string;
  /** Its settings that decide the time (core's timeKey): what surrounds its steps (the passes after them, the finishing) is theirs. */
  timeKey?: string;
  /** Its model's family: a model never loaded cold here is taken to load like the others of its family. */
  family?: string;
  /** A recipe's frames a second, to read the renders recorded before every video's frames were (workOfRow); left out, those are left out. */
  fps?: (recipeId: string) => number | undefined;
  /** Whether it samples a picture of its own first (its graph has a sampling phase); left out, it is not told. */
  samples?: boolean;
  /** The chunks it samples, each at its own size (chunksOf); left out, its `steps` all sample `work`. */
  chunks?: readonly Chunk[] | null;
  /**
   * The machine it would render on (settings.ts `machines`): its own renders of the recipe once it has a few, else beside
   * those of the machines with the same GPU, or of the machine that rendered it most, at its pace against that one's
   * (`paces`, onMachine). Left out, every machine's renders at the common pace (as they are when no pace is known).
   */
  machine?: string | null;
  /** Each machine's pace (machinePaces), to read another machine's renders at `machine`'s pace. */
  paces?: ReadonlyMap<string, number>;
  /** Where its model's renders are read from (statRows), when they are kept between forecasts (the queue's, until the record changes). */
  rows?: (modelFile: string) => Promise<StatRows>;
}

/** What of a recorded render `onMachine` reads and scales. */
interface Timed {
  machine_id: string | null;
  /** Its GPU's name as ComfyUI gave it: the renders of another machine with the same card are read as they are. */
  gpu?: string | null;
  recipe_id: string;
  step_ms: number | null;
  total_ms: number;
  load_ms: number;
  sample_ms: number;
  refine_ms: number;
}

/**
 * A machine's pace (machinePaces) for a model of `family`: its pace on that family where it was compared on it (a pod
 * twice as fast on Qwen pictures was not on SCAIL windows), else its own; undefined when it is not known.
 */
export function paceOf(paces: ReadonlyMap<string, number> | undefined, machine: string | null | undefined, family?: string | null): number | undefined {
  if (!paces || !machine) return undefined;
  const ofFamily = family && paces instanceof Paces ? paces.families.get(machine)?.get(family) : undefined;
  return ofFamily ?? paces.get(machine);
}

/** A render read at `k` times its pace: what its steps and the passes around them took, the load as it was (the disk's, not the card's). */
function atPace<R extends Timed>(r: R, k: number): R {
  if (k === 1) return r;
  return { ...r, step_ms: r.step_ms === null ? null : r.step_ms * k, total_ms: r.load_ms + (r.total_ms - r.load_ms) * k, sample_ms: r.sample_ms * k, refine_ms: r.refine_ms * k };
}

/**
 * The renders a forecast for `like.machine` is read from. Its own renders of the recipe (with its others of the model) once
 * it has OWN_POINTS of them. With one or two, those beside the renders of the machines with the same GPU when they rendered
 * it (one render, a model read from a cold disk, took 11 s where its twin machine's five said 6.7), else alone: two windows
 * on a rented A40 (214 and 225 s) say more of the next one there than the owner's 4070 Ti's, whose disk and passes around
 * the steps are not the pod's (mixed with them, 169 and 173 s). With none, the others': the renders of the machines with the
 * same GPU, else of the machine that rendered it most among those whose pace is known, at this machine's pace against that
 * one's (machinePaces: learned, else its GPU's, else the rough speed table's for a pod's GPU never rendered on), so that a
 * new pod is not told another card's times; as they are when no pace is known. The load is left as it was: it is the
 * disk's, not the card's. No machine asked: every render at the common pace (its time over its machine's pace), the figure
 * the GPU hunt multiplies by a GPU's pace; as they are when no pace is known.
 */
export function onMachine<R extends Timed>(rows: R[], like: Pick<Like, "machine" | "paces" | "recipeId" | "family">): R[] {
  const machine = like.machine;
  const pace = (m: string | null) => paceOf(like.paces, m, like.family);
  if (!machine) return like.paces?.size ? rows.map((r) => atPace(r, 1 / (pace(r.machine_id) ?? 1))) : rows;
  const ofRecipe = (rs: R[]) => (like.recipeId ? rs.filter((r) => r.recipe_id === like.recipeId) : rs);
  const mine = rows.filter((r) => r.machine_id === machine);
  const own = ofRecipe(mine).length;
  if (own >= OWN_POINTS) return mine;
  const others = rows.filter((r) => r.machine_id !== machine);
  const target = pace(machine);
  const at = (rs: R[], from: string | null) => {
    const p = pace(from);
    return target !== undefined && p !== undefined ? rs.map((r) => atPace(r, target / p)) : rs;
  };
  // the machines with the same card (a second PC with the same GPU, the A40 pod deployed again): theirs as they are, or at
  // the pace each was learned at
  const gpu = mine.find((r) => r.gpu)?.gpu ?? (like.paces instanceof Paces ? like.paces.gpus.get(machine) : undefined);
  const twins = gpu ? others.filter((r) => r.gpu && gpuKey(r.gpu) === gpuKey(gpu)) : [];
  const twinsAt = () => twins.flatMap((r) => at([r], r.machine_id));
  // its own first renders beside its twins' (theirs first: of renders of one size, the first one's step is the one read,
  // forecastFrom, and theirs are the many)
  if (own) return ofRecipe(twins).length ? [...twinsAt(), ...mine] : mine;
  // with none of the recipe, its renders of the model's other recipes do not stand for this one: its twins', unless they
  // never rendered the recipe and another machine did
  if (twins.length && (ofRecipe(twins).length || !ofRecipe(others).length)) return twinsAt();
  // the machine with the most renders of the recipe (else of the model), among those whose pace is known when this one's
  // is; a tie goes to the one that rendered last
  const known = target === undefined ? [] : others.filter((r) => pace(r.machine_id) !== undefined);
  const from = known.length ? known : others;
  const counted = ofRecipe(from).length ? ofRecipe(from) : from;
  const counts = new Map<string | null, number>();
  for (const r of counted) counts.set(r.machine_id, (counts.get(r.machine_id) ?? 0) + 1);
  const most = [...counts].reduce<[string | null, number] | null>((best, c) => (!best || c[1] > best[1] ? c : best), null)?.[0] ?? null;
  const theirs = at(others.filter((r) => r.machine_id === most), most);
  return theirs.length ? theirs : mine;
}

/** What of a recorded render a forecast reads. */
const TIMED = ["machine_id", "gpu", "recipe_id", "time_key", "kind", "width", "height", "duration_ms", "work", "steps", "step_ms", "total_ms", "sample_ms", "refine_ms", "load_ms", "cold"] as const;

/** A model's last 200 whole renders that were timed, newest first: what a forecast for it is read from. */
export function statRows(db: Db, modelFile: string) {
  return db
    .selectFrom("render_stats")
    .select(TIMED)
    .where("model_file", "=", modelFile)
    .where("status", "=", "done")
    .where("whole", "=", 1)
    .where("step_ms", "is not", null)
    .where("work", "is not", null)
    .orderBy("created_at", "desc")
    .limit(200)
    .execute();
}
export type StatRows = Awaited<ReturnType<typeof statRows>>;

/** What this model's past renders say about a render of `work` sampled over `steps`, with its model to load or already in memory. */
export async function forecast(db: Db, modelFile: string, work: number, steps: number, cold: boolean, like: Like = {}): Promise<Forecast | null> {
  if (!modelFile) return null;
  const found = await (like.rows ?? ((file: string) => statRows(db, file)))(modelFile);
  const fps = like.fps ?? (() => undefined);
  const timed = (rs: StatRows) => onMachine(rs.flatMap((r) => {
    const w = workOfRow(r, fps);
    return w ? [{ ...r, work: w }] : [];
  }), like);
  const all = timed(found);
  // a render that samples nothing of its own (a finish re-sampling a draft's latent, a sharper pass over a picture) spends its
  // steps in the passes after, and is priced from the renders like it: next to a draft's, its steps read nothing alike. A
  // model with none like it yet reads its family's others' of that kind, and with none there either nothing is said here
  // (the recipe's usual is, fromRates): a model's first finish priced from its drafts was said 5,626 s, and took 309
  const ofKind = <R extends { sample_ms: number }>(rs: R[]): R[] => (like.samples === undefined ? rs : rs.filter((r) => (r.sample_ms > 0) === like.samples));
  let rows = ofKind(all);
  if (!rows.length && all.length && like.family) rows = ofKind(timed(await familyRows(db, like.family, modelFile)));
  if (!rows.length) return null;
  // the renders of the same recipe when there are enough of them: the model's others sample something else per step
  // (an upscale re-samples tiles of a larger picture), and placed among them a form read like theirs
  const own = like.recipeId ? rows.filter((r) => r.recipe_id === like.recipeId) : [];
  const keyed = like.timeKey ? own.filter((r) => r.time_key === like.timeKey) : [];
  const pool = own.length >= OWN_POINTS ? own : rows;
  const pointsOf = (rs: typeof rows): Point[] => rs.map((r) => ({ work: r.work, stepMs: r.step_ms! }));
  // with a render or two of its own, the model's others are read at the recipe's pace against theirs, its own beside them:
  // an edit steps three times slower than a picture of its size, and placed among the pictures as it was its own render
  // looked past the cliff and was left out (25 s said, 74 s taken)
  const others = own.length && own.length < OWN_POINTS ? pointsOf(rows.filter((r) => r.recipe_id !== like.recipeId)) : [];
  const k = others.length ? median(own.map((r) => r.step_ms! / (forecastFrom(others, r.work, 1, 0)?.ms ?? 0)).filter((x) => x > 0 && Number.isFinite(x))) : 0;
  const points = k > 0 ? [...pointsOf(own), ...others.map((p) => ({ work: p.work, stepMs: p.stepMs * k }))] : pointsOf(pool);
  // two renders or more of the very same form on this machine say its step: its settings may step unlike the model's others
  // of its size (an H3 window with an end frame took 24.6 s a step where the others of its size took 7.5)
  const same = keyed.filter((r) => Math.abs(r.work - work) <= work * 0.02 && (!like.machine || r.machine_id === like.machine)).slice(0, 5);
  const stepMs = same.length >= 2 ? median(same.map((r) => r.step_ms!)) : null;
  // what surrounds the steps (the finishing, the passes after them, what a step does not count) is the settings' own: from
  // the renders with the same ones, else the recipe's, else the model's, as usualParts tells it for the running render: it is
  // what each took beyond its steps and its load, so that its passes after are not counted twice, as steps and again as a
  // pass. A recipe made in chunks counts every chunk's steps at its first chunk's pace (the one its step measures): with a
  // short last chunk that is more than its sampling took, and what surrounds the steps read as nothing; its sampling is taken then
  const stepped = (r: (typeof rows)[number]) => {
    const counted = Math.max(1, r.steps) * r.step_ms!;
    return like.chunks && r.sample_ms > 0 ? Math.min(counted, r.sample_ms + r.refine_ms) : counted;
  };
  const aroundOf = keyed.length ? keyed : own.length ? own : rows;
  const beside = median(aroundOf.map((r) => r.total_ms - r.load_ms - stepped(r)));
  // read from the recipe's renders with other settings, it is read at this form's size: decoding and saving 8 s of video
  // take more than 5 s did (the model's other recipes surround their steps with other passes, and are taken as they are)
  const around = keyed.length || !own.length ? beside : beside * (work / (median(own.map((r) => r.work)) || work));
  // and what comes before the first step: what even a model in memory spends (the text, the pictures), and with the
  // model to load, that load. A model never loaded cold here is taken to load as the family's others did, else any
  // model: left out, the cold forecast said less than the same form with the model in memory. A render filed warm that
  // loaded the model all the same (ComfyUI let it go to make room) is no warm load: one such, of a model rendered twice,
  // made its next renders read 140 s for 20. With fewer than three, the family's on this machine say more
  const coldMid = median(rows.filter((r) => r.cold).map((r) => r.load_ms));
  const warmOnly = (loads: number[]) => {
    const above = Math.max(reloadAbove(loads), coldMid / 2);
    return loads.filter((l) => l <= above);
  };
  let warmLoads = warmOnly(pool.filter((r) => !r.cold).map((r) => r.load_ms));
  if (warmLoads.length < 3 && like.family) {
    const family = warmOnly(await familyWarmLoads(db, like.family, like.machine ?? null));
    if (family.length > warmLoads.length) warmLoads = family;
  }
  const warm = warmLoads.length ? median(warmLoads) : 0;
  let load = warm;
  if (cold) {
    // a load is the machine's disk, not its card: a pod's network volume read a picture model in 51 s that this PC reads
    // in 15. This machine's loads of the model first, then of its family, then of any model; the others' only when it
    // never loaded one
    const coldOf = (rs: typeof all) => rs.filter((r) => r.cold).map((r) => r.load_ms);
    const here = (rs: typeof all) => rs.filter((r) => r.machine_id === like.machine);
    let coldLoads = like.machine ? [coldOf(here(pool)), coldOf(here(all))].find((ls) => ls.length) ?? (await coldLoadsElsewhere(db, like.family, like.machine)) : [];
    if (!coldLoads.length) coldLoads = [pool, rows].map(coldOf).find((ls) => ls.length) ?? (await coldLoadsElsewhere(db, like.family, null));
    load = Math.max(warm, coldLoads.length ? median(coldLoads) : 0);
  }
  const f = forecastFrom(points, work, steps, Math.max(0, around) + load, like.chunks, stepMs);
  // what the load adds over what a model in memory still spends before its first step
  return f && cold ? { ...f, loadMs: Math.round(load - warm) } : f;
}

/**
 * The loads of the latest renders that loaded their model cold and sampled (a render ComfyUI answered from its cache "loaded"
 * nothing), on `machine` when it is said: of the family's models, else of any.
 */
async function coldLoadsElsewhere(db: Db, family: string | undefined, machine: string | null): Promise<number[]> {
  const of = (fam: string | null) => {
    let q = db.selectFrom("render_stats").select("load_ms").where("status", "=", "done").where("whole", "=", 1).where("cold", "=", 1).where("model_file", "!=", "").where("step_ms", "is not", null);
    if (fam) q = q.where("family", "=", fam);
    if (machine) q = q.where("machine_id", "=", machine);
    return q.orderBy("created_at", "desc").limit(50).execute();
  };
  const ofFamily = family ? await of(family) : [];
  return (ofFamily.length ? ofFamily : await of(null)).map((r) => r.load_ms);
}

/** The family's other models' last 200 whole renders that were timed, newest first: what a model with none of a kind is read from. */
function familyRows(db: Db, family: string, modelFile: string): Promise<StatRows> {
  return db
    .selectFrom("render_stats")
    .select(TIMED)
    .where("family", "=", family)
    .where("model_file", "!=", modelFile)
    .where("model_file", "!=", "")
    .where("status", "=", "done")
    .where("whole", "=", 1)
    .where("step_ms", "is not", null)
    .where("work", "is not", null)
    .orderBy("created_at", "desc")
    .limit(200)
    .execute();
}

/** The loads of the family's latest renders with their model in memory, on `machine` (its disk and its text encoders), else anywhere. */
async function familyWarmLoads(db: Db, family: string, machine: string | null): Promise<number[]> {
  const on = (m: string | null) => {
    let q = db.selectFrom("render_stats").select("load_ms").where("status", "=", "done").where("whole", "=", 1).where("cold", "=", 0).where("family", "=", family).where("model_file", "!=", "");
    if (m) q = q.where("machine_id", "=", m);
    return q.orderBy("created_at", "desc").limit(50).execute();
  };
  const here = machine ? await on(machine) : [];
  return (here.length ? here : await on(null)).map((r) => r.load_ms);
}

/** Below this, a load is no sign the model was loaded again: a video model's text encoder alone takes 10 to 15 s, in memory or not. */
export const RELOAD_MS = 15_000;

/**
 * The load above which a render filed with its model in memory did load it (ComfyUI let it go to make room for another):
 * three times what the quicker half of `warmLoads` took, and RELOAD_MS at least. The quicker half: of two loads, one of
 * them a reload, the middle is half that reload, and a reload is never three times it.
 */
export function reloadAbove(warmLoads: readonly number[]): number {
  const quicker = [...warmLoads].sort((a, b) => a - b).slice(0, Math.max(1, Math.ceil(warmLoads.length / 2)));
  return Math.max(RELOAD_MS, 3 * median(quicker));
}

/** How many renders of a recipe its own points are taken from alone: with fewer, the model's others say more. */
const OWN_POINTS = 3;

/**
 * What renders queued one after another take in all, from each one's forecast (its `ms` with its `loadMs`) and `times`
 * renders of each: a model loads for the first of a run of renders with it, and the others find it in memory. A part
 * with no model (a tool on the GPU) frees it: the render after loads its own again.
 */
export function inARow(parts: Array<{ ms: number; loadMs: number; model: string; times?: number }>): number {
  let total = 0;
  let held = "";
  for (const p of parts) {
    const load = p.model && p.model === held ? 0 : p.loadMs;
    total += (p.ms - p.loadMs) * Math.max(1, p.times ?? 1) + load;
    held = p.model;
  }
  return total;
}

// ---------------------------------------------------------------- where no render of the model was measured yet

/**
 * Per recipe, the usual time of one job and, for videos, of one second of video, from what was rendered
 * before. Only what `forecast` falls back on for a form it cannot place (a tool with no steps, a model not
 * measured yet): never a figure of its own. From the record of render times where the recipe has one: what each
 * render took beyond its load, at the common pace (its machine's pace taken out, machinePaces), and its loads
 * apart, warm and cold; from the generations (kept since before render times were recorded) where it has none.
 */
export interface Rate {
  /** The usual time of one job, in milliseconds: beyond its loads and at the common pace where `loads` is said. */
  perJobMs: number;
  /** Of a video recipe: the usual time for one second of video. */
  perSecondMs: number | null;
  /** What it spends before its first step with its model in memory, and with its model to load (else its family's); null for a rate read from the generations, whose times hold their loads as they came. */
  loads: { warmMs: number; coldMs: number | null } | null;
  /** How many past renders this rests on. */
  samples: number;
}

/** How many past renders the fallback looks at: the recent ones say more about the machine as it is now. */
const LOOK_BACK = 400;

export async function rates(db: Db): Promise<Record<string, Rate>> {
  const [recorded, paces] = await Promise.all([
    db
      .selectFrom("render_stats")
      .select(["recipe_id", "family", "machine_id", "total_ms", "load_ms", "cold", "kind", "duration_ms"])
      .where("status", "=", "done")
      .where("whole", "=", 1)
      .orderBy("created_at", "desc")
      .limit(LOOK_BACK)
      .execute(),
    machinePaces(db).catch(() => new Map<string, number>()),
  ]);
  const byRecipe = new Map<string, { family: string; jobs: number[]; perSecond: number[]; warm: number[]; cold: number[] }>();
  const coldOfFamily = new Map<string, number[]>();
  for (const r of recorded) {
    const at = byRecipe.get(r.recipe_id) ?? { family: r.family, jobs: [], perSecond: [], warm: [], cold: [] };
    byRecipe.set(r.recipe_id, at);
    // a pod twice as slow as this PC made the fallback of every machine half again too long, and the load in it twice over
    const run = Math.max(0, r.total_ms - r.load_ms) / ((r.machine_id && paces.get(r.machine_id)) || 1);
    at.jobs.push(run);
    if (r.kind === "video" && r.duration_ms && r.duration_ms > 0) at.perSecond.push(run / (r.duration_ms / 1000));
    (r.cold ? at.cold : at.warm).push(r.load_ms);
    if (r.cold) coldOfFamily.set(r.family, [...(coldOfFamily.get(r.family) ?? []), r.load_ms]);
  }
  const out: Record<string, Rate> = {};
  for (const [id, v] of byRecipe) {
    const cold = v.cold.length ? v.cold : (coldOfFamily.get(v.family) ?? []);
    out[id] = {
      perJobMs: Math.round(median(v.jobs)), perSecondMs: v.perSecond.length ? Math.round(median(v.perSecond)) : null,
      loads: { warmMs: Math.round(median(v.warm)), coldMs: cold.length ? Math.round(median(cold)) : null }, samples: v.jobs.length,
    };
  }
  const rows = await db
    .selectFrom("generations")
    .innerJoin("assets", "assets.generation_id", "generations.id")
    .select(["generations.id", "generations.recipe_id", "generations.gen_ms", "assets.kind", "assets.duration_ms"])
    .orderBy("generations.created_at", "desc")
    .limit(LOOK_BACK)
    .execute();
  const seen = new Set<string>();
  const before = new Map<string, { jobs: number[]; perSecond: number[] }>();
  for (const r of rows) {
    // a job that gave several results is one render; a recipe on the record of render times is read from it
    if (seen.has(r.id) || r.gen_ms <= 0 || out[r.recipe_id]) continue;
    seen.add(r.id);
    const at = before.get(r.recipe_id) ?? { jobs: [], perSecond: [] };
    at.jobs.push(r.gen_ms);
    if (r.kind === "video" && r.duration_ms && r.duration_ms > 0) at.perSecond.push(r.gen_ms / (r.duration_ms / 1000));
    before.set(r.recipe_id, at);
  }
  for (const [id, v] of before) out[id] = { perJobMs: Math.round(median(v.jobs)), perSecondMs: v.perSecond.length ? Math.round(median(v.perSecond)) : null, loads: null, samples: v.jobs.length };
  return out;
}

/**
 * The fallback as a forecast: the recipe's usual job, or its usual pace times the video's seconds, at `at.pace` (the
 * machine's, machinePaces; left out, the common pace), with its model's load when `at.cold` (the recipe's usual cold load,
 * else its family's); null when it never rendered. Without it, a Face detailer whose checkpoint was in memory was told
 * the 74 s its cold renders took (10 s), and a pod's job was recorded at this PC's time while its lane showed its own.
 */
export function fromRates(all: Record<string, Rate>, recipe: Recipe<any>, input: Record<string, unknown>, at: { cold?: boolean | null; pace?: number } = {}): Forecast | null {
  const rate = all[recipe.id];
  if (!rate) return null;
  const seconds = secondsOf(recipe.inputs, input);
  const run = (rate.perSecondMs && seconds ? rate.perSecondMs * seconds : rate.perJobMs) * (at.pace && at.pace > 0 ? at.pace : 1);
  const warm = rate.loads?.warmMs ?? 0;
  const load = at.cold && rate.loads ? Math.max(warm, rate.loads.coldMs ?? warm) : warm;
  return { ms: Math.round(run + load), pace: "usual", fitsUpTo: 0, samples: rate.samples, loadMs: Math.round(load - warm) };
}

/** The forecast as the form says it: a line, and, past the cliff, the words that go next to the setting that drives the size. */
export function said(f: Forecast, shape: { pixels: number; frames: number }): { text: string; hint: string | null } {
  // rounded as the Generate button rounds it (core's roughly): the two say one figure
  const dur = roughly(f.ms);
  const fits = shape.frames > 1 ? `${Math.floor(f.fitsUpTo / Math.max(1, shape.pixels))} frames at this size` : `about ${(f.fitsUpTo / 1e6).toFixed(1)} MP`;
  if (f.pace === "over") return { text: `About ${dur}: past where this model slowed down on your card before (up to ${fits} kept the usual pace).`, hint: `past where this model slowed down on your card: up to ${fits} kept the usual pace` };
  if (f.pace === "untested") return { text: `About ${dur}, if it keeps the pace of your renders with this model: none was this large yet.`, hint: null };
  if (!f.fitsUpTo) return { text: `About ${dur}, from your renders of this kind.`, hint: null };
  return { text: `About ${dur}, from your renders with this model.`, hint: null };
}

/** How many renders of the same settings a machine needs before its pace is set against another's. */
const PACE_RENDERS = 3;
/**
 * How many of each machine's latest renders of each model the paces are read from: the latest renders of every kind would
 * be this PC's alone a week after a pod rendered (about 80 a day), and the pod's pace forgotten.
 */
const PACE_ROWS = 40;

/** A render as the paces read it: where it ran, and what a step cost for its work. */
interface PaceRow extends RecordedWork {
  machine_id: string | null;
  gpu: string | null;
  model_file: string;
  family: string;
  time_key: string;
  step_ms: number;
}

/** The renders the paces are learned from: each machine's (and card's) latest PACE_ROWS of each model. */
async function paceRows(db: Db): Promise<PaceRow[]> {
  const { rows } = await sql<PaceRow>`
    select machine_id, gpu, model_file, family, time_key, recipe_id, kind, width, height, duration_ms, work, step_ms from (
      select *, row_number() over (partition by machine_id, gpu, model_file order by created_at desc) as n from render_stats
      where status = 'done' and whole = 1 and step_ms is not null and work is not null and model_file != ''
    ) where n <= ${PACE_ROWS}`.execute(db);
  return rows;
}

/** One machine's (or card's) pace: against the common pace, on the models of each family it was compared on, and from how many renders. */
interface Compared {
  pace: number;
  families: Map<string, number>;
  renders: number;
}

/**
 * The paces of whatever `who` tells the renders apart by (a machine, a card). For each model and recipe rendered by more
 * than one, each one's usual step for its work against the usual step of all, and the middle of those: compared on the
 * step for the work, the windows of a Motion transfer cut at different lengths are one comparison. One is compared on a
 * recipe it rendered PACE_RENDERS times: one render (a model loaded cold, the card busy elsewhere) made the owner's own PC
 * read 1.8 times slower than a pod and every estimate on it nearly doubled. One compared with nothing has no pace; when
 * nothing was compared at all, the one that rendered most is the common pace (1), what a pod's GPU is guessed against.
 */
function compared(rows: readonly PaceRow[], who: (r: PaceRow) => string | null): Map<string, Compared> {
  const byKey = new Map<string, { family: string; costs: Map<string, number[]> }>();
  for (const r of rows) {
    const id = who(r);
    // a video recorded with one frame's work (before 2026-10-10) is left out: its step reads a hundred times dearer; and one
    // recorded with more frames than its length holds at 60 a second (the 4096 a Motion transfer's batch node said): fifty
    // times cheaper, it made this PC's pace read 0.03
    const work = workOfRow(r, () => undefined);
    if (!id || work === null || !(r.step_ms > 0)) continue;
    if (r.kind === "video" && r.width && r.height && r.duration_ms && work / (r.width * r.height) > 2 * 60 * (r.duration_ms / 1000)) continue;
    // a render whose graph says no size (an edit of the picture it is given) is compared on the same settings' step alone
    const key = work > 0 ? `${r.model_file}\n${r.recipe_id}` : `${r.model_file}\n${r.recipe_id}\n${r.time_key}`;
    const at = byKey.get(key) ?? { family: r.family, costs: new Map<string, number[]>() };
    byKey.set(key, at);
    at.costs.set(id, [...(at.costs.get(id) ?? []), work > 0 ? r.step_ms / work : r.step_ms]);
  }
  for (const { costs } of byKey.values()) for (const [id, cs] of costs) if (cs.length < PACE_RENDERS) costs.delete(id);
  const ratios = new Map<string, Array<{ family: string; ratio: number; renders: number }>>();
  for (const { family, costs } of byKey.values()) {
    if (costs.size < 2) continue;
    const all = median([...costs.values()].flat());
    if (!(all > 0)) continue;
    for (const [id, cs] of costs) ratios.set(id, [...(ratios.get(id) ?? []), { family, ratio: median(cs) / all, renders: cs.length }]);
  }
  const out = new Map<string, Compared>();
  for (const [id, rs] of ratios) {
    const families = new Map([...new Set(rs.map((r) => r.family))].map((f) => [f, median(rs.filter((r) => r.family === f).map((r) => r.ratio))] as const));
    out.set(id, { pace: median(rs.map((r) => r.ratio)), families, renders: rs.reduce((sum, r) => sum + r.renders, 0) });
  }
  // 1 is the pace of the one compared on the most renders (the owner's PC, as a rule), not the middle of them: with two
  // machines the middle lies between them and the PC read �1.33 against itself. Only the ratios between them count
  const most = [...out.values()].sort((a, b) => b.renders - a.renders)[0];
  if (most && most.pace > 0) {
    const by = most.pace;
    for (const c of out.values()) {
      c.pace /= by;
      for (const [f, p] of c.families) c.families.set(f, p / by);
    }
  }
  if (!out.size) {
    const counts = new Map<string, number>();
    for (const { costs } of byKey.values()) for (const [id, cs] of costs) counts.set(id, (counts.get(id) ?? 0) + cs.length);
    const most = [...counts].sort((a, b) => b[1] - a[1])[0];
    if (most) out.set(most[0], { pace: 1, families: new Map(), renders: most[1] });
  }
  return out;
}

/**
 * Each machine's pace (settings.ts `machines`), as machinePaces gives it: 1 is the common pace, 2 half as fast. Read as a
 * map it is the machine's pace overall; `paceOf` reads it for a model's family.
 */
export class Paces extends Map<string, number> {
  /** Per machine, its pace on the models of a family, where it was compared on them. */
  readonly families = new Map<string, Map<string, number>>();
  /** Per machine, its GPU's name: as its renders give it, else as RunPod named the pod's. */
  readonly gpus = new Map<string, string>();
}

/**
 * Each machine's pace against all of them. Learned from its own renders (compared), else its GPU's (the A40 pod deployed
 * again, a second PC with the same card), else, for a pod's GPU never rendered on (RunPod names it before the pod's first
 * render), the rough speed table's against the card rendered on most that the table knows. A machine none of them tells
 * has no pace. A forecast on a machine reads another's renders at its pace against that one's (onMachine).
 */
export async function machinePaces(db: Db): Promise<Paces> {
  const rows = await paceRows(db);
  const own = compared(rows, (r) => r.machine_id);
  const cards = compared(rows, (r) => (r.gpu ? gpuKey(r.gpu) : null));
  const paces = new Paces();
  for (const r of rows) if (r.machine_id && r.gpu && !paces.gpus.has(r.machine_id)) paces.gpus.set(r.machine_id, r.gpu);
  const sessions = await db.selectFrom("rent_sessions").select(["machine_id", "gpu"]).where("gpu", "is not", null).orderBy("started_at", "desc").execute();
  for (const s of sessions) if (!paces.gpus.has(s.machine_id)) paces.gpus.set(s.machine_id, s.gpu!);
  // the table's guesses are anchored on a rented card first: a home card shares its memory with the desktop and spills the
  // larger models (the owner's 4070 Ti read slower than an A40 the table puts under it), a rented one renders alone
  const rented = new Set(sessions.map((s) => gpuKey(s.gpu!)));
  const anchor = [...cards].filter(([card]) => roughSpeed(card) !== null).sort((a, b) => Number(rented.has(b[0])) - Number(rented.has(a[0])) || b[1].renders - a[1].renders)[0];
  for (const machine of new Set([...own.keys(), ...paces.gpus.keys()])) {
    const gpu = paces.gpus.get(machine);
    const learned = own.get(machine) ?? (gpu ? cards.get(gpuKey(gpu)) : undefined);
    if (learned) {
      paces.set(machine, learned.pace);
      if (learned.families.size) paces.families.set(machine, learned.families);
      continue;
    }
    const speed = gpu ? roughSpeed(gpu) : null;
    if (speed && anchor) paces.set(machine, (anchor[1].pace * roughSpeed(anchor[0])!) / speed);
  }
  return paces;
}

/**
 * Each GPU's pace against all of them, by its name as ComfyUI gave it (render_stats.gpu), as machinePaces learns the
 * machines', with how many renders it was compared on: what the GPU hunt (hunt.ts) ranks RunPod's GPUs by. A GPU compared
 * with nothing is left out (the hunt guesses it from the table); with one GPU rendered on, it is the common pace (1).
 */
export async function gpuPaces(db: Db): Promise<Array<{ gpu: string; pace: number; renders: number }>> {
  const rows = await paceRows(db);
  const names = new Map<string, string>();
  for (const r of rows) if (r.gpu && !names.has(gpuKey(r.gpu))) names.set(gpuKey(r.gpu), r.gpu);
  return [...compared(rows, (r) => (r.gpu ? gpuKey(r.gpu) : null))].map(([card, c]) => ({ gpu: names.get(card)!, pace: c.pace, renders: c.renders }));
}
