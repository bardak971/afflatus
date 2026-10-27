import { readFile, writeFile } from "node:fs/promises";
import { FRAME_SLACK_MS, JOIN_FADE_MS, musicGainAt, type MusicPlan } from "@afflatus/core";
import { gainWav, type DuckCurve } from "./duck";
import { join } from "node:path";
import { graphFileOption, tools } from "./video";
import { aiVideoArgs } from "./aiMark";
import { CutError, fpsMode, inTemp, type Media, must, onDisk, sec } from "./cut";
import { colourNudge, type FrameMeans, MATCH, type Means, meansOf, meansWithin } from "./measure";

/**
 * A timeline as one file (cut.ts runs ffmpeg): its parts joined with their blends, holds, freezes and transitions,
 * colour-matched at the joins, with their sound and the music under them (ducked where people speak), whole or in pieces.
 */

/** One thing that plays in an export: a part of a video, or a picture held for a while. */
export interface ExportPart {
  kind: "video" | "still";
  source: Media;
  ext: string;
  /** The part of a video that plays, in milliseconds. For a picture: 0 and how long it is held. */
  startMs: number;
  endMs: number;
  /** Whether the video has a sound of its own. */
  hasSound: boolean;
  /** Its video's own frames a second, when known: its sound is then cut on its picture's frames (framesOf). */
  fps?: number;
  /** What is heard: the video's own sound, nothing, or a sound file (cut or padded to the part's length). */
  sound: "own" | "muted" | "file";
  soundFile?: { source: Media; ext: string };
  /** 0 to 1. */
  volume: number;
  /** Of another shape than the frame: true = fills it (edges cut), false = shown whole, with bars. */
  fill: boolean;
  /** This part fades in over the part before over this many milliseconds (see blendMode). */
  blendMs?: number;
  /** Where in its video the colour match reads this part: the frames that show the same moments as the part before's end, when it has them (a continuation's shared frames). Left out: its first frames after the fade. */
  matchAtMs?: number;
  /** Not colour-matched to the part before (it went through another enlargement: its colour differs for that, not for the light). */
  noMatch?: boolean;
  /** Decoded as one piece with the part before: not matched, given the part before's own nudge (no step where there is none). */
  sameLook?: boolean;
  /**
   * The part before's last this many ms are heard from this part's head (the same moments, decoded with it): the sound hands
   * over before the silence a take that carries on ends on (core soundHandover). Both parts' own sound.
   */
  headSoundMs?: number;
  /**
   * Its take's own sound stops short of its frames at `fromMs` (its video's time) and the part after does not carry on: the
   * rest is its recording itself from `songS` (seconds into it), at the take's level there (`gainDb`), not silence
   * (Timelines.soundFillFor, timelineSoundFill.ts). Never on a part whose sound hands over to the part after.
   */
  soundFill?: { source: Media; ext: string; fromMs: number; songS: number; gainDb: number };
  /** Its video's frame means as kept beside it (TimelineMedia.means): the colour match reads them rather than measure the file again. */
  means?: FrameMeans | null;
  /**
   * "hold": the part before holds its last frame for as long, this one fades in after it (nothing of either is lost).
   * "overlap": this part starts `blendMs` early, over the same moments as the part before's end, and the two are faded
   * with both moving. "freeze": the picture as "hold", the sound straight on, no crossfade (a continuation made in the
   * latent carries the sound of the clip before: a fade would only dip it).
   */
  blendMode?: "hold" | "overlap" | "freeze";
  /**
   * A cut's transition into this part, centred on the cut (core transitions.ts): the part before is held on its last frame
   * for half of it, this one on its first frame for the other half, and xfade runs over both halves, so nothing moves on
   * the clock. Its sound runs straight on, or fades out and in over the halves.
   */
  transitionIn?: { kind: string; xfade: string; ms: number; fadeSound: boolean };
}

/**
 * Flash, as xfade's custom expression: the cut at the middle, a white added over it that peaks there (P runs from 1 to 0).
 * Luma rises, the colour planes go towards grey with it (as a picture blown out to white loses its colour), the same as the
 * player's white veil added on top (plus-lighter).
 */
export const FLASH_EXPR = "st(0,1-abs(2*P-1));st(1,if(gt(P,0.5),A,B));if(eq(PLANE,0),min(235,ld(1)+220*ld(0)),ld(1)+(128-ld(1))*0.8*ld(0))";

/** How long a continuation fades in over the clip before, which holds its last frame meanwhile: four frames at 24 a second. */
export const BLEND_MS = JOIN_FADE_MS;
/**
 * How long a continuation made in the latent fades in over the clip before, which holds its last frame meanwhile. The clip
 * before plays to its very last frame and the continuation from its first own one: its guided frames are a loose copy of
 * the clip before's (the model redraws them, 3.9 against 0.8 of motion a frame in a calm shot) and its frames next to its
 * guide step (×2.5 the motion, exact latent or hybrid alike). Simulated on three joins, measured 2026-10-08: the old fade
 * over the shared frames before a take-over point peaked at ×2.9 the motion; this one from the clip before's end at ×1.6
 * over 170 ms, ×1.2 over 420 ms. 420 ms doubled a moving subject for a fifth of a second (a kite against the sky, the held
 * frame under the moving one, seen in a non-turbo export): 170 ms keeps that ghost to a couple of frames.
 */
export const DISSOLVE_MS = JOIN_FADE_MS;

