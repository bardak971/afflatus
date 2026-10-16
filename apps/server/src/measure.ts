import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tools } from "./video";
import { ffmpegPool } from "./pool";
import { failureOf, FfmpegMissing, ffRun, heldLast, inTemp, type Media, missing, must, onDisk, STRIP } from "./cut";

/**
 * Measuring videos (cut.ts runs them): how a take looks (lookOf), what its landing measures at once (takeMeasures), its
 * frame means for the colour match at a join, its motion and loudness under the ruler (measureOf), and where its shots
 * cut (scenesOf).
 */

/** How many motion samples a second are measured. */
export const MOTION_RATE = 10;

/** How a video's own part looks, measured on its real frames when it was stored (see lookOf). */
export interface Measure {
  /** Mean luma, 0 to 255. */
  luma: number;
  /** Sharpness: the mean absolute Laplacian of a 256-pixel-wide grey copy. 0 is flat, several units is crisp. Grain counts in it. */
  sharp: number;
  /** Sharpness without the grain: the same Laplacian on the copy cleaned of its fine noise (a 3×3 median). Takes measured before 2026-10-14 have none. */
  edges?: number;
  /** Grain: how far the copy's pixels sit from its 3×3 median, in luma steps (0 to 255): the fine noise, not the detail. */
  grain?: number;
  /** How much the face along the clip is the person it is of (its Picture, its cast): ArcFace, the median over a few frames and the lowest. With the Face Match node only. */
  face?: number;
  faceLow?: number;
  /** Mean chroma against neutral: U is blue (+) to yellow (−), V red (+) to green (−); −128 to 127. */
  chroma?: { u: number; v: number };
  /** Where the darkest and the brightest tenth of the picture sit in luma (signalstats YLOW and YHIGH). */
  range?: { low: number; high: number };
  /** Exposure flicker: the mean change of the frame's mean luma from one sampled frame to the next, as a percentage of the mean (12 samples a second). */
  flicker?: number;
  /** Pace: the mean frame-to-frame difference on a small grey copy, ten samples a second (the ruler's motion figure). */
  pace?: number;
  /** The sound's spectral centroid in Hz, where its energy sits: a voice that dulls drifts down. null without sound. */
  voice?: number | null;
  /** A join made in the latent: how wide the regenerated run-up came out against the latent tail it was guided by, as a ratio over the channels (1 = the same). */
  drift?: { width: number };
  /** A continuation: how much the picture jumps where the run-up ends and the clip's own frames begin, against its own motion right after (×1 = it carries on; ×3 and past, the model stepped away from its guide and a cut shows there). */
  handover?: number;
}

/**
 * How a video's own part looks, in a few numbers measured on its real frames: mean luma, sharpness, chroma,
 * luma range, flicker, pace and the sound's centre of weight (see Look). From `fromMs` on (a continuation's
 * own part, after the frames it shares with the clip before). For telling whether a run of clips that flow
 * on slides darker, softer, duller or slower clip after clip. A pass of ffmpeg per figure: what a take's
 * landing measures in one (takeMeasures) and falls back to when that one fails.
 */
