import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

/**
 * Stand-ins for the ffmpegs that broke joins: the real ffmpeg and ffprobe behind them, named by their folder. `short` cuts a
 * join's run-up a frame short (as ComfyUI's 7.1 does at 24 fps, and Nicolas's old one did); `old` says it is 4.2.7; `nox264`
 * is a build without libx264 (as the bundles' LGPL one was); `hangcut` hangs on the cut and `hangcount` on the frame count, each
 * ended as a run's timeout ends it, at once, its bounds written down in `bounds`. Any other path runs as it is.
 */
const bounds: { kind: string; timeout?: number; signal?: AbortSignal }[] = [];
(globalThis as { ffBounds?: typeof bounds }).ffBounds = bounds;
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const { delimiter, join: joinPath, basename: base, dirname: dir } = await import("node:path");
  const { existsSync: exists } = await import("node:fs");
  const ext = process.platform === "win32" ? ".exe" : "";
  const realTool = (name: string) => {
    for (const d of (process.env.PATH ?? process.env.Path ?? "").split(process.platform === "win32" ? ";" : delimiter)) {
      if (d && !/afflatus-ffcheck-/.test(d) && exists(joinPath(d, name + ext))) return joinPath(d, name + ext);
    }
    return name;
  };
  type Done = (err: Error | null, stdout: string, stderr: string) => void;
  const execFile = (file: string, args: string[], opts: object, done: Done) => {
    const kind = base(dir(file));
    const tool = /ffprobe/i.test(base(file)) ? "ffprobe" : "ffmpeg";
    if (!["short", "old", "nox264", "hangcut", "hangcount"].includes(kind)) return real.execFile(file, args, opts, done as never);
    const hangs = (kind === "hangcut" && tool === "ffmpeg" && args.some((a) => a.includes("trim=start_frame"))) || (kind === "hangcount" && tool === "ffprobe" && args.includes("-count_frames"));
    if (hangs) {
      const o = opts as { timeout?: number; signal?: AbortSignal };
      (globalThis as unknown as { ffBounds: object[] }).ffBounds.push({ kind, timeout: o.timeout, signal: o.signal });
      const killed = Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM", code: null });
      return void setImmediate(() => done(killed, "", ""));
    }
    if (args.includes("-version") && kind === "old") return void setImmediate(() => done(null, `${tool} version 4.2.7-0ubuntu0.1 Copyright (c) 2000-2022 the FFmpeg developers\n`, ""));
    if (tool === "ffmpeg" && kind === "nox264") {
      if (args.includes("-encoders")) {
        return void real.execFile(realTool("ffmpeg"), args, opts, ((err: Error | null, out: string, e: string) => done(err, String(out).split(/\r?\n/).filter((l) => !/libx264/.test(l)).join("\n"), e)) as never);
      }
      if (args.includes("libx264")) {
        const err = Object.assign(new Error("Command failed"), { code: 1 });
        return void setImmediate(() => done(err, "", "[vost#0:0 @ 0000] Unknown encoder 'libx264'\nError selecting an encoder"));
      }
    }
    const changed = tool === "ffmpeg" && kind === "short" ? args.map((a) => a.replace(/end_frame=(\d+)/, (_, n: string) => `end_frame=${Number(n) - 1}`)) : args;
    return real.execFile(realTool(tool), changed, opts, done as never);
  };
  return { ...real, execFile };
});

const { cutFrames } = await import("../src/cut");
const { chooseFfmpeg, candidates, newEnough, shortVersion, tryTools, wordsOf, comfyFfmpegs, FFMPEG_LEAST, CHECK_TIMEOUTS } = await import("../src/ffmpegCheck");
const { runPreflight } = await import("../src/preflight");
const { tools, chooseTools } = await import("../src/video");
const { ffmpegThere, patternClip, FFMPEG_TIMEOUT } = await import("./clipKit");