export interface ExportMusic {
  source: Media;
  ext: string;
  /** Where it starts and stops on the video's clock, the part of the song, its level under each clip (@afflatus/core's musicPlan). */
  plan: MusicPlan;
  /** Quieter where people speak in the clips: the music multiplied by this curve (duck.ts), the same the player follows. */
  duck: DuckCurve | null;
}

/** What joinVideosInto is asked besides its parts. */
export interface JoinOptions {
  scale?: number;
  music?: ExportMusic;
  /** Make it this many pictures a second by working out the pictures in between (slow, done on the processor). */
  smoothTo?: number;
  /** Nudge each video part's brightness and tint to the part before it at the join (means over the last and first moments). */
  match?: boolean;
  /** A copy to share on the web: at most this many megabytes, its long edge at most 1280 and 30 pictures a second (webCut). */
  webMb?: number;
  /** It holds a render: marked as made by a model (aiMark.ts). */
  fromRender?: boolean;
  signal?: AbortSignal;
}

/** The long edge and the speed of a copy for the web: what a README, a post or a chat plays inline without waiting. */
const WEB_EDGE = 1280;
const WEB_FPS = 30;

/**
 * A copy for the web: the frame brought down to WEB_EDGE on its long side (never up), and the bitrate that keeps the
 * whole file under `mb` megabytes for its length, the sound taken out of the budget first. A little is kept in hand:
 * one pass of x264 at a mean bitrate lands within a few percent of it.
 */
export function webCut(frame: { width: number; height: number }, totalMs: number, mb: number): { W: number; H: number; videoKbps: number; audioKbps: number } {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const k = Math.min(1, WEB_EDGE / Math.max(frame.width, frame.height));
  const audioKbps = 128;
  const seconds = Math.max(1, totalMs / 1000);
  const videoKbps = Math.max(300, Math.floor((mb * 8 * 1000 * 0.92) / seconds - audioKbps));
  return { W: even(frame.width * k), H: even(frame.height * k), videoKbps, audioKbps };
}

/**
 * Clips and pictures played one after the other, as one MP4: each cut to the part that plays, fitted
 * into the frame, brought to one speed; what has no sound is silent for its length; music, when there is
 * some, lies under all of it. `scale` enlarges every frame at the end (nothing is rendered again). The joined file is
 * handed to `use` where it lies, before it is cleared away: stored from there, it is never held whole in memory.
 */