export async function lookOf(source: Media, ext: string, fromMs = 0): Promise<Measure | null> {
  return inTemp(async (dir) => {
    const input = await onDisk(dir, `in.${ext}`, source);
    const run = (args: string[]) => must(tools.ffmpeg, ["-loglevel", "error", "-ss", (Math.max(0, fromMs) / 1000).toFixed(3), "-i", input, ...args, "-f", "null", "-"], { timeout: 5 * 60_000 }).catch(() => "");
    // luma, its spread and the chroma, 12 frames a second on a small colour copy
    const stats = await run(["-an", "-vf", `${LOOK.stats},metadata=print:file=-`]);
    if (!picked(stats, "signalstats\\.YAVG").length) return null;
    const sharp = await run(["-an", "-vf", `${LOOK.gray},${LOOK.sharp},metadata=print:key=lavfi.signalstats.YAVG:file=-`]);
    if (!picked(sharp, "signalstats\\.YAVG").length) return null;
    return lookFrom({
      stats,
      sharp,
      edges: await run(["-an", "-vf", `${LOOK.gray},${LOOK.edges},metadata=print:key=lavfi.signalstats.YAVG:file=-`]),
      grain: await run(["-an", "-vf", `${LOOK.gray},split[a][b];[b]median=radius=1[c];[a][c]${LOOK.grain},metadata=print:key=lavfi.signalstats.YAVG:file=-`]),
      pace: picked(await run(["-an", "-vf", `${LOOK.pace},metadata=print:key=lavfi.signalstats.YAVG:file=-`]), "signalstats\\.YAVG"),
      centroid: await run(["-vn", "-af", `${LOOK.voice}:file=-`]),
    });
  });
}

/**
 * The filters each figure of a look is read through. `gray`: the small grey copy sharpness, edges and grain share.
 * sharp: the Laplacian around 128, folded to its size (its mean over the frame is the sharpness); edges: the same on the
 * copy cleaned of its fine noise first; grain: the copy against its cleaned self (a blend of the two). pace: the motion,
 * as the ruler measures it. voice: the sound's spectral centroid.
 */
const LOOK = {
  stats: "fps=12,scale=256:-2,signalstats",
  gray: "fps=4,scale=256:-2,format=gray",
  sharp: "convolution=0m='0 -1 0 -1 4 -1 0 -1 0':0bias=128,lutyuv=y='if(gt(val\\,128)\\,val-128\\,128-val)',signalstats",
  edges: "median=radius=1,convolution=0m='0 -1 0 -1 4 -1 0 -1 0':0bias=128,lutyuv=y='if(gt(val\\,128)\\,val-128\\,128-val)',signalstats",
  grain: "blend=all_mode=difference,signalstats",
  pace: `fps=${MOTION_RATE},scale=96:-2,format=gray,tblend=all_mode=difference,signalstats`,
  voice: "aspectralstats=measure=centroid,ametadata=print:key=lavfi.aspectralstats.1.centroid",
};

/** Every value ffmpeg printed for `key` (a metadata print, `lavfi.<key>=<value>` a line). */
const picked = (said: string, key: string) => [...said.matchAll(new RegExp(`lavfi\\.${key}=(-?[\\d.]+)`, "g"))].map((m) => Number(m[1])).filter((v) => Number.isFinite(v));

/** A look from what each of its passes printed (`pace` already read, its first sample dropped below); null without luma or sharpness. */
function lookFrom(said: { stats: string; sharp: string; edges: string; grain: string; pace: number[]; centroid: string }): Measure | null {
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const yavg = picked(said.stats, "signalstats\\.YAVG");
  const sharp = picked(said.sharp, "signalstats\\.YAVG");
  if (!yavg.length || !sharp.length) return null;
  const edges = picked(said.edges, "signalstats\\.YAVG");
  const grain = picked(said.grain, "signalstats\\.YAVG");
  // the first motion sample is a frame against nothing
  const pace = said.pace.slice(1);
  // nothing when there is no sound (or no such filter)
  const centroid = picked(said.centroid, "aspectralstats\\.1\\.centroid");
  const luma = mean(yavg);
  const steps = yavg.slice(1).map((v, i) => Math.abs(v - yavg[i]!));
  const u = picked(said.stats, "signalstats\\.UAVG");
  const v = picked(said.stats, "signalstats\\.VAVG");
  const low = picked(said.stats, "signalstats\\.YLOW");
  const high = picked(said.stats, "signalstats\\.YHIGH");
  return {
    luma: r1(luma),
    sharp: r2(mean(sharp)),
    ...(edges.length ? { edges: r2(mean(edges)) } : {}),
    ...(grain.length ? { grain: r2(mean(grain)) } : {}),
    ...(u.length && v.length ? { chroma: { u: r1(mean(u) - 128), v: r1(mean(v) - 128) } } : {}),
    ...(low.length && high.length ? { range: { low: r1(mean(low)), high: r1(mean(high)) } } : {}),
    flicker: steps.length ? r2((mean(steps) / Math.max(1, luma)) * 100) : 0,
    pace: pace.length ? r2(mean(pace)) : 0,
    voice: centroid.length ? Math.round(mean(centroid)) : null,
  };
}

