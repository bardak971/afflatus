import { FRAME_SLACK_MS } from "@afflatus/core";
import { tools } from "./video";
import { ffRun, fpsMode, inTemp, type Media, onDisk } from "./cut";

/**
 * How much the picture jumps at a join, from small grey frames read in one ffmpeg run (grayFrames): across a join as it
 * plays, cut or faded (joinJump), and where a continuation's run-up ends and its own frames begin (runUpBreak).
 */

/**
 * The least motion a jump is weighed against, in grey levels a pixel on the 96 × 54 frames: a near-still shot divided a
 * jump by almost nothing. At 0.6, Timeline 7's locked-off join (a step of 1.6 at the cut, half of it the two files' own
 * decoding of the same moment, invisible) read ×4 and was flagged; the joins that show step 7 to 43 (2026-10-21).
 */
export const LEAST_MOTION = 1.5;

/**
 * Where a clip's last frame is read, for a join after it: a frame and a half before its end. A frame is read at the first
 * timestamp at or after the moment asked, and 20 ms before the end fell past the last frame of a file at 32 or 48 frames a
 * second: the read fell back 100 ms, and the jump was measured from a frame two or three before the cut (a SCAIL-2 join
 * moving as its clips do read ×3.2, one of Timeline 24 ×5 for ×2.7; 2026-10-21).
 */
export const lastFrameAt = (endMs: number, fps: number | null | undefined) => endMs - 1500 / Math.max(1, fps ?? 24);

/** The side of a grey frame as the joins compare them: 96 × 54. */
const GRAY = 96 * 54;

/**
 * Frames of a video as 96 × 54 grey pixels: for each moment asked, the frame a seek there lands on (the first whose
 * timestamp is at or after it, the moment taken to the millisecond as `-ss` is given it), or null when there is none
 * (past the end, or a file ffmpeg cannot read). One ffmpeg run reads every frame between the first moment and the last:
 * a run per frame cost ~100 ms each, 34 of them for one join measured with a fade.
 */
