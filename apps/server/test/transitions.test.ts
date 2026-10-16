import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { modelsDiffer, transitionOf, transitionSpan, TRANSITION_KINDS, TRANSITIONS, type TransitionKind } from "@afflatus/core";
import { joinVideosInto, type ExportPart } from "../src/exportJoin";

/** A cut's transition: what is kept of one, how long it plays at a join, and the export's picture and clock with one. */

describe("a transition", () => {
  it("is kept checked: a known kind, its length within bounds, its sound on or faded", () => {
    expect(transitionOf({ kind: "flash", ms: 250, sound: "fade" })).toEqual({ kind: "flash", ms: 250, sound: "fade" });
    expect(transitionOf({ kind: "dissolve", ms: 99999 })).toEqual({ kind: "dissolve", ms: 2000, sound: "on" });
    expect(transitionOf({ kind: "dissolve" })).toEqual({ kind: "dissolve", ms: TRANSITIONS.dissolve.ms, sound: "on" });
    expect(transitionOf({ kind: "spin", ms: 300 })).toBeNull();
    expect(transitionOf(null)).toBeNull();
  });
  it("plays on a cut only, each half within its clip", () => {
    const t = { kind: "dissolve" as const, ms: 600, sound: "on" as const };
    expect(transitionSpan(t, "cut", 5000, 5000)).toBe(600);
    expect(transitionSpan(t, "continue", 5000, 5000)).toBe(0);
    expect(transitionSpan(t, "cut", undefined, 5000)).toBe(0);
    // half of it at most the clip less a frame: a 240 ms clip gives 400 ms
    expect(transitionSpan(t, "cut", 240, 5000)).toBe(400);
    expect(transitionSpan(t, "cut", 70, 5000)).toBe(0);
    expect(transitionSpan(null, "cut", 5000, 5000)).toBe(0);
  });
  it("is warned of across two video models, never within one", () => {
    expect(modelsDiffer({ family: "h3" }, { family: "scail" })).toBe(true);
    expect(modelsDiffer({ family: "h3" }, { family: "h3" })).toBe(false);
    expect(modelsDiffer(undefined, { family: "scail" })).toBe(false);
    expect(modelsDiffer({ family: null }, { family: "scail" })).toBe(false);
  });
});