/** What a take's landing measures of it at once (takeMeasures): its look, and what the timeline editor reads of it. */
export interface TakeMeasures {
  /** Of its own part (from `fromMs`), as lookOf measures it. */
  look: Measure | null;
  /** Of the whole video, as measureOf, meansAlong and filmStrip make them. */
  motion: { motion: number[]; sound: number[] | null; speech: number[] | null };
  means: FrameMeans;
  strip: Uint8Array;
}

/**
 * Everything a take is measured for when it lands, in one ffmpeg run that decodes it once: its look (lookOf), its motion
 * and loudness (measureOf), its frame means (meansAlong) and its track's film strip (filmStrip), each the same figures as
 * those give. Each was its own run before, eight decodes of the whole take (1080p 10 s: 17–22 CPU-s against ~5 in one).
 * Each figure is written to a file of its own in the temporary folder (ffmpeg runs there: a Windows path in a filter's
 * options needs escaping). A continuation's look starts at `fromMs`, cut there inside the graph as `-ss` would (the frames
 * from that moment, their clock moved back by it), so that its figures are those lookOf gives. null when the run fails
 * (a filter this ffmpeg lacks, a stream that cannot be read): the passes one at a time then.
 */
export async function takeMeasures(source: Media, ext: string, opts: { fromMs?: number; durationMs: number; hasSound: boolean }): Promise<TakeMeasures | null> {
  return inTemp(async (dir) => {
    const input = await onDisk(dir, `in.${ext}`, source);
    const from = Math.max(0, opts.fromMs ?? 0) / 1000;
    const cut = from > 0 ? `trim=start=${from.toFixed(3)},setpts=PTS-round(${from.toFixed(3)}/TB),` : "";
    const acut = from > 0 ? `atrim=start=${from.toFixed(3)},asetpts=PTS-round(${from.toFixed(3)}/TB),` : "";
    const print = (file: string, key?: string) => `metadata=print${key ? `:key=${key}` : ""}:file=${file}`;
    const yavg = "lavfi.signalstats.YAVG";
    // the strip as filmStrip makes the whole video's
    const every = Math.max(0.01, opts.durationMs / 1000 / STRIP.frames);
    const graph = [
      // the motion, from the start, is the look's pace too when the look starts there
      `[0:v]split=${from > 0 ? 5 : 4}[vm][vs][vt][vl]${from > 0 ? "[vp]" : ""}`,
      `[vm]scale=96:-2,signalstats,${print("means.txt")}[om]`,
      `[vs]${LOOK.pace},${print("motion.txt", yavg)}[os]`,
      `[vt]trim=end=${(opts.durationMs / 1000).toFixed(3)},${heldLast(every)}fps=1/${every.toFixed(4)}:start_time=0:round=down,scale=-2:${STRIP.height},tile=${STRIP.frames}x1[strip]`,
      `[vl]${cut}split[l1][l2]`,
      `[l1]${LOOK.stats},${print("stats.txt")}[o1]`,
      `[l2]${LOOK.gray},split=4[g1][g2][g3][g4]`,
      `[g1]${LOOK.sharp},${print("sharp.txt", yavg)}[o2]`,
      `[g2]${LOOK.edges},${print("edges.txt", yavg)}[o3]`,
      `[g4]median=radius=1[g5]`,
      `[g3][g5]${LOOK.grain},${print("grain.txt", yavg)}[o4]`,
      ...(from > 0 ? [`[vp]${cut}${LOOK.pace},${print("pace.txt", yavg)}[o5]`] : []),
    ];
    const outs = ["[om]", "[os]", "[o1]", "[o2]", "[o3]", "[o4]", ...(from > 0 ? ["[o5]"] : [])];
    if (opts.hasSound) {
      const band = `aresample=8000,asetnsamples=n=${8000 / MOTION_RATE}:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level`;
      graph.push(
        "[0:a]asplit=3[a1][a2][a3]",
        `[a1]${band}:file=sound.txt[ao1]`,
        `[a2]highpass=f=300,highpass=f=300,lowpass=f=3400,lowpass=f=3400,${band}:file=speech.txt[ao2]`,
        `[a3]${acut}${LOOK.voice}:file=voice.txt[ao3]`,
      );
      outs.push("[ao1]", "[ao2]", "[ao3]");
    }
    const ran = await ffRun(tools.ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-nostats", "-y", "-i", resolve(input), "-filter_complex", graph.join(";"),
      ...outs.flatMap((o) => ["-map", o]), "-f", "null", "-",
      "-map", "[strip]", "-frames:v", "1", "-q:v", "5", "strip.jpg",
    ], { cwd: dir, timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 });
    if (ran.missing) throw missing();
    if (ran.err) return null;
    const read = (name: string) => readFile(join(dir, name), "utf8").catch(() => "");
    const strip = await readFile(join(dir, "strip.jpg")).catch(() => null);
    const motionSaid = await read("motion.txt");
    if (!strip?.length || !motionSaid) return null;
    const rawMotion = picked(motionSaid, "signalstats\\.YAVG");
    const levels = opts.hasSound ? levelsIn(await read("sound.txt")) : [];
    const speech = levels.length ? levelsIn(await read("speech.txt")) : [];
    const look = lookFrom({
      stats: await read("stats.txt"),
      sharp: await read("sharp.txt"),
      edges: await read("edges.txt"),
      grain: await read("grain.txt"),
      pace: from > 0 ? picked(await read("pace.txt"), "signalstats\\.YAVG") : rawMotion,
      centroid: opts.hasSound ? await read("voice.txt") : "",
    });
    return {
      look,
      motion: { motion: motionIn(motionSaid), sound: levels.length ? levels : null, speech: speech.length ? speech : null },
      means: meansIn(await read("means.txt")),
      strip: new Uint8Array(strip),
    };
  });
}
/** How a clip is matched to the clip before at their join: over this long on each side, and by at most this many steps of 255. A nudge, never a grade. */
export const MATCH = { lookSec: 0.4, mostSteps: 14 };
export interface Means {
  y: number;
  u: number;
  v: number;
}
/**
 * The nudge a clip gets at its join: toward the clip before as it will look (its own nudge, `carry`, included),
 * on luma and both chroma planes, within MATCH.mostSteps. The export and the player apply the same one.
 */