async function grayFrames(file: string, moments: number[]): Promise<Array<Uint8Array | null>> {
  if (!moments.length) return [];
  // as `-ss` reads a moment: seconds to three places, then microseconds
  const us = moments.map((ms) => Math.round(Number((Math.max(0, ms) / 1000).toFixed(3)) * 1e6));
  const from = Math.min(...us);
  // a little past the last moment, so that the frame a seek there lands on is in the run when the video has it
  const span = (Math.max(...us) - from) / 1e6 + 0.25;
  // each frame once, as decoded: at a constant rate the raw output would repeat the first to fill the moments before it
  const asIs = await fpsMode("passthrough");
  const ran = await ffRun(tools.ffmpeg, ["-hide_banner", "-nostats", "-loglevel", "info", "-ss", (from / 1e6).toFixed(6), "-t", span.toFixed(6), "-i", file, "-an", "-vf", "showinfo,scale=96:54,format=gray", ...asIs, "-f", "rawvideo", "-"],
    { encoding: "buffer", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  if (ran.err) return moments.map(() => null);
  const run = { out: ran.stdout, log: ran.stderr };
  // each frame's timestamp after the seek (counted from the seek's own moment), in the stream's time base
  const base = /time_base:\s*(\d+)\/(\d+)/.exec(run.log);
  const num = Number(base?.[1] ?? 1);
  const den = Number(base?.[2] ?? 1e6);
  const tb = (micro: number) => Math.round((micro * den) / (num * 1e6));
  const pts = [...run.log.matchAll(/\bn:\s*\d+\s+pts:\s*(-?\d+)/g)].map((m) => Number(m[1])).slice(0, Math.floor(run.out.length / GRAY));
  return us.map((u) => {
    // a seek to `u` keeps the frames at or after it: in this run, those at or after `u - from`
    const at = tb(u) - tb(from);
    const k = pts.findIndex((p) => p >= at);
    return k < 0 ? null : new Uint8Array(run.out.subarray(k * GRAY, (k + 1) * GRAY));
  });
}

const meanDiff = (a: Uint8Array, b: Uint8Array) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / a.length;
};

/**
 * How much the picture jumps across a join: the largest step from frame to frame as the join plays, against the
 * difference between neighbouring frames just after it (×1 = the join moves like the clip itself, ×3 = a visible
 * catch). A hard cut is one step, the last frame of one side to the first of the other. With a fade (the export's
 * and the player's) the steps are those of the fade, worked out from the frames 24 a second: "hold", the clip before
 * held on its last frame while this one fades in from its start; "overlap", both moving over the moments before
 * `b.atMs` (b starts `ms` early). Measured as a cut, every faded join read ×5 to ×9 (2026-10-08). null when a frame
 * cannot be read. Each side's frames are read in one run (grayFrames).
 */
export async function joinJump(
  a: { source: Media; ext: string; atMs: number },
  b: { source: Media; ext: string; atMs: number; fps: number },
  fade?: { ms: number; mode: "hold" | "overlap" } | null,
): Promise<number | null> {
  return inTemp(async (dir) => {
    const fa = await onDisk(dir, `a.${a.ext}`, a.source);
    const fb = await onDisk(dir, `b.${b.ext}`, b.source);
    const step = 1000 / Math.max(1, b.fps);
    const model = 1000 / 24;
    const faded = fade && fade.ms >= 80 ? fade : null;
    const n = faded ? Math.max(2, Math.round(faded.ms / model)) : 0;
    const overlap = faded?.mode === "overlap";
    // every moment either side is read at, asked of one run per side
    const aAt = [a.atMs, a.atMs - 100, a.atMs - 250, ...(faded && overlap ? Array.from({ length: n + 1 }, (_, j) => a.atMs - faded.ms + (j - 1) * model) : [])];
    const bAt = [
      b.atMs, b.atMs + FRAME_SLACK_MS, ...Array.from({ length: 4 }, (_, k) => b.atMs + k * step),
      ...(faded && !overlap ? Array.from({ length: n + 1 }, (_, k) => b.atMs + k * model) : []),
      ...(faded && overlap ? Array.from({ length: n + 1 }, (_, j) => b.atMs - faded.ms + (j - 1) * model) : []),
    ];
    const [ga, gb] = await Promise.all([grayFrames(fa, aAt), grayFrames(fb, bAt)]);
    const ofA = (ms: number) => ga[aAt.indexOf(ms)] ?? null;
    const ofB = (ms: number) => gb[bAt.indexOf(ms)] ?? null;
    // the last frame a length promises is not always there: a little earlier then
    const last = ofA(a.atMs) ?? ofA(a.atMs - 100) ?? ofA(a.atMs - 250);
    const first = ofB(b.atMs) ?? ofB(b.atMs + FRAME_SLACK_MS);
    if (!last || !first) return null;
    const own: number[] = [];
    for (let k = 0; k < 3; k++) {
      const x = ofB(b.atMs + k * step);
      const y = ofB(b.atMs + (k + 1) * step);
      if (x && y) own.push(meanDiff(x, y));
    }
    const typical = Math.max(LEAST_MOTION, own.length ? own.reduce((s, v) => s + v, 0) / own.length : LEAST_MOTION);
    if (!faded) return Math.round(Math.min(20, meanDiff(last, first) / typical) * 10) / 10;
    // the fade, a model frame at a time: each frame a mix of the two sides, the second weighing more and more
    const mix = (x: Uint8Array, y: Uint8Array, w: number) => { const out = new Uint8Array(x.length); for (let i = 0; i < x.length; i++) out[i] = Math.round((1 - w) * x[i]! + w * y[i]!); return out; };
    const seq: Uint8Array[] = [];
    if (faded.mode === "hold") {
      seq.push(last);
      for (let k = 0; k < n; k++) {
        const y = ofB(b.atMs + k * model);
        if (y) seq.push(mix(last, y, (k + 1) / (n + 1)));
      }
      const after = ofB(b.atMs + n * model);
      if (after) seq.push(after);
    } else {
      for (let k = -1; k < n; k++) {
        const x = ofA(a.atMs - faded.ms + k * model);
        const y = ofB(b.atMs - faded.ms + k * model);
        if (x && y) seq.push(k < 0 ? x : mix(x, y, (k + 1) / (n + 1)));
      }
      seq.push(first);
    }
    let worst = 0;
    for (let k = 1; k < seq.length; k++) worst = Math.max(worst, meanDiff(seq[k - 1]!, seq[k]!));
    // read 24 a second: against the clip's own step at that rate
    return Math.round(Math.min(20, worst / Math.max(LEAST_MOTION, typical * (model / step))) * 10) / 10;
  });
}

/**
 * How much a continuation's picture jumps where its run-up (the frames regenerated from the clip before) ends
 * and its own frames begin: the difference across that one frame step, against the difference between the
 * frame steps right after (×1 = it carries on, ×3 = a visible catch, ×6 and past = a different shot). The
 * steps are the model's own, 24 a second: an interpolated file's in-between frames are stepped over, and each
 * seek lands a few milliseconds early so that a rounded `headMs` still picks the frame meant. null when a
 * frame cannot be read. The frames are read in one run (grayFrames).
 */
export async function runUpBreak(bytes: Media, ext: string, headMs: number): Promise<number | null> {
  return inTemp(async (dir) => {
    const file = await onDisk(dir, `in.${ext}`, bytes);
    const step = 1000 / 24;
    const ks = [-1, 0, 1, 2, 3];
    const frames = await grayFrames(file, ks.map((k) => headMs + k * step - 5));
    const at = (k: number) => frames[ks.indexOf(k)] ?? null;
    const before = at(-1);
    const first = at(0);
    if (!before || !first) return null;
    const own: number[] = [];
    for (let k = 0; k < 3; k++) {
      const x = at(k);
      const y = at(k + 1);
      if (x && y) own.push(meanDiff(x, y));
    }
    const typical = Math.max(LEAST_MOTION, own.length ? own.reduce((s, v) => s + v, 0) / own.length : LEAST_MOTION);
    return Math.round(Math.min(20, meanDiff(before, first) / typical) * 10) / 10;
  });
}

/** How long after a continuation's run-up a hard cut is looked for (runUpCut): a second of its own frames. */
export const RUN_UP_CUT_WITHIN = 24;

/** A frame step a hard cut is: under this PSNR (dB, grey 96 × 54), and RUN_UP_CUT_DROP under both the steps around it. */
const CUT_DB = 17;
const RUN_UP_CUT_DROP = 6;

/**
 * The first hard cut in a continuation's first second of its own frames, if there is one: where H3 leaves the clip
 * before for another shot after its run-up (card #161), at the first new frame (as runUpBreak sees it) or a few frames
 * later (Oct 27, 10 and 13 frames on, which runUpBreak read ×0.5). A cut is a step between two model frames (24 a second)
 * under 17 dB PSNR that is at least 6 dB under the steps before and after it: on 8721's 103 H3 joins it found the 9 cuts
 * seen in their frames and nothing else, where a step weighed against the motion around it mixed cuts and quick moves
 * between ×3 and ×7. `atMs`: after the run-up's end; `db`: the step's PSNR. null: none; undefined: a frame could not be read.
 */
export async function runUpCut(bytes: Media, ext: string, headMs: number): Promise<{ atMs: number; db: number } | null | undefined> {
  return inTemp(async (dir) => {
    const file = await onDisk(dir, `in.${ext}`, bytes);
    const step = 1000 / 24;
    // the two run-up frames before the first new one (the steps before it), and one past the last step weighed
    const ks = Array.from({ length: RUN_UP_CUT_WITHIN + 4 }, (_, j) => j - 2);
    const frames = await grayFrames(file, ks.map((k) => headMs + k * step - 5));
    if (frames.slice(0, 4).some((f) => !f)) return undefined;
    const psnr = (a: Uint8Array, b: Uint8Array) => {
      let sum = 0;
      for (let i = 0; i < a.length; i++) sum += (a[i]! - b[i]!) ** 2;
      return sum === 0 ? 99 : 10 * Math.log10((255 * 255) / (sum / a.length));
    };
    // into[j]: the step into frame ks[j] from the one before it
    const into = frames.map((f, j) => (j && f && frames[j - 1] ? psnr(frames[j - 1]!, f) : null));
    for (let j = 2; j < into.length - 1; j++) {
      const [before, at, after] = [into[j - 1], into[j], into[j + 1]];
      if (at == null || before == null || after == null) continue;
      if (at < CUT_DB && at < before - RUN_UP_CUT_DROP && at < after - RUN_UP_CUT_DROP) return { atMs: Math.round(ks[j]! * step), db: Math.round(at * 10) / 10 };
    }
    return null;
  });
}