/** One second of a flat colour with a tone, at 24 frames a second. Null where ffmpeg is not installed. */
function colourClip(dir: string, name: string, colour: string): string | null {
  const file = join(dir, `${name}.mp4`);
  const made = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${colour}:s=192x320:r=24:d=1`, "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file]);
  return made.status === 0 ? file : null;
}

const dir = mkdtempSync(join(tmpdir(), "afflatus-transition-"));
const red = colourClip(dir, "red", "0xd02020");
const blue = colourClip(dir, "blue", "0x2040d0");

/** The mean colour of the export's frame at `sec`, as RGB. */
function colourAt(file: string, sec: number): [number, number, number] {
  const out = spawnSync("ffmpeg", ["-loglevel", "error", "-ss", sec.toFixed(3), "-i", file, "-frames:v", "1", "-vf", "scale=1:1:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  const b = out.stdout;
  return [b[0]!, b[1]!, b[2]!];
}
/** A frame's mean colour across its width: left half and right half. */
function halvesAt(file: string, sec: number): { left: [number, number, number]; right: [number, number, number] } {
  const out = spawnSync("ffmpeg", ["-loglevel", "error", "-ss", sec.toFixed(3), "-i", file, "-frames:v", "1", "-vf", "scale=2:1:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  const b = out.stdout;
  return { left: [b[0]!, b[1]!, b[2]!], right: [b[3]!, b[4]!, b[5]!] };
}
const lengthOf = (file: string, stream: "v:0" | "a:0") =>
  Number(spawnSync("ffprobe", ["-v", "error", "-select_streams", stream, "-show_entries", "stream=duration", "-of", "csv=p=0", file]).stdout.toString().trim());

describe.skipIf(!red || !blue)("an export with a transition", () => {
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const part = (source: string, transitionIn?: { kind: TransitionKind; ms: number; fadeSound?: boolean }): ExportPart => ({
    kind: "video", source, ext: "mp4", startMs: 0, endMs: 1000, hasSound: true, sound: "own", volume: 1, fill: false,
    ...(transitionIn ? { transitionIn: { kind: transitionIn.kind, xfade: TRANSITIONS[transitionIn.kind].xfade, ms: transitionIn.ms, fadeSound: Boolean(transitionIn.fadeSound) } } : {}),
  });
  const exported = async (kind: TransitionKind, ms = 500, fadeSound = false) => {
    const out = join(dir, `${kind}-${ms}${fadeSound ? "-fade" : ""}.mp4`);
    await joinVideosInto([part(red!), part(blue!, { kind, ms, fadeSound })], { width: 192, height: 320 }, 24, {}, (file) => copyFile(file, out));
    return out;
  };
  const isRed = (c: number[]) => c[0]! > 150 && c[2]! < 90;
  const isBlue = (c: number[]) => c[2]! > 150 && c[0]! < 90;

  it("keeps the clock: two 1 s clips stay 2 s, picture and sound, whatever the kind", async () => {
    for (const kind of TRANSITION_KINDS) {
      const out = await exported(kind);
      expect(Math.abs(lengthOf(out, "v:0") - 2), kind).toBeLessThan(0.05);
      expect(Math.abs(lengthOf(out, "a:0") - 2), kind).toBeLessThan(0.06);
      // outside the transition, each clip as it is
      expect(isRed(colourAt(out, 0.5)), kind).toBe(true);
      expect(isBlue(colourAt(out, 1.5)), kind).toBe(true);
    }
  }, 120_000);

  it("draws each kind over the cut: a dip goes through its colour, a flash through white, a dissolve mixes, a wipe halves", async () => {
    const mid = (c: number[]) => (c[0]! + c[1]! + c[2]!) / 3;
    expect(mid(colourAt(await exported("dip-black"), 1.0))).toBeLessThan(30);
    expect(mid(colourAt(await exported("dip-white"), 1.0))).toBeGreaterThan(200);
    expect(mid(colourAt(await exported("flash", 250), 1.0))).toBeGreaterThan(180);
    const dissolved = colourAt(await exported("dissolve"), 1.0);
    expect(dissolved[0]).toBeGreaterThan(80);
    expect(dissolved[2]).toBeGreaterThan(80);
    // wipe left: the clip after comes in from the right
    const wiped = await exported("wipe-left");
    expect(isRed(halvesAt(wiped, 0.85).left)).toBe(true);
    expect(isBlue(halvesAt(wiped, 0.85).right)).toBe(false);
    expect(isBlue(halvesAt(wiped, 1.15).right)).toBe(true);
    expect(isRed(halvesAt(wiped, 1.15).left)).toBe(false);
  }, 120_000);

  it("fades the sound out and in over the halves when asked, and runs it straight on otherwise", async () => {
    const loudAt = (file: string, sec: number) => {
      const said = spawnSync("ffmpeg", ["-loglevel", "info", "-ss", sec.toFixed(3), "-t", "0.04", "-i", file, "-af", "volumedetect", "-vn", "-f", "null", "-"]).stderr.toString();
      return Number(/mean_volume: (-?[\d.]+|-inf)/.exec(said)?.[1] ?? -91);
    };
    const faded = await exported("dissolve", 500, true);
    const straight = await exported("dissolve", 500, false);
    expect(loudAt(faded, 0.99)).toBeLessThan(loudAt(straight, 0.99) - 12);
    expect(Math.abs(loudAt(faded, 0.4) - loudAt(straight, 0.4))).toBeLessThan(1.5);
  }, 120_000);
});