export function colourNudge(before: Means, after: Means, carry: Means): Means {
  const nudge = (want: number, have: number) => Math.round(Math.max(-MATCH.mostSteps, Math.min(MATCH.mostSteps, want - have)) * 10) / 10;
  return { y: nudge(before.y + carry.y, after.y), u: nudge(before.u + carry.u, after.u), v: nudge(before.v + carry.v, after.v) };
}

/** Every frame's mean luma and chroma along a video, with its moment (ms from its first frame): see meansAlong. */
export interface FrameMeans {
  t: number[];
  y: number[];
  u: number[];
  v: number[];
}
/**
 * The mean luma and chroma of every frame of a video, measured as meansOf measures a stretch (the same small copy, every
 * frame), in one pass: the means of any stretch of it are then read off it (meansWithin) rather than run through ffmpeg each.
 */
export async function meansAlong(source: Media, ext: string): Promise<FrameMeans> {
  return inTemp(async (dir) => {
    const file = await onDisk(dir, `in.${ext}`, source);
    return meansIn(await must(tools.ffmpeg, ["-loglevel", "error", "-i", file, "-an", "-vf", "scale=96:-2,signalstats,metadata=print:file=-", "-f", "null", "-"], { timeout: 10 * 60_000 }));
  });
}

/** Frame means from what signalstats printed of every frame (a metadata print). */
function meansIn(said: string): FrameMeans {
  const out: FrameMeans = { t: [], y: [], u: [], v: [] };
  for (const block of said.split(/^frame:/m).slice(1)) {
    const at = Number(/pts_time:\s*(-?[\d.]+)/.exec(block)?.[1]);
    const pick = (key: string) => Number(new RegExp(`lavfi\\.signalstats\\.${key}=([\\d.]+)`).exec(block)?.[1]);
    const [y, u, v] = [pick("YAVG"), pick("UAVG"), pick("VAVG")];
    if (![at, y, u, v].every(Number.isFinite)) continue;
    out.t.push(at * 1000);
    out.y.push(y);
    out.u.push(u);
    out.v.push(v);
  }
  // from its first frame, as a stretch is asked for, whatever the file's first timestamp
  const first = out.t[0] ?? 0;
  out.t = out.t.map((t) => Math.round((t - first) * 10) / 10);
  return out;
}
/** The means of the frames from `fromMs` for `seconds`, read off a video's frame means as meansOf would measure them; null when no frame falls there. */
export function meansWithin(along: FrameMeans, fromMs: number, seconds: number): Means | null {
  const from = Math.max(0, fromMs);
  const to = from + seconds * 1000;
  const k = along.t.flatMap((t, i) => (t >= from - 0.5 && t < to - 0.5 ? [i] : []));
  if (!k.length) return null;
  const mean = (xs: number[]) => k.reduce((sum, i) => sum + xs[i]!, 0) / k.length;
  return { y: mean(along.y), u: mean(along.u), v: mean(along.v) };
}