const exe = process.platform === "win32" ? ".exe" : "";
const root = mkdtempSync(join(tmpdir(), "afflatus-ffcheck-"));
/** A folder with an ffmpeg and an ffprobe of the stand-in `kind`: files that exist, run through the mock above. */
function toolsOf(kind: string, where = root): { ffmpeg: string; ffprobe: string; dir: string } {
  const dir = join(where, kind);
  mkdirSync(dir, { recursive: true });
  for (const t of ["ffmpeg", "ffprobe"]) if (!existsSync(join(dir, t + exe))) writeFileSync(join(dir, t + exe), "");
  return { ffmpeg: join(dir, "ffmpeg" + exe), ffprobe: join(dir, "ffprobe" + exe), dir };
}
const before = { ...tools };
afterEach(() => chooseTools(before.ffmpeg, before.ffprobe, null));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(!ffmpegThere)("an ffmpeg that cuts a join's run-up a frame short", { timeout: FFMPEG_TIMEOUT }, () => {
  it("fails the cut naming that ffmpeg, its version and the count it gave (Nicolas's join, 2026-10-24)", async () => {
    const clip = await patternClip(3);
    const short = toolsOf("short");
    chooseTools(short.ffmpeg, before.ffprobe, "ffmpeg 7.1 (ComfyUI's)");
    const cut = cutFrames(clip, "mp4", { durationMs: 3000, hasSound: true }, { counts: [22], fps: 24, side: "before" });
    await expect(cut).rejects.toThrow(/could not be cut from that clip: ffmpeg 7\.1 \(ComfyUI's\) cut 21 where 22 were asked.*Settings › About/);
  });

  it("is refused by the start-up check, which says what it cut", async () => {
    const t = await tryTools({ ...toolsOf("short"), where: "path" });
    expect(t.ok).toBe(false);
    expect(t.why).toMatch(/^cut 21 frames where 22 were asked/);
  });

  it("is passed over for the next one found that cuts right, said in the check", async () => {
    const data = join(root, "data-next");
    const comfy = join(root, "ComfyUI");
    // ComfyUI's own: imageio-ffmpeg's build in its venv (the real ffmpeg here), with no ffprobe beside it
    const bins = join(comfy, "venv", process.platform === "win32" ? "Lib" : "lib/python3.12", "site-packages", "imageio_ffmpeg", "binaries");
    mkdirSync(bins, { recursive: true });
    const real = join(bins, process.platform === "win32" ? "ffmpeg-win-x86_64-v9.0.exe" : "ffmpeg-linux-x86_64-v9.0");
    writeFileSync(real, "");
    expect(await comfyFfmpegs(comfy)).toEqual([real]);
    const short = toolsOf("short");
    const env = { PATH: short.dir };
    // the stand-in for imageio's file runs the real ffmpeg: it is matched by its folder, not run as an empty file
    const choice = await chooseFfmpeg({
      dataDir: data, comfyDirs: [comfy], env, fresh: true,
      tryOne: (c) => (c.where === "comfy" ? tryTools({ ...c, ffmpeg: "ffmpeg" }).then((t) => ({ ...t, ffmpeg: c.ffmpeg, ffprobe: c.ffprobe })) : tryTools(c)),
    });
    expect(choice.used).toMatchObject({ where: "comfy", ok: true, ffmpeg: real });
    expect(choice.refused.map((r) => [r.where, r.ok])).toEqual([["path", false]]);
    // ComfyUI's ships no ffprobe: the PATH's goes with it
    expect(choice.used!.ffprobe).toBe(short.ffprobe);
    const words = wordsOf(choice);
    expect(words.ffmpeg.ok).toBe(true);
    expect(words.ffmpeg.note).toMatch(/^ffmpeg \S+ on your PATH cut 21 frames where 22 were asked \(at 24 fps\): using ComfyUI's ffmpeg \S+ instead\.$/);
  });
});

describe.skipIf(!ffmpegThere)("the start-up check of ffmpeg", { timeout: FFMPEG_TIMEOUT }, () => {
  it("passes the real one here, cutting exactly", async () => {
    const t = await tryTools({ ffmpeg: before.ffmpeg, ffprobe: before.ffprobe, where: "path" });
    expect(t).toMatchObject({ ok: true, why: null });
    expect(newEnough(t.version!)).toBe(true);
  });

  it("refuses one older than the minimum without cutting anything", async () => {
    const t = await tryTools({ ...toolsOf("old"), where: "path" });
    expect(t).toMatchObject({ ok: false, version: "4.2.7-0ubuntu0.1", why: `is older than ${FFMPEG_LEAST}` });
  });

  it("refuses a build without libx264", async () => {
    const t = await tryTools({ ...toolsOf("nox264"), where: "path" });
    expect(t).toMatchObject({ ok: false, why: "has no libx264 encoder" });
  });

  it("never swaps the FFMPEG the person set: theirs is said with its failure and how to put it right", async () => {
    const data = join(root, "data-pinned");
    const old = toolsOf("old");
    const p = await runPreflight(data, { ffmpeg: old.ffmpeg, ffprobe: old.ffprobe }, { env: { PATH: process.env.PATH ?? process.env.Path ?? "" } });
    expect(p.ffmpeg.pinned).toBe(true);
    expect(p.ffmpeg.used).toMatchObject({ where: "set", ffmpeg: old.ffmpeg, ok: false });
    // the real ffmpeg on the PATH is not even tried
    expect(p.ffmpeg.refused).toEqual([]);
    const check = p.checks.find((c) => c.id === "ffmpeg")!;
    expect(check).toMatchObject({ ok: false, detail: `4.2.7 (FFMPEG) is older than ${FFMPEG_LEAST}` });
    expect(check.fix).toMatch(/^FFMPEG is set to .*: point it to ffmpeg \S+ or newer, or take it out/);
    expect(check.get).toBeUndefined();
  });

  it("offers Get ffmpeg when nothing found passes, and keeps a result until the file changes", async () => {
    const data = join(root, "data-none");
    mkdirSync(data, { recursive: true });
    const old = toolsOf("old");
    let tried = 0;
    const tryOne = (c: Parameters<typeof tryTools>[0]) => (tried++, tryTools(c));
    const first = await chooseFfmpeg({ dataDir: data, comfyDirs: [], env: { PATH: old.dir }, tryOne });
    expect(first.used).toMatchObject({ where: "path", ok: false });
    expect(wordsOf(first, "linux").ffmpeg).toMatchObject({ ok: false, get: "download" });
    expect(wordsOf(first, "darwin").ffmpeg).toMatchObject({ ok: false, get: "brew" });
    expect(wordsOf(first, "darwin").ffmpeg.fix).toMatch(/brew install ffmpeg/);
    // the next start: the same files, the result kept
    await chooseFfmpeg({ dataDir: data, comfyDirs: [], env: { PATH: old.dir }, tryOne });
    expect(tried).toBe(1);
    // another file at that place: tried again
    writeFileSync(old.ffmpeg, "changed");
    await chooseFfmpeg({ dataDir: data, comfyDirs: [], env: { PATH: old.dir }, tryOne });
    expect(tried).toBe(2);
  });

  it("starts with a damaged kept file, as with none, and writes it whole again", async () => {
    const old = toolsOf("old");
    for (const [i, text] of ["", '{"half": {"ffmpeg": "C:', "null", "[1]"].entries()) {
      const data = join(root, `data-damaged-${i}`);
      mkdirSync(data, { recursive: true });
      writeFileSync(join(data, "ffmpeg-check.json"), text);
      let tried = 0;
      const choice = await chooseFfmpeg({ dataDir: data, comfyDirs: [], env: { PATH: old.dir }, tryOne: (c) => (tried++, tryTools(c)) });
      expect(choice.used, JSON.stringify(text)).toMatchObject({ where: "path", ok: false });
      expect(tried).toBe(1);
      expect(Object.keys(JSON.parse(readFileSync(join(data, "ffmpeg-check.json"), "utf8")))).toHaveLength(1);
      expect(existsSync(join(data, "ffmpeg-check.json.tmp"))).toBe(false);
    }
  });

  it("tries again an ffmpeg kept as passing by a check that asked less (an older release's key)", async () => {
    const data = join(root, "data-older-check");
    mkdirSync(data, { recursive: true });
    const old = toolsOf("old");
    const stamp = (f: string) => `${f}|${statSync(f).size}|${Math.round(statSync(f).mtimeMs)}`;
    // 0.6.1's key: the two files' stamps alone, kept as "ok"
    const pass = { ffmpeg: old.ffmpeg, ffprobe: old.ffprobe, where: "path", ok: true, version: "4.2.7", probeVersion: "4.2.7", why: null };
    writeFileSync(join(data, "ffmpeg-check.json"), JSON.stringify({ [`${stamp(old.ffmpeg)}>${stamp(old.ffprobe)}`]: pass }));
    let tried = 0;
    const choice = await chooseFfmpeg({ dataDir: data, comfyDirs: [], env: { PATH: old.dir }, tryOne: (c) => (tried++, tryTools(c)) });
    expect(tried).toBe(1);
    expect(choice.used).toMatchObject({ ok: false, why: expect.stringMatching(/older than/) });
  });

  it("takes Get ffmpeg's download in the data folder before ComfyUI's", async () => {
    const data = join(root, "data-got");
    const got = toolsOf("bin", data);
    const choice = await chooseFfmpeg({ dataDir: data, comfyDirs: [], env: { PATH: toolsOf("short").dir }, fresh: true, tryOne: async (c) => ({ ...c, ok: c.where === "got", version: "9.0.2", probeVersion: "9.0.2", why: c.where === "got" ? null : "cut 21 frames where 22 were asked (at 24 fps)" }) });
    expect(choice.used).toMatchObject({ where: "got", ffmpeg: got.ffmpeg, ffprobe: got.ffprobe });
    expect(basename(dirname(choice.used!.ffmpeg))).toBe("bin");
  });
});

describe.skipIf(!ffmpegThere)("an ffmpeg that hangs in the start-up check", { timeout: FFMPEG_TIMEOUT }, () => {
  it("is refused within the check's own bounds, not a job's two minutes, and the next one is chosen", async () => {
    // the start waits on the check before it listens, and an update's --check has two minutes (updatesInstall.ts)
    for (const kind of ["hangcut", "hangcount"]) {
      bounds.length = 0;
      const data = join(root, `data-${kind}`);
      const got = toolsOf("bin", data);
      const choice = await chooseFfmpeg({
        dataDir: data, comfyDirs: [], env: { PATH: toolsOf(kind).dir }, fresh: true,
        // Get ffmpeg's stand-in runs the real ffmpeg here
        tryOne: (c) => (c.where === "got" ? tryTools({ ...c, ffmpeg: before.ffmpeg, ffprobe: before.ffprobe }).then((t) => ({ ...t, ffmpeg: c.ffmpeg, ffprobe: c.ffprobe })) : tryTools(c)),
      });
      expect(choice.refused.map((r) => [r.where, r.ok])).toEqual([["path", false]]);
      expect(choice.refused[0]!.why).toMatch(kind === "hangcut" ? /^could not cut frames/ : /could not count the frames/);
      expect(choice.used).toMatchObject({ where: "got", ok: true, ffmpeg: got.ffmpeg });
      expect(bounds).toHaveLength(1);
      expect(bounds[0]!.timeout).toBe(kind === "hangcut" ? CHECK_TIMEOUTS.cut : CHECK_TIMEOUTS.count);
      expect(bounds[0]!.timeout).toBeLessThanOrEqual(20_000);
      // and every run of the candidate under its whole bound
      expect(bounds[0]!.signal).toBeInstanceOf(AbortSignal);
    }
    expect(CHECK_TIMEOUTS.candidate).toBeLessThanOrEqual(60_000);
  });
});

describe("where the start-up check looks", () => {
  const exe = process.platform === "win32" ? ".exe" : "";
  const fail = async (c: Parameters<typeof tryTools>[0]) => ({ ...c, ok: false, version: "9.0.2", probeVersion: "9.0.2", why: "has no libx264 encoder" });

  it("takes a bundle's FFMPEG, set by an older launcher, as the bundle's: not pinned, the next one tried and Get ffmpeg offered", async () => {
    const bundle = join(root, "Afflatus");
    const bin = toolsOf("bin", join(bundle, "versions", "0.6.1"));
    const mine = toolsOf("mine");
    const env = { AFFLATUS_INSTALL: "bundle", AFFLATUS_ROOT: bundle, FFMPEG: bin.ffmpeg, FFPROBE: bin.ffprobe, PATH: [bin.dir, mine.dir].join(process.platform === "win32" ? ";" : ":") };
    const tried: string[] = [];
    const choice = await chooseFfmpeg({ dataDir: join(root, "data-bundle"), comfyDirs: [], env, fresh: true, tryOne: (c) => (tried.push(`${c.where} ${c.ffmpeg} ${c.ffprobe}`), fail(c)) });
    expect(choice.pinned).toBe(false);
    // the bundle's first, with its own ffprobe; then the person's on the PATH, with theirs (FFPROBE is the launcher's, not theirs)
    expect(tried).toEqual([`bundle ${bin.ffmpeg} ${bin.ffprobe}`, `path ${mine.ffmpeg} ${mine.ffprobe}`]);
    expect(choice.used).toMatchObject({ where: "bundle", ok: false });
    const words = wordsOf(choice, "linux");
    expect(words.ffmpeg).toMatchObject({ ok: false, get: "download" });
    expect(words.ffmpeg.fix).not.toMatch(/FFMPEG is set/);
  });

  it("still takes an FFMPEG outside the bundle's own folders as the person's, in a bundle too", async () => {
    const bundle = join(root, "Afflatus");
    const mine = toolsOf("mine");
    const env = { AFFLATUS_INSTALL: "bundle", AFFLATUS_ROOT: bundle, FFMPEG: mine.ffmpeg, PATH: "" };
    const choice = await chooseFfmpeg({ dataDir: join(root, "data-bundle-own"), comfyDirs: [], env, fresh: true, tryOne: fail });
    expect(choice.pinned).toBe(true);
    expect(choice.used).toMatchObject({ where: "set", ffmpeg: mine.ffmpeg });
    // and a run from the sources with an FFMPEG that happens to sit in a versions/<v>/bin is the person's
    const src = await chooseFfmpeg({ dataDir: join(root, "data-src"), comfyDirs: [], env: { AFFLATUS_ROOT: bundle, FFMPEG: join(bundle, "versions", "0.6.1", "bin", "ffmpeg" + exe), PATH: "" }, fresh: true, tryOne: fail });
    expect(src.pinned).toBe(true);
  });

  it("pairs ComfyUI's ffmpeg, which has no ffprobe, with Get ffmpeg's ffprobe before the PATH's", async () => {
    const data = join(root, "data-pair");
    const gotDir = join(data, "bin");
    mkdirSync(gotDir, { recursive: true });
    writeFileSync(join(gotDir, "ffprobe" + exe), "");
    // the PATH has an ffprobe alone (an old one, say), no ffmpeg
    const pathDir = join(root, "probe-only");
    mkdirSync(pathDir, { recursive: true });
    writeFileSync(join(pathDir, "ffprobe" + exe), "");
    const comfy = join(root, "ComfyUI-pair");
    const bins = join(comfy, "venv", process.platform === "win32" ? "Lib" : "lib/python3.12", "site-packages", "imageio_ffmpeg", "binaries");
    mkdirSync(bins, { recursive: true });
    const imageio = join(bins, process.platform === "win32" ? "ffmpeg-win-x86_64-v7.1.exe" : "ffmpeg-linux-x86_64-v7.1");
    writeFileSync(imageio, "");
    const list = await candidates({ dataDir: data, comfyDirs: [comfy], env: { PATH: pathDir } });
    expect(list).toEqual([{ ffmpeg: imageio, ffprobe: join(gotDir, "ffprobe" + exe), where: "comfy" }]);
  });

  it("tries a bare-name FFMPEG and FFPROBE again when the PATH gives other files for them", async () => {
    const data = join(root, "data-bare");
    mkdirSync(data, { recursive: true });
    const a = toolsOf("bare-a");
    const b = toolsOf("bare-b");
    writeFileSync(b.ffmpeg, "another build");
    let tried = 0;
    const tryOne = (c: Parameters<typeof tryTools>[0]) => (tried++, fail(c));
    await chooseFfmpeg({ dataDir: data, comfyDirs: [], env: { FFMPEG: "ffmpeg", FFPROBE: "ffprobe", PATH: a.dir }, tryOne });
    await chooseFfmpeg({ dataDir: data, comfyDirs: [], env: { FFMPEG: "ffmpeg", FFPROBE: "ffprobe", PATH: a.dir }, tryOne });
    expect(tried).toBe(1);
    await chooseFfmpeg({ dataDir: data, comfyDirs: [], env: { FFMPEG: "ffmpeg", FFPROBE: "ffprobe", PATH: b.dir }, tryOne });
    expect(tried).toBe(2);
  });
});

describe("ffmpeg's versions", () => {
  it("are read short and held against the minimum; a nightly that names none is taken as new", () => {
    expect(shortVersion("n9.0.2-17-g2a571b6068-20260930")).toBe("9.0.2");
    expect(shortVersion("7.1-essentials_build-www.gyan.dev")).toBe("7.1");
    expect(newEnough("4.4.2-0ubuntu0.22.04.1")).toBe(false);
    expect(newEnough("9.0.2-full_build-www.gyan.dev")).toBe(true);
    expect(newEnough("N-112345-g0123456789")).toBe(true);
    expect(newEnough(FFMPEG_LEAST)).toBe(true);
  });
});