export async function joinVideosInto<T>(parts: ExportPart[], frame: { width: number; height: number }, fps: number, opts: JoinOptions, use: (file: string) => Promise<T>): Promise<T> {
  if (!parts.length) throw new CutError("There is nothing to export yet.");
  // a copy for the web is never enlarged, and is made at the web's size from the start (the parts are fitted to it)
  const scale = opts.webMb ? 1 : opts.scale ?? 1;
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const lengthMs = parts.reduce((sum, p) => sum + (p.endMs - p.startMs), 0);
  const web = opts.webMb ? webCut(frame, lengthMs, opts.webMb) : null;
  const size = web ? { W: web.W, H: web.H } : { W: even(frame.width * scale), H: even(frame.height * scale) };
  // enlarged frames are sharpened a little: scaling alone leaves them soft
  const smooth = !web && opts.smoothTo && opts.smoothTo > fps ? `minterpolate=fps=${opts.smoothTo}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1` : "";
  // the web's speed: pictures dropped evenly, never made up
  const slower = web && fps > WEB_FPS ? `fps=${WEB_FPS}` : "";
  const post = [smooth, slower, scale > 1 ? "unsharp=5:5:0.6:5:5:0" : ""].filter(Boolean);
  const finish = `[joined]${post.join(",") || "null"}[v]`;
  const videoCodec = [
    ...(web
      // a size to keep: a mean bitrate, capped so no stretch overshoots it, and the slower preset for more picture per byte
      ? ["-c:v", "libx264", "-preset", "slow", "-b:v", `${web.videoKbps}k`, "-maxrate", `${Math.round(web.videoKbps * 1.5)}k`, "-bufsize", `${web.videoKbps * 2}k`, "-pix_fmt", "yuv420p"]
      : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p"]),
    // each frame at its own moment on the frame grid, none repeated to fill a gap: a run whose sound ends past its picture
    // leaves less than a frame before the next run. Left to itself, ffmpeg 6 repeated the next run's first frame into it on
    // the whole timeline, where a piece ends with nothing after it to repeat (2 frames short in 458); ffmpeg 7 and later
    // do not repeat it. Said, every version makes the same frames in pieces as whole
    ...(await fpsMode("vfr")),
  ];
  const audioCodec = ["-c:a", "aac", "-b:a", web ? `${web.audioKbps}k` : "192k"];
  const ends = [...(opts.fromRender ? aiVideoArgs : []), "-movflags", "+faststart"];
  const run = { timeout: 3 * 60 * 60_000, signal: opts.signal };
  const music = opts.music;
  return inTemp(async (dir) => {
    // every part's file on disk first: a colour match reads the part before's, which may lie in the piece before
    const files = await Promise.all(parts.map((p, i) => onDisk(dir, `part${i}.${p.ext}`, p.source)));
    const looks = await colourLooks(parts, files, Boolean(opts.match));
    const pieces = cutLongRuns(parts, piecesOf(parts, runsOf(parts)), fps);
    const out = join(dir, "export.mp4");
    if (pieces.length === 1) {
      const inputs = new Inputs(dir);
      const chains = await partChains(parts, files, pieces[0]!.flatMap((s) => s.parts), inputs, size, fps, looks);
      const { outs, total } = fadeRuns(parts, pieces[0]!, fps, chains);
      chains.push(`${outs.join("")}concat=n=${outs.length}:v=1:a=1[joined][${music ? "voices" : "a"}]`, finish);
      if (music) {
        const track = await inputs.add(`music.${music.ext}`, music.source);
        chains.push(...musicChain(music.plan, track, await inputs.add("gain.wav", musicGainWav(music, total))));
      }
      await must(tools.ffmpeg, [
        "-y", "-loglevel", "error", ...inputs.args, ...(await graphFile(dir, "graph.txt", chains)), "-map", "[v]", "-map", "[a]", ...videoCodec, ...audioCodec, ...ends, out,
      ], run);
      return use(out);
    }
    // A long timeline is made in pieces, one ffmpeg run each, cut where no fade or transition crosses (between runs, or
    // inside a part of a long run, cutLongRuns): ffmpeg opens every input of a run at once and holds tens of megabytes for
    // each, so its memory is a piece's, not the whole timeline's.
    // Each piece's picture is encoded as the whole would be and its sound kept exact (32-bit float, as the encoder is
    // handed it); the pieces are put end to end by the concat demuxer, the picture copied as it is and the sound encoded
    // once with the music under it. A piece ends where its concat filter ends it (its sound padded to its picture, as
    // between runs), and the next starts there, as on the whole timeline's clock. Made at another speed (smoothed, or the
    // web's), the pictures are worked out across the joins of the pieces too: the pieces are then kept lossless and the
    // speed changed and encoded once, over all of them.
    const regrid = Boolean(smooth || slower);
    let total = 0;
    let clock = 0;
    /** Where the whole timeline's concat filter would end the picture: see `ending` below. */
    let ending = 0;
    const list: string[] = [];
    for (const [k, piece] of pieces.entries()) {
      const inputs = new Inputs(dir);
      const chains = await partChains(parts, files, piece.flatMap((s) => s.parts), inputs, size, fps, looks);
      const { outs, total: length } = fadeRuns(parts, piece, fps, chains);
      total += length;
      // the concat filter pads a run's sound with silence to its picture's end only when another run follows: a piece but
      // the last is followed by an empty one, so that its sound ends where the whole timeline's would. Not a piece that ends
      // inside a run (cutLongRuns): its picture and sound end on the same moment, and the run goes on there in the whole
      // timeline, unpadded (the empty run padded it by a sample)
      if (k < pieces.length - 1 && !piece.at(-1)!.to) {
        chains.push(`nullsrc=s=${size.W}x${size.H}:r=${fps},format=yuv420p,setsar=1,trim=end_frame=0[vend]`, "anullsrc=channel_layout=stereo:sample_rate=48000,atrim=end_sample=0[aend]");
        outs.push("[vend][aend]");
      }
      chains.push(`${outs.join("")}concat=n=${outs.length}:v=1:a=1[joined][a]`, regrid ? "[joined]null[v]" : finish);
      const file = join(dir, `piece${k}.mov`);
      // kept lossless for the speed change, each picture at its moment to the microsecond, as the whole timeline's concat
      // filter hands them on (not moved onto the frame grid: the speed change picks its frames by those moments)
      const keep = ["-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", "-pix_fmt", "yuv420p", ...(await fpsMode("passthrough")), "-enc_time_base:v", "1:1000000"];
      const codec = regrid ? keep : videoCodec;
      await must(tools.ffmpeg, [
        "-y", "-loglevel", "error", ...inputs.args, ...(await graphFile(dir, `graph${k}.txt`, chains)), "-map", "[v]", "-map", "[a]", ...codec, "-c:a", "pcm_f32le", file,
      ], run);
      // where the next piece starts: the end of its longest stream, exact (the file's own duration is in milliseconds)
      const said = await must(tools.ffprobe, ["-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "csv=p=0", file]);
      const lengths = new Map(said.split(/\r?\n/).filter(Boolean).map((l) => [l.split(",")[0], Number(l.split(",")[1])] as const));
      const longest = Math.max(lengths.get("video") ?? 0, lengths.get("audio") ?? 0);
      ending = clock + Math.max((lengths.get("video") ?? 0) - 1 / fps, lengths.get("audio") ?? 0);
      clock += longest;
      list.push(`file '${file.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`, `duration ${longest.toFixed(6)}`);
    }
    await writeFile(join(dir, "pieces.txt"), list.join("\n") + "\n");
    const inputs = new Inputs(dir);
    await inputs.add("pieces.txt", join(dir, "pieces.txt"), ["-f", "concat", "-safe", "0"]);
    // the web's speed: on the whole timeline the speed change gives a frame for every moment before where the concat
    // filter ends the picture, its last frame's moment or the sound's end when that runs a little past (measured: not the
    // last frame's end). Here the last frame is held a frame longer and the frames counted off there. Smoothing goes by
    // the frames alone
    const counted = slower ? ["tpad=stop=1:stop_mode=clone", ...post, `trim=end_frame=${Math.round(ending * WEB_FPS)}`] : post;
    const chains: string[] = regrid ? [`[0:v]${["settb=AVTB", ...counted].join(",")}[v]`] : [];
    if (music) {
      // the sound read from the list opened a second time: from the same opening as the copied picture, ffmpeg 6 ended the
      // mix where that input ended and lost the sound's last packet (13 ms short)
      const voices = await inputs.add("pieces.txt", join(dir, "pieces.txt"), ["-f", "concat", "-safe", "0"]);
      const track = await inputs.add(`music.${music.ext}`, music.source);
      chains.push(`[${voices.index}:a]anull[voices]`, ...musicChain(music.plan, track, await inputs.add("gain.wav", musicGainWav(music, total))));
    }
    const picture = regrid
      ? ["-map", "[v]", ...videoCodec]
      // the picture put back on its frame grid where a piece starts between two frames (its sound ran on past its
      // picture): the encoder of the whole timeline rounds to the nearest frame there, the same
      : ["-map", "0:v", "-c:v", "copy", "-bsf:v", `setts=pts=round(PTS*TB*${fps})/(TB*${fps}):dts=round(DTS*TB*${fps})/(TB*${fps})`];
    await must(tools.ffmpeg, [
      "-y", "-loglevel", "error", ...inputs.args, ...(chains.length ? ["-filter_complex", chains.join(";")] : []),
      ...picture, "-map", music ? "[a]" : "0:a", ...audioCodec, ...ends, out,
    ], run);
    return use(out);
  });
}

/**
 * The parts of a timeline longer than this are made in pieces of about as many (piecesOf), each piece its own ffmpeg run.
 * Settable for the tests, which make pieces of a few parts.
 */
export const EXPORT_PIECE = { parts: 8 };

/** The parts that fade into each other (a blend or a transition), as runs of their numbers, in order: a run is made as one. */
export function runsOf(parts: ExportPart[]): number[][] {
  const runs: number[][] = [];
  parts.forEach((p, i) => {
    if (i > 0 && ((p.blendMs && p.blendMs > 0) || p.transitionIn)) runs.at(-1)!.push(i);
    else runs.push([i]);
  });
  return runs;
}

/** Whole runs gathered into pieces of at least EXPORT_PIECE.parts parts (the last one may be shorter; a longer run ends its piece, and is cut by cutLongRuns). One piece when the timeline is that short. */
export function piecesOf(parts: ExportPart[], runs: number[][]): number[][][] {
  if (parts.length <= EXPORT_PIECE.parts) return [runs];
  const pieces: number[][][] = [[]];
  let count = 0;
  for (const run of runs) {
    if (count >= EXPORT_PIECE.parts) {
      pieces.push([]);
      count = 0;
    }
    pieces.at(-1)!.push(run);
    count += run.length;
  }
  return pieces;
}

/**
 * The filter graph handed to ffmpeg in a file: on the command line it outgrew Windows' 32 767 characters at ~48 clips
 * with transitions (spawn ENAMETOOLONG). The option that reads it depends on the version (graphFileOption).
 */
async function graphFile(dir: string, name: string, chains: string[]): Promise<string[]> {
  const file = join(dir, name);
  await writeFile(file, chains.join(";"));
  return [await graphFileOption(), file];
}

const STEREO = "aresample=48000,aformat=channel_layouts=stereo";

/** The files an ffmpeg run reads, in order: each added is read where it lies, or written into `dir` first (its bytes). */
class Inputs {
  readonly args: string[] = [];
  private n = 0;
  constructor(private readonly dir: string) {}
  /** The input's number and the file it is read from. */
  async add(name: string, source: Media, before: string[] = []): Promise<{ index: number; file: string }> {
    const file = await onDisk(this.dir, name, source);
    this.args.push(...before, "-i", file);
    return { index: this.n++, file };
  }
}

/**
 * Each part's colour nudge, a `lutyuv` to add to its picture's chain (empty when none): colour matching carries along, a
 * part matched to the part before as it will look, nudge included. The means at every join are read at once and the carry
 * worked out in order after. A part's means are read off its video's kept frame means (`means`, worked out once per video
 * and kept beside it); only without them is the file measured there (meansOf, two ffmpeg runs a join, through the pool).
 */
async function colourLooks(parts: ExportPart[], files: string[], match: boolean): Promise<string[]> {
  type Tune = { kind: "same" } | { kind: "match"; means: Promise<[Means | null, Means | null]> } | { kind: "reset" };
  const look = MATCH.lookSec;
  const at = (i: number, fromMs: number): Promise<Means | null> => {
    const kept = parts[i]!.means ? meansWithin(parts[i]!.means!, fromMs, look) : null;
    return kept ? Promise.resolve(kept) : meansOf(files[i]!, fromMs / 1000, look);
  };
  const tunes: Tune[] = parts.map((p, i) => {
    const prev = parts[i - 1];
    if (match && p.sameLook && prev?.kind === "video") return { kind: "same" };
    if (match && p.kind === "video" && !p.noMatch && prev?.kind === "video") {
      const means = Promise.all([at(i - 1, prev.endMs - look * 1000), at(i, p.matchAtMs ?? p.startMs + (p.blendMs ?? 0))]);
      // read later, in order: a failure is caught there (meansOf says none rather than failing)
      means.catch(() => {});
      return { kind: "match", means };
    }
    return { kind: "reset" };
  });
  const lut = (c: Means) => (c.y || c.u || c.v ? `,lutyuv=y='clip(val+(${c.y}),0,255)':u='clip(val+(${c.u}),0,255)':v='clip(val+(${c.v}),0,255)'` : "");
  let carry: Means = { y: 0, u: 0, v: 0 };
  const said: string[] = [];
  for (const [i, t] of tunes.entries()) {
    if (t.kind === "match") {
      const [a, b] = await t.means;
      carry = a && b ? colourNudge(a, b, carry) : { y: 0, u: 0, v: 0 };
    } else if (t.kind === "reset") carry = { y: 0, u: 0, v: 0 };
    said[i] = t.kind === "reset" ? "" : lut(carry);
  }
  return said;
}

/**
 * Each part's picture and sound as a chain of its own (`v<i>`, `a<i>`), for the parts numbered `which` (a piece of the
 * timeline, or all of it): cut to what plays, fitted into the frame, brought to one speed, colour-matched to the part
 * before (`looks`, colourLooks), held at its end when the part after fades in with a hold; its own sound, its sound file,
 * or silence, as long as its picture.
 */
async function partChains(parts: ExportPart[], files: string[], which: number[], inputs: Inputs, size: { W: number; H: number }, fps: number, looks: string[]): Promise<string[]> {
  const { W, H } = size;
  const chains: string[] = [];
  for (const i of which) {
    const p = parts[i]!;
    const length = sec(p.endMs - p.startMs);
    const { index: main } = await inputs.add(`part${i}.${p.ext}`, files[i]!, p.kind === "still" ? ["-loop", "1", "-t", length] : []);
    const fit = p.fill
      ? `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H}`
      : `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`;
    const tune = looks[i] ?? "";
    const { next, padMs, out, into, early } = heldOf(parts, i, fps);
    let { heardMs } = heldOf(parts, i, fps);
    // played straight: its sound on its picture's own frames, as long as they last (framesOf)
    const exact = padMs === 0 && out === 0 && into === 0 && early === 0 ? framesOf(p, fps) : null;
    if (exact) heardMs += exact.toMs - exact.fromMs - (p.endMs - p.startMs);
    const soundFrom = exact?.fromMs ?? p.startMs + early;
    const soundTo = exact?.toMs ?? p.endMs;
    // its times to the microsecond only when cut on its frames: elsewhere as the pieces of a long export count them (runClock)
    const t = exact ? fine : sec;
    const pad = (padMs > 0 ? `,tpad=stop_mode=clone:stop_duration=${sec(padMs)}` : "")
      + (out > 0 || into > 0 ? `,tpad=${[into > 0 ? `start_mode=clone:start_duration=${sec(into)}` : "", out > 0 ? `stop_mode=clone:stop_duration=${sec(out)}` : ""].filter(Boolean).join(":")}` : "");
    const heard = sec(heardMs);
    const fades = [into > 0 && p.transitionIn!.fadeSound ? `afade=t=in:d=${sec(into)}` : "", out > 0 && next!.transitionIn!.fadeSound ? `afade=t=out:st=${sec(heardMs - out)}:d=${sec(out)}` : ""].filter(Boolean).map((f) => `,${f}`).join("");
    chains.push(
      p.kind === "still"
        ? `[${main}:v]fps=${fps},${fit},setsar=1,format=yuv420p,trim=duration=${length},setpts=PTS-STARTPTS${pad}[v${i}]`
        // half a frame early, both ends: the frame on screen at startMs is taken. Cut exactly there, a frame that began a
        // fraction of a millisecond before (a seamless take's in-between frame, 895.8 ms against a 896 ms start) was dropped
        : `[${main}:v]trim=start=${sec(Math.max(0, p.startMs - 500 / fps))}:end=${sec(Math.max(0, p.endMs - 500 / fps))},setpts=PTS-STARTPTS,fps=${fps},${fit},setsar=1,format=yuv420p${tune}${pad}[v${i}]`,
    );
    const loud = `volume=${Math.max(0, p.volume).toFixed(2)}`;
    if (p.sound === "own" && p.kind === "video" && p.hasSound) {
      // a seamless join's sound hands over early (headSoundMs): this part's last moments are heard from the part after's head,
      // in this part's own run of the concat (each run's sound is laid from where its picture starts)
      const hand = next?.kind === "video" && next.headSoundMs ? next.headSoundMs : 0;
      // the head heard up to where the part after's picture starts, on its frames too
      const nextFrom = next ? framesOf(next, fps)?.fromMs ?? next.startMs : 0;
      if (hand > 0) {
        const head = (await inputs.add(`head${i + 1}.${next!.ext}`, files[i + 1]!)).index;
        const own = t(heardMs - hand);
        chains.push(`[${main}:a]atrim=start=${t(soundFrom)}:end=${t(soundTo - hand)},asetpts=PTS-STARTPTS,${STEREO},${loud},apad,atrim=duration=${own}[ao${i}]`);
        chains.push(`[${head}:a]atrim=start=${t(nextFrom - hand)}:end=${t(nextFrom)},asetpts=PTS-STARTPTS,${STEREO},volume=${Math.max(0, next!.volume).toFixed(2)},apad,atrim=duration=${t(hand)}[ah${i}]`);
        chains.push(`[ao${i}][ah${i}]concat=n=2:v=0:a=1,apad,atrim=duration=${t(heardMs)}${fades}[a${i}]`);
      } else if (p.soundFill && p.soundFill.fromMs > soundFrom && p.soundFill.fromMs < soundTo) {
        // its own sound to where it stops, then its recording for the rest, at the take's level: the song goes on to the cut
        const f = p.soundFill;
        const rec = (await inputs.add(`fill${i}.${f.ext}`, f.source)).index;
        chains.push(`[${main}:a]atrim=start=${t(soundFrom)}:end=${t(f.fromMs)},asetpts=PTS-STARTPTS,${STEREO},${loud}[ao${i}]`);
        chains.push(`[${rec}:a]atrim=start=${(f.songS).toFixed(6)}:duration=${t(soundTo - f.fromMs)},asetpts=PTS-STARTPTS,${STEREO},volume=${f.gainDb.toFixed(2)}dB,${loud}[af${i}]`);
        chains.push(`[ao${i}][af${i}]concat=n=2:v=0:a=1,apad,atrim=duration=${t(heardMs)}${fades}[a${i}]`);
      } else chains.push(`[${main}:a]atrim=start=${t(soundFrom)}:end=${t(soundTo)},asetpts=PTS-STARTPTS,${STEREO},${loud},apad,atrim=duration=${t(heardMs)}${fades}[a${i}]`);
    } else if (p.sound === "file" && p.soundFile) {
      const sound = (await inputs.add(`sound${i}.${p.soundFile.ext}`, p.soundFile.source)).index;
      chains.push(`[${sound}:a]${STEREO},${loud},apad,atrim=duration=${heard},asetpts=PTS-STARTPTS${fades}[a${i}]`);
    } else {
      chains.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${heard}[a${i}]`);
    }
  }
  return chains;
}

/** A time for ffmpeg to the microsecond: a frame's start at 48 a second falls between milliseconds (895.833 ms), which `sec` rounds. */
const fine = (ms: number) => (ms / 1000).toFixed(6);

/**
 * Where a part's picture really starts and ends in its video, on its frames: the trim takes the frames from half a frame
 * before its moments (partChains), so it holds whole frames, up to one more or one less than its moments say. Its sound cut
 * to the moments instead, the concat padded the shorter of the two with silence before the part after, and a song carried on
 * across a join dropped out for up to a frame there and came back that much late (6 ms of silence, 7.8 ms late: Timeline
 * 24's export, 2026-10-24). Cut here, sound and picture last the same, and a song runs on from one part into the next. Only
 * a video at the export's own rate, played straight (no hold, no transition, no freeze's early start): null otherwise.
 */
function framesOf(p: ExportPart, fps: number): { fromMs: number; toMs: number } | null {
  if (p.kind !== "video" || !p.fps || Math.abs(p.fps - fps) > 0.01) return null;
  const at = (ms: number) => (Math.ceil((Math.max(0, ms - 500 / fps) * fps) / 1000 - 1e-6) * 1000) / fps;
  return { fromMs: at(p.startMs), toMs: at(p.endMs) };
}

/**
 * How long before its own first moment a part's picture starts: a frame for a freeze (timelineExport starts its part a frame
 * early, and fadeRuns starts its dissolve on the last frame of the part before). Its sound starts at its own first moment.
 */
const earlyOf = (p: ExportPart, fps: number) => (p.blendMode === "freeze" && !p.transitionIn ? 1000 / fps : 0);

/**
 * How a part is held for the parts around it (partChains), and how long its sound is heard: what its chains are made of, and
 * what a run's clock counts (runClock).
 */
function heldOf(parts: ExportPart[], i: number, fps: number) {
  const p = parts[i]!;
  // the part after fades in over this one's end with a hold: this one holds its last frame (and silence) for as long
  const next = parts[i + 1];
  const padMs = next?.blendMs && next.kind === "video" && next.blendMode !== "overlap" ? Math.min(next.blendMs, (next.endMs - next.startMs) - FRAME_SLACK_MS) : 0;
  // a transition on either side: this part held on its last frame for half of the one after, on its first for half of its own
  const out = next?.transitionIn ? next.transitionIn.ms / 2 : 0;
  const into = i > 0 && p.transitionIn ? p.transitionIn.ms / 2 : 0;
  // a freeze's picture starts a frame before its own first moment (fadeRuns): its sound starts at that moment, where the
  // run's sound reaches it. Started with the picture, each latent join put the sound a frame later, piling up along a chain
  const early = earlyOf(p, fps);
  // the sound is not held with the picture when the part after carries it on (see "freeze"), nor over a transition (it
  // runs straight on, its clock the clips'); it fades out and in over the halves when the transition asks
  const heardMs = (next?.blendMode === "freeze" || out > 0 ? p.endMs - p.startMs : p.endMs - p.startMs + padMs) - early;
  return { next, padMs, out, into, early, heardMs };
}

/**
 * Parts that fade into each other, made as one chain of fades: a run (runsOf), or a stretch of a long one (cutLongRuns),
 * which starts or stops (`from`, `to`) at a frame and a sound sample of its run's clock (runClock).
 */
export interface Stretch {
  run: number[];
  parts: number[];
  from?: { frame: number; sample: number };
  to?: { frame: number; sample: number };
}

/** The rate every part's sound is brought to: a run's clock counts its samples. */
const RATE = 48_000;

/**
 * A run laid on its own clock, as fadeRuns joins it, a part at a time (each list by its place in the run): where its fade
 * in starts, as xfade is told it (`offsets`, in seconds) and on the frame xfade puts it on (the nearest, halves up, as ffmpeg
 * rescales a time), and the sample its sound starts at; how many frames and samples the fade takes (`fadeFrames` a little
 * more); and how long the whole run lasts (`ms`).
 */
function runClock(parts: ExportPart[], run: number[], fps: number) {
  const lenOf = (p: ExportPart) => p.endMs - p.startMs;
  const samples = (ms: number) => Math.round(Number(sec(ms)) * RATE);
  const frameOf = (said: string) => Math.floor((2 * Math.round(Number(said) * 1000) * fps + 1000) / 2000);
  const clock = { offsets: [""], frame: [0], sample: [0], fadeFrames: [0], fadeSamples: [0], ms: 0 };
  let len = lenOf(parts[run[0]!]!);
  let heard = samples(heldOf(parts, run[0]!, fps).heardMs);
  for (const j of run.slice(1)) {
    const p = parts[j]!;
    const t = p.transitionIn;
    let offset: number;
    let fadeMs: number;
    // the sound's crossfade, in samples: none where it runs straight on
    let crossed = 0;
    if (t) {
      // centred on the cut: the run so far was held half of it past its end, this part half of it before its start
      // (partChains), so the two meet over the whole transition and the clock runs on as without it
      offset = len - t.ms / 2;
      fadeMs = t.ms;
      len += lenOf(p);
    } else {
      const x = Math.min(p.blendMs!, lenOf(p) - FRAME_SLACK_MS);
      fadeMs = x;
      if (p.blendMode === "overlap") {
        // the part starts x early, over the part before's last x: the fade is between the same moments, both moving
        offset = len - x;
        len = len - x + lenOf(p);
        crossed = samples(x);
      } else {
        // the part before was held for x: the fade runs over that hold, from where the part before really ends. A freeze
        // starts on that last frame itself (begun a frame later, the still showed for 3 frames; the part after starts a
        // frame early to make up for it, see timelineExport)
        const early = earlyOf(p, fps);
        offset = len - early;
        len = len - early + lenOf(p);
        // the sound crossfades over the hold, or (freeze) runs straight on: it was not held
        if (p.blendMode !== "freeze") crossed = samples(x);
      }
    }
    clock.offsets.push(sec(offset));
    clock.frame.push(frameOf(sec(offset)));
    clock.sample.push(heard - crossed);
    clock.fadeFrames.push(Math.ceil((fadeMs * fps) / 1000) + 1);
    clock.fadeSamples.push(crossed);
    heard = heard - crossed + samples(heldOf(parts, j, fps).heardMs);
  }
  clock.ms = len;
  return clock;
}

/**
 * The parts that fade into the one before, crossfaded in runs (runsOf; added to `chains`), or in stretches of runs
 * (cutLongRuns); each one's picture and sound out (`outs`, to be put one after the other), and how long all of it lasts.
 */
function fadeRuns(parts: ExportPart[], stretches: Stretch[], fps: number, chains: string[]): { outs: string[]; total: number } {
  const lenOf = (p: ExportPart) => p.endMs - p.startMs;
  const outs: string[] = [];
  let total = 0;
  for (const s of stretches) {
    const clock = runClock(parts, s.run, fps);
    const head = s.parts[0]!;
    // a stretch from inside its run is laid from its first part's frame and sample: each fade after it on the same frame of
    // the run as when the run is made whole, said on the frame grid
    const base = s.from ? s.run.indexOf(head) : 0;
    const offset = (k: number) => (s.from ? sec(((clock.frame[k]! - clock.frame[base]!) * 1000) / fps) : clock.offsets[k]!);
    let v = `v${head}`;
    let a = `a${head}`;
    for (const j of s.parts.slice(1)) {
      const k = s.run.indexOf(j);
      const t = parts[j]!.transitionIn;
      if (t) {
        const kind = t.xfade === "custom" ? `custom:expr='${FLASH_EXPR}'` : t.xfade;
        chains.push(`[${v}][v${j}]xfade=transition=${kind}:duration=${sec(t.ms)}:offset=${offset(k)}[vx${j}]`);
        chains.push(`[${a}][a${j}]concat=n=2:v=0:a=1[ax${j}]`);
      } else {
        const x = Math.min(parts[j]!.blendMs!, lenOf(parts[j]!) - FRAME_SLACK_MS);
        chains.push(`[${v}][v${j}]xfade=transition=fade:duration=${sec(x)}:offset=${offset(k)}[vx${j}]`);
        chains.push(parts[j]!.blendMode === "freeze" ? `[${a}][a${j}]concat=n=2:v=0:a=1[ax${j}]` : `[${a}][a${j}]acrossfade=d=${sec(x)}:c1=tri:c2=tri[ax${j}]`);
      }
      v = `vx${j}`;
      a = `ax${j}`;
    }
    if (s.from || s.to) {
      // cut to its frames and samples of the run, by count: the stretch before ends where this one starts
      const at = { frame: clock.frame[base]!, sample: clock.sample[base]! };
      const bounds = (kind: "frame" | "sample") => [s.from ? `start_${kind}=${s.from[kind] - at[kind]}` : "", s.to ? `end_${kind}=${s.to[kind] - at[kind]}` : ""].filter(Boolean).join(":");
      chains.push(`[${v}]trim=${bounds("frame")},setpts=PTS-STARTPTS[vc${head}]`, `[${a}]atrim=${bounds("sample")},asetpts=PTS-STARTPTS[ac${head}]`);
      v = `vc${head}`;
      a = `ac${head}`;
      total += (s.to ? (s.to.frame * 1000) / fps : clock.ms) - (s.from ? (s.from.frame * 1000) / fps : 0);
    } else total += clock.ms;
    outs.push(`[${v}][${a}]`);
  }
  return { outs, total };
}

/**
 * Pieces (piecesOf) with each run longer than a piece cut into stretches of about a piece each: a dissolve or a transition
 * on every cut made one run of the whole timeline, and ffmpeg held every one of its inputs open at once (2.2 GB for 60
 * 720p clips, 3.3 GB for 100). A run is cut inside a part, between the fade into it and the fade out of it, on a frame
 * whose moment is a whole sound sample too; each side makes that part, the one up to the cut and the other from it, and
 * its fades on the same frames as the whole run, so that the frames and the sound are those of the run made whole. A
 * run with no such part (fades that touch), or at a speed whose frames fall between samples, is made whole as before.
 */
export function cutLongRuns(parts: ExportPart[], pieces: number[][][], fps: number): Stretch[][] {
  const out: Stretch[][] = [];
  for (const piece of pieces) {
    let current: Stretch[] = [];
    for (const run of piece) {
      for (const s of run.length > EXPORT_PIECE.parts && Number.isInteger(fps) && RATE % fps === 0 ? cutRun(parts, run, fps) : [{ run, parts: run }]) {
        current.push(s);
        // a stretch cut at its end ends its piece: the next starts the next one
        if (s.to) {
          out.push(current);
          current = [];
        }
      }
    }
    if (current.length) out.push(current);
  }
  return out;
}

/** A long run as stretches of about EXPORT_PIECE.parts parts, each cut inside the part it shares with the next (cutLongRuns). */
function cutRun(parts: ExportPart[], run: number[], fps: number): Stretch[] {
  const clock = runClock(parts, run, fps);
  // where part k of the run can be cut: the middle of its own frames, between its fade in and the next part's, and on a
  // sample that neither sound crossfade reaches
  const cutAt = (k: number) => {
    if (k <= 0 || k >= run.length - 1) return null;
    const first = clock.frame[k]! + clock.fadeFrames[k]!;
    const frame = Math.floor((first + clock.frame[k + 1]!) / 2);
    const sample = (frame * RATE) / fps;
    const ok = frame > first && frame < clock.frame[k + 1]! && sample >= clock.sample[k]! + clock.fadeSamples[k]! && sample <= clock.sample[k + 1]!;
    return ok ? { frame, sample } : null;
  };
  const stretches: Stretch[] = [];
  let start = 0;
  let from: Stretch["from"];
  while (run.length - start > EXPORT_PIECE.parts + 1) {
    // a piece's worth on, or the nearest part before (else after) that can be cut
    const aim = start + EXPORT_PIECE.parts - 1;
    const tries = [...Array.from({ length: aim - start }, (_, n) => aim - n), ...Array.from({ length: Math.max(0, run.length - 2 - aim) }, (_, n) => aim + 1 + n)];
    const k = tries.find((n) => cutAt(n));
    if (k === undefined) break;
    const to = cutAt(k)!;
    stretches.push({ run, parts: run.slice(start, k + 1), ...(from ? { from } : {}), to });
    start = k;
    from = to;
  }
  stretches.push({ run, parts: run.slice(start), ...(from ? { from } : {}) });
  return stretches;
}

/** The music as heard under the video, `[under]`: its part of the song, from where it starts, multiplied by its gain curve (ducked where people speak). */
function musicUnder(plan: MusicPlan, input: { index: number }, gainInput: { index: number }): string[] {
  const heard = Math.max(0, plan.endMs - plan.startMs);
  return [
    `[${input.index}:a]${STEREO},atrim=${plan.fromMs > 0 ? `start=${sec(plan.fromMs)}:` : ""}duration=${sec(heard)},asetpts=PTS-STARTPTS` +
      (plan.startMs > 0 ? `,adelay=delays=${Math.round(plan.startMs)}:all=1` : "") +
      "[music]",
    `[${gainInput.index}:a]${STEREO}[gain]`,
    "[music][gain]amultiply[under]",
  ];
}

/**
 * The music under the joined sound (`voices`, made `a`): the part of the song the plan says, from where it starts on the
 * video's clock to where it stops, multiplied by its gain (`gainInput`, musicGainWav): its volume and fades, each clip's
 * level, mute and fades, the ducking. Exported for the tests.
 */
export function musicChain(plan: MusicPlan, input: { index: number }, gainInput: { index: number }): string[] {
  return [...musicUnder(plan, input, gainInput), "[voices][under]amix=inputs=2:duration=first:normalize=0[a]"];
}

/**
 * The music alone, as it is heard under the video (the same part of the song, the same ducking), as long as the video:
 * a WAV for an editor's music track, laid at its start.
 */
export async function musicTrack(music: ExportMusic, totalMs: number, signal?: AbortSignal): Promise<Uint8Array> {
  return inTemp(async (dir) => {
    const inputs = new Inputs(dir);
    const track = await inputs.add(`music.${music.ext}`, music.source);
    const chains = [...musicUnder(music.plan, track, await inputs.add("gain.wav", musicGainWav(music, totalMs))), `[under]apad=whole_dur=${sec(totalMs)}[a]`];
    const out = join(dir, "music.wav");
    await must(tools.ffmpeg, ["-y", "-loglevel", "error", ...inputs.args, "-filter_complex", chains.join(";"), "-map", "[a]", "-t", sec(totalMs), "-c:a", "pcm_s16le", out], { timeout: 10 * 60_000, signal });
    return new Uint8Array(await readFile(out));
  });
}

/** The music's gain along the video, as the player sets it (musicGainAt), as a WAV the music is multiplied by. */
export const musicGainWav = (music: Pick<ExportMusic, "plan" | "duck">, totalMs: number) => gainWav((ms) => musicGainAt(music.plan, music.duck, ms), totalMs, 4000);