/** The mean luma and chroma of a stretch of a video file, for matching one clip's colour to the next. */
export async function meansOf(file: string, fromSec: number, seconds: number): Promise<Means | null> {
  const said = await ffmpegPool(() => must(tools.ffmpeg, ["-loglevel", "error", "-ss", Math.max(0, fromSec).toFixed(3), "-t", seconds.toFixed(3), "-i", file, "-an", "-vf", "scale=96:-2,signalstats,metadata=print:file=-", "-f", "null", "-"])).catch(() => "");
  const pick = (key: string) => [...said.matchAll(new RegExp(`lavfi\\.signalstats\\.${key}=([\\d.]+)`, "g"))].map((m) => Number(m[1]));
  const y = pick("YAVG");
  const u = pick("UAVG");
  const v = pick("VAVG");
  if (!y.length) return null;
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  return { y: mean(y), u: mean(u), v: mean(v) };
}

/**
 * How much moves along a video, and how loud it is: ten samples a second each. Motion is the mean
 * difference between a frame and the one before, on a small grey copy (0 = still, 255 = everything
 * changed); loudness is the RMS level in dB of each tenth of a second (about -60 is silence, 0 is as
 * loud as it gets), null when there is no sound. For the curves under the ruler and the quiet moments
 * In and Out snap to. A sound file gives loudness only.
 */
export async function measureOf(source: Media, ext: string): Promise<{ motion: number[]; sound: number[] | null; speech: number[] | null }> {
  return ffmpegPool(() => inTemp(async (dir) => {
    const input = await onDisk(dir, `in.${ext}`, source);
    // the picture and the sound both, as most takes have: one ffmpeg run
    const tried = await measureAtOnce(dir, input, { video: true, sound: true });
    if (tried.measured) return tried.measured;
    // a file with only one of them (a video with no sound, a sound file): ffmpeg's refusal says which it has, and it is run
    // again for that one; anything else odd is measured as before, one stream at a time
    const only = /matches no streams/i.test(tried.log) ? { video: /Stream #0:\d+.*: Video:/.test(tried.log), sound: /Stream #0:\d+.*: Audio:/.test(tried.log) } : null;
    if (only && (only.video || only.sound)) {
      const again = await measureAtOnce(dir, input, only);
      if (again.measured) return again.measured;
    }
    return measureApart(input);
  }), { first: true });
}

/** RMS levels as measureOf keeps them: in dB, -90 for silence, to a tenth. */
const levelsIn = (said: string) => [...said.matchAll(/lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+|-inf|inf|nan)/g)].map((m) => Number(m[1])).map((v) => (Number.isFinite(v) ? Math.max(-90, Math.min(0, Math.round(v * 10) / 10)) : -90));
const motionIn = (said: string) => {
  const motion = [...said.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
  // the first sample is a frame against nothing
  if (motion.length) motion[0] = motion[1] ?? 0;
  return motion;
};

/**
 * measureOf's three measures in one ffmpeg run, the sound split in two (as it is and in a voice's band), each written to a
 * file of its own in `dir` (ffmpeg runs there: a Windows path in a filter's options needs escaping). Null with ffmpeg's log
 * when it refused (a stream asked for that the file does not have).
 */
async function measureAtOnce(dir: string, input: string, has: { video: boolean; sound: boolean }): Promise<{ measured: Awaited<ReturnType<typeof measureOf>> | null; log: string }> {
  const graph: string[] = [];
  const outs: string[] = [];
  const band = `aresample=8000,asetnsamples=n=${8000 / MOTION_RATE}:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level`;
  if (has.video) {
    graph.push(`[0:v]fps=${MOTION_RATE},scale=96:-2,format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=motion.txt[vo]`);
    outs.push("[vo]");
  }
  if (has.sound) {
    graph.push(`[0:a]asplit[a1][a2]`, `[a1]${band}:file=sound.txt[ao1]`, `[a2]highpass=f=300,highpass=f=300,lowpass=f=3400,lowpass=f=3400,${band}:file=speech.txt[ao2]`);
    outs.push("[ao1]", "[ao2]");
  }
  const ran = await ffRun(tools.ffmpeg, ["-hide_banner", "-loglevel", "info", "-nostats", "-i", resolve(input), "-filter_complex", graph.join(";"), ...outs.flatMap((o) => ["-map", o, "-f", "null", "-"])],
    { cwd: dir, timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 });
  if (ran.missing) throw missing();
  if (ran.err) return { measured: null, log: ran.stderr };
  const read = (name: string) => readFile(join(dir, name), "utf8").catch(() => "");
  const motion = has.video ? motionIn(await read("motion.txt")) : [];
  const levels = has.sound ? levelsIn(await read("sound.txt")) : [];
  const sound = levels.length ? levels : null;
  const voice = sound ? levelsIn(await read("speech.txt")) : [];
  return { measured: { motion, sound, speech: voice.length ? voice : null }, log: "" };
}

/** measureOf as it was first written, a stream at a time after ffprobe says which there are: for a file the one run refused (and what the tests hold the one run to). */
export async function measureApart(input: string): Promise<{ motion: number[]; sound: number[] | null; speech: number[] | null }> {
  // a file ffprobe cannot read has nothing to measure; ffprobe not there at all is said
  const streams = await must(tools.ffprobe, ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", input]).catch((err: Error) => {
    if (err instanceof FfmpegMissing) throw err;
    return "";
  });
  let motion: number[] = [];
  if (/video/.test(streams)) {
    const said = await must(tools.ffmpeg, [
      "-loglevel", "error", "-i", input, "-an",
      "-vf", `fps=${MOTION_RATE},scale=96:-2,format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-`,
      "-f", "null", "-",
    ], { timeout: 10 * 60_000 });
    motion = motionIn(said);
  }
  let sound: number[] | null = null;
  if (/audio/.test(streams)) {
    const said = await must(tools.ffmpeg, [
      "-loglevel", "error", "-i", input, "-vn",
      "-af", `aresample=8000,asetnsamples=n=${8000 / MOTION_RATE}:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-`,
      "-f", "null", "-",
    ], { timeout: 10 * 60_000 }).catch(() => "");
    sound = levelsIn(said);
    if (!sound.length) sound = null;
  }
  // the same in the band of a voice (300–3400 Hz, twice filtered): where people speak, for the music's ducking (duck.ts)
  let speech: number[] | null = null;
  if (sound) {
    const said = await must(tools.ffmpeg, [
      "-loglevel", "error", "-i", input, "-vn",
      "-af", `highpass=f=300,highpass=f=300,lowpass=f=3400,lowpass=f=3400,aresample=8000,asetnsamples=n=${8000 / MOTION_RATE}:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-`,
      "-f", "null", "-",
    ], { timeout: 10 * 60_000 }).catch(() => "");
    const levels = levelsIn(said);
    speech = levels.length ? levels : null;
  }
  return { motion, sound, speech };
}

/**
 * Where a clip's motion dies before its end: the moment the frozen tail begins, or null when the clip
 * moves to the last. Over the part that plays (startMs to endMs) of a motion curve at `rate` samples a
 * second: a tail is frozen when its samples stay under a fifth of the clip's median motion (and under a
 * floor, for a clip that is calm throughout), for a quarter second or more, and for no more than a third
 * of the part. H3 often reaches its last frame early and holds it; a continuation handed that still
 * moment inherits the stillness and then lurches, so it is handed the last lively one instead.
 */
export function frozenTailAt(values: number[], rate: number, startMs: number, endMs: number): number | null {
  const a = Math.max(0, Math.floor((startMs / 1000) * rate));
  const b = Math.min(values.length, Math.ceil((endMs / 1000) * rate));
  const part = values.slice(a, b);
  if (part.length < rate) return null;
  const sorted = [...part].sort((p, q) => p - q);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const still = Math.max(0.3, median * 0.2);
  let n = 0;
  while (n < part.length && part[part.length - 1 - n]! < still) n++;
  const stillMs = (n / rate) * 1000;
  if (stillMs < 250 || stillMs > (endMs - startMs) / 3) return null;
  return Math.round(endMs - stillMs);
}

/** The moments ffmpeg's scene filter prints, from its showinfo lines ("pts_time:12.345"). */
export function parseSceneTimes(log: string): number[] {
  const out: number[] = [];
  for (const m of log.matchAll(/pts_time:\s*([0-9.]+)/g)) {
    const ms = Math.round(Number(m[1]) * 1000);
    if (Number.isFinite(ms) && ms > 0 && (out.length === 0 || ms - out[out.length - 1]! >= 400)) out.push(ms);
  }
  return out;
}

/**
 * Where a video cuts from one shot to the next: ffmpeg's scene-change score over `threshold` (0.3 is
 * its usual value: hard cuts, not pans), each as a moment in milliseconds. A video of one shot gives []. A run in the
 * ffmpeg pool: every frame is decoded (a 5-minute 1080p source: 6–11 s).
 */
export async function scenesOf(source: Media, ext: string, threshold = 0.3): Promise<number[]> {
  return ffmpegPool(() => inTemp(async (dir) => {
    const file = await onDisk(dir, `in.${ext}`, source);
    // only a run that went to the end is an answer: what one killed, cut short or failed printed is kept for good by
    // the caller (TimelineMedia.scenes), and read as "no scene cuts" it hid the video's cuts until the file changed
    const ran = await ffRun(tools.ffmpeg, ["-hide_banner", "-i", file, "-vf", `select='gt(scene,${threshold})',showinfo`, "-an", "-f", "null", "-"], { timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
    if (ran.err) throw failureOf(ran.err, ran.stderr, 600_000);
    return parseSceneTimes(ran.stderr);
  }));
}
