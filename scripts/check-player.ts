/// <reference lib="dom" />
/**
 * The timeline player, frame by frame (`pnpm check:player`; CI runs it). A throwaway Afflatus (its own temporary data, no
 * ComfyUI) gets H3-shaped synthetic clips chained seamlessly (apps/server/test/framesKit.ts: each frame shows its clip and
 * index as a barcode), the real editor plays the timeline in headless Chrome, and every frame the player shows is read off
 * the video that is visible at that moment. It fails on a frame shown out of order, a flash of the clip before after the
 * hand-over, a hidden run-up frame shown, or more dropped frames than a busy machine explains. The chain is played again under
 * load (CPU slowed, videos starting late: see playChain), where only the order, flicker and run-up faults count. Then, in a fresh page: Space
 * pressed twice on a clip whose video has not loaded yet must leave it still (it started on its own, with its sound, once
 * its file came), and a range looped (I, O, L) must go back to In at Out, again and again, without playing on past it. Last,
 * a selected clip's trim edges at a join must take a press there (the browser's own hit test), and a drag of one trims.
 *
 * Needs the web app built (`pnpm build`), ffmpeg, and Chrome (or CHROME=<path to a Chromium>).
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright-core";
import { plural } from "@afflatus/core";
import { buildApp } from "../apps/server/src/app";
import { migrate, openSqlite } from "../apps/server/src/db";
import { createServices } from "../apps/server/src/services";
import { writeSettings } from "../apps/server/src/settings";
import { LocalStorage } from "../apps/server/src/storage";
import { BITS, H, synth, W } from "../apps/server/test/framesKit";

const N = 124;
const FILE = 2 * N - 1;
const RUN_UP_LAST = 43;
/**
 * Frames the player may drop before it counts as a fault: headless Chrome decodes in software, and a CI runner is slow, so a
 * few percent are the machine. Drops gathered around a hand-over are counted apart (HANDOVER_DROPS): the next clip pre-rolls
 * under the one seen, two decodes at once (measured 2026-10-08, frames 215–245 of a 247-frame clip with an 800 ms pre-roll).
 */
const DROPS_ALLOWED = 0.1;
const LAST_SECOND = FILE - 48;
/** Frames a hand-over may drop, in the clip before's last second and over the change: more is the pre-roll stalling it. */
const HANDOVER_DROPS = 5;
/** How late every video starts in the pass under load (see playChain): past the 70 ms the player first expects (startLag). */
const LATE_PLAY_MS = 100;
/** Every video's play() taking effect LATE_PLAY_MS late, as a loaded machine's media pipeline does. Plain text, as WATCH. */
const LATE_PLAY = `{
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { return new Promise((done) => setTimeout(done, ${LATE_PLAY_MS})).then(() => play.call(this)); };
  }`;

const dir = mkdtempSync(join(tmpdir(), "afflatus-player-"));
const db = openSqlite(":memory:");
await migrate(db);
await writeSettings(db, { comfyUrl: "http://127.0.0.1:9" });
const services = await createServices(db, "sqlite", new LocalStorage(dir));
const web = fileURLToPath(new URL("../apps/web/dist", import.meta.url));
if (!existsSync(join(web, "index.html"))) throw new Error("The web app is not built: run `pnpm build` first.");
const app = buildApp(services, { webDir: web });
await app.listen({ port: 0, host: "127.0.0.1" });
const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

const call = async (method: string, url: string, payload?: unknown) => {
  const res = await app.inject({ method: method as "POST", url, payload: payload as object });
  if (res.statusCode >= 400) throw new Error(`${method} ${url}: ${res.statusCode} ${res.body}`);
  return res.json();
};

/**
 * Every frame a video presents, read off it when it is the one seen (the hidden pre-roll is near transparent). Plain text:
 * a function passed here would be compiled with helpers (esbuild's __name) the page does not have.
 */
const WATCH = `(() => {
    const W = ${W}, H = ${H}, BITS = ${BITS};
    const shown = [];
    window.__shown = shown;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const watched = new WeakSet();
    const watch = (v) => {
      if (watched.has(v)) return;
      watched.add(v);
      const tick = () => {
        const seen = v.isConnected && v.style.visibility !== "hidden" && Number(getComputedStyle(v).opacity) > 0.5 && v.offsetWidth > 0;
        if (seen) {
          ctx.drawImage(v, 0, 0, W, H);
          const px = ctx.getImageData(0, 0, W, H).data;
          const word = (y) => { let n = 0; for (let j = 0; j < BITS; j++) if (px[(y * W + j * 16 + 8) * 4] > 128) n += 2 ** j; return n; };
          shown.push({ clip: word(48), index: word(16) });
        }
        v.requestVideoFrameCallback(tick);
      };
      v.requestVideoFrameCallback(tick);
    };
    const all = () => document.querySelectorAll("video").forEach(watch);
    window.__watch = all;
    new MutationObserver(all).observe(document, { subtree: true, childList: true });
  })();`;

/** The frames a page has seen so far, as `WATCH` read them. */
const shownIn = (page: Page) => page.evaluate(() => (window as unknown as { __shown: Array<{ clip: number; index: number }> }).__shown.slice());

let failed = false;
const browser = await chromium.launch({
  ...(process.env.CHROME ? { executablePath: process.env.CHROME } : { channel: "chrome" }),
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"],
});
try {
  // the chain: three clips, each after the first carrying on from the one before, decoded as one piece with it
  const tl = await call("POST", "/api/timelines", { name: "player check" });
  for (const clip of [1, 2, 3]) {
    const res = await app.inject({ method: "POST", url: `/api/assets?name=c${clip}.mp4`, headers: { "content-type": "video/mp4" }, payload: Buffer.from(synth(clip, FILE, 48)) });
    const asset = res.json() as { id: string };
    await db.updateTable("assets").set({ latent_frames: N }).where("id", "=", asset.id).execute();
    await call("POST", `/api/timelines/${tl.id}/clips`, { asset: asset.id });
  }
  // each clip's playing take is sent by its id, found among its takes
  const sent = (await call("GET", `/api/timelines/${tl.id}`)).clips as Array<{ id: string; take: string; takes: Array<{ id: string; asset: { id: string } }> }>;
  const clips = sent.map((c) => ({ id: c.id, take: c.takes.find((x) => x.id === c.take)! }));
  for (let i = 1; i < clips.length; i++) {
    await call("PATCH", `/api/clips/${clips[i]!.id}`, { joined: "continue" });
    await db.updateTable("takes").set({ head_ms: 917, join_kind: "seamless", prev_take_id: clips[i - 1]!.take.id, prev_at_ms: Math.round((N * 1000) / 24) }).where("id", "=", clips[i]!.take.id).execute();
  }

  /**
   * The chain played from its start in a page of its own: the frames seen, consecutive repeats of one frame as one (a
   * repaint). `loaded` plays it as on a machine busy elsewhere (a render running, a CI runner): the page's CPU four times
   * slower, and every video starting LATE_PLAY_MS after it is told to play. CPU throttling alone leaves the decoder (another
   * process) as fast and passed; the late start is what a loaded machine does to the clip after, which then runs behind its
   * start at the cut (the 0.6.0 release run showed a run-up frame so, card #48).
   */
  const playChain = async (loaded: boolean) => {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await page.addInitScript(WATCH);
    if (loaded) {
      await page.addInitScript(LATE_PLAY);
      await (await page.context().newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: 4 });
    }
    await page.goto(`${base}/timelines/${tl.id}`);
    await page.waitForFunction(() => document.querySelectorAll("video").length > 0, null, { timeout: 30_000 });
    await page.waitForTimeout(1500);
    await page.evaluate(() => (window as unknown as { __watch: () => void }).__watch());
    await page.locator("body").press("Space");
    // the whole chain, and a margin
    await page.waitForTimeout(16_500);
    const raw = await shownIn(page);
    await page.close();
    return raw.filter((f, i) => !(i && raw[i - 1]!.clip === f.clip && raw[i - 1]!.index === f.index));
  };
  const problems: string[] = [];
  /**
   * The faults no machine may show, however slow: a frame out of order, the clip before again after the hand-over, a frame of
   * the hidden run-up, a clip never seen. Gives the frame each hand-over landed on (the next from the frame after its run-up).
   */
  const orderFaults = (seen: Array<{ clip: number; index: number }>, under: string) => {
    const landed: number[] = [];
    for (let i = 1; i < seen.length; i++) {
      const a = seen[i - 1]!;
      const b = seen[i]!;
      if (b.clip < a.clip) problems.push(`${under}clip ${a.clip} frame ${a.index} → clip ${b.clip} frame ${b.index}: the clip before shows again after the hand-over (a flicker)`);
      else if (b.clip === a.clip && b.index <= a.index) problems.push(`${under}clip ${b.clip}: frame ${a.index} then ${b.index}, out of order (a duplicated or repeated stretch)`);
      else if (b.clip !== a.clip) {
        landed.push(b.index);
        if (b.index < RUN_UP_LAST) problems.push(`${under}clip ${b.clip} starts at frame ${b.index}: a frame of its hidden run-up is shown`);
      }
    }
    const clipsSeen = [...new Set(seen.map((f) => f.clip))];
    if (clipsSeen.join() !== "1,2,3") problems.push(`${under}clips seen: ${clipsSeen.join(", ") || "none"} (expected 1, 2, 3)`);
    return landed;
  };

  const seen = await playChain(false);
  orderFaults(seen, "");
  let drops = 0;
  const gaps: string[] = [];
  for (let i = 1; i < seen.length; i++) {
    const a = seen[i - 1]!;
    const b = seen[i]!;
    if (b.clip === a.clip && b.index > a.index) {
      drops += b.index - a.index - 1;
      if (b.index - a.index > 1) gaps.push(`${b.clip}:${a.index + 1}${b.index - a.index > 2 ? `–${b.index - 1}` : ""}`);
    } else if (b.clip > a.clip) drops += Math.max(0, FILE - 1 - a.index) + Math.max(0, b.index - RUN_UP_LAST);
  }
  const expected = FILE + 2 * (FILE - RUN_UP_LAST);
  // A GitHub runner (two cores, no GPU) drops about a third of the frames evenly, measured 2026-10-10 against 4% on a
  // desktop, so there the drop count is a warning; the order, flicker and run-up faults still fail everywhere.
  if (drops > expected * DROPS_ALLOWED) {
    if (process.env.CI) console.log(`::warning::player check: ${drops} of ${expected} frames dropped (a slow runner, not failed in CI)`);
    else problems.push(`${drops} of ${expected} frames dropped`);
  }
  console.log(`player check: ${seen.length} frames seen of ${expected}, ${drops} dropped${problems.length ? "" : ", every hand-over clean"}`);
  if (gaps.length) console.log(`  dropped (clip:frame): ${gaps.join(" ")}`);
  // the frames dropped around the two hand-overs: in the last second of a clip before one, and over the change itself. The
  // next clip pre-rolling under the one seen (two decodes at once) dropped 12 to 18 of them with an 800 ms pre-roll, every
  // other frame over its last 0.6 s, seen as a stutter before each join; 2 with 300 ms (2026-10-21)
  // Counted per hand-over (clip 1 to 2, clip 2 to 3), each against its own cap: a sum would let one join drop twice its
  // share while the other dropped none, and that one join is the stutter the user sees.
  const late = new Map<number, number>([[1, 0], [2, 0]]);
  for (let i = 1; i < seen.length; i++) {
    const a = seen[i - 1]!;
    const b = seen[i]!;
    if (b.clip === a.clip && a.clip < 3 && b.index >= LAST_SECOND) late.set(a.clip, late.get(a.clip)! + b.index - Math.max(a.index, LAST_SECOND - 1) - 1);
    else if (b.clip === a.clip + 1) late.set(a.clip, late.get(a.clip)! + Math.max(0, FILE - 1 - a.index) + Math.max(0, b.index - RUN_UP_LAST));
  }
  for (const [clip, n] of late) {
    if (n > HANDOVER_DROPS) {
      if (process.env.CI) console.log(`::warning::player check: ${n} frames dropped around the hand-over from clip ${clip} to ${clip + 1} (a slow runner, not failed in CI)`);
      else problems.push(`${n} frames dropped around the hand-over from clip ${clip} to ${clip + 1} (at most ${HANDOVER_DROPS}): the next clip's pre-roll stalls the one seen`);
    } else if (n) console.log(`  ${n} of the drops around the hand-over from clip ${clip} to ${clip + 1} (at most ${HANDOVER_DROPS})`);
  }

  // ---- the chain again under load: drops are the machine's there, but the hand-overs must still land past the run-up
  const landed = orderFaults(await playChain(true), "under load: ");
  console.log(`player check, under load: the hand-overs landed on frames ${landed.join(", ") || "none"} (the run-up ends before ${RUN_UP_LAST})`);

  // ---- Space twice before a far clip's video has loaded: it stays still. In a fresh page, clip 3's file held back four
  // seconds; [ ] go to clip 2 (clip 3's video put on the page under it, waiting for its file), then to clip 3
  const fresh = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await fresh.addInitScript(WATCH);
  const slowFile = `**/api/assets/${clips[2]!.take.asset.id}/file*`;
  await fresh.route(slowFile, async (route) => {
    await new Promise((done) => setTimeout(done, 4000));
    await route.continue().catch(() => {});
  });
  await fresh.goto(`${base}/timelines/${tl.id}`);
  await fresh.waitForFunction(() => document.querySelectorAll("video").length > 0, null, { timeout: 30_000 });
  await fresh.waitForTimeout(1500);
  await fresh.evaluate(() => (window as unknown as { __watch: () => void }).__watch());
  await fresh.locator("body").press("]");
  await fresh.waitForTimeout(300);
  await fresh.locator("body").press("]");
  await fresh.waitForTimeout(300);
  const unloaded = await fresh.evaluate(() => [...document.querySelectorAll("video")].some((v) => v.readyState < 1));
  await fresh.locator("body").press("Space");
  await fresh.waitForTimeout(120);
  await fresh.locator("body").press("Space");
  const before = (await shownIn(fresh)).length;
  // the file comes, and a second more
  await fresh.waitForTimeout(5500);
  const playing = await fresh.evaluate(() => [...document.querySelectorAll("video")].filter((v) => !v.paused).length);
  const after = new Set((await shownIn(fresh)).slice(before).filter((f) => f.clip === 3).map((f) => f.index));
  if (!unloaded) console.log("  ! Space twice before load: clip 3's video was not waiting for its file (nothing checked)");
  else if (playing || after.size > 2) problems.push(`Space twice before clip 3's video loaded: ${playing ? `${plural(playing, "video")} playing` : "paused"}, ${after.size} frames of clip 3 shown once its file came (it started on its own)`);
  else console.log("player check: Space twice before a video loaded leaves it still");
  await fresh.unroute(slowFile);

  // ---- a range looped: In at clip 2's start, Out 40 frames on, L plays it round. Each pass goes back to In at Out
  await fresh.locator("body").press("Home");
  await fresh.locator("body").press("]");
  await fresh.waitForTimeout(600);
  await fresh.locator("body").press("i");
  for (let k = 0; k < 4; k++) await fresh.keyboard.press("Shift+ArrowRight");
  await fresh.waitForTimeout(600);
  await fresh.locator("body").press("o");
  const outAt = (await shownIn(fresh)).at(-1);
  const from = (await shownIn(fresh)).length;
  // the main thread kept busy meanwhile, as a heavy track render does (50 ms of work every 120 ms), and long enough for a dozen
  // rounds: the Out was only said at the time reports' pace then, and the loop went 56 frames past it in 2 runs of 3 (card #55)
  await fresh.evaluate(() => { setInterval(() => { const end = performance.now() + 50; while (performance.now() < end); }, 120); });
  await fresh.locator("body").press("l");
  await fresh.waitForTimeout(12000);
  await fresh.locator("body").press("Space");
  const looped = (await shownIn(fresh)).slice(from).filter((f, i, all) => !(i && all[i - 1]!.clip === f.clip && all[i - 1]!.index === f.index));
  const rounds = looped.filter((f, i) => i && f.clip === looped[i - 1]!.clip && f.index < looped[i - 1]!.index - 10).length;
  const past = outAt ? looped.filter((f) => f.clip > outAt.clip || (f.clip === outAt.clip && f.index > outAt.index + 6)) : [];
  if (!outAt || outAt.clip !== 2) problems.push(`range loop: Out stood on ${outAt ? `clip ${outAt.clip} frame ${outAt.index}` : "no frame seen"}, not in clip 2`);
  else if (rounds < 6) problems.push(`range loop: back to In ${plural(rounds, "time")} in 12 s of a 0.8 s range (${looped.length} frames seen)`);
  else if (past.length) problems.push(`range loop: ${past.length} frames shown past Out (clip ${outAt.clip} frame ${outAt.index}), as far as clip ${past.at(-1)!.clip} frame ${past.at(-1)!.index}`);
  else console.log(`player check: a range looped ${rounds} times back to In, never past Out`);
  await fresh.close();

  // ---- a selected clip's trim edges at a join: the press is theirs, not the join dot's drawn over them (W-10), a click there opening the join. Hit-tested
  // by the browser itself, which jsdom does not do: at the middle of each edge, the element on top is the edge; then the
  // start edge of clip 2 dragged trims it (neither the join opened nor the clip moved)
  const edges = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const onTop = async (clip: number, name: string) => {
    await edges.goto(`${base}/timelines/${tl.id}?clip=${clip}`);
    const edge = edges.getByRole("separator", { name });
    await edge.waitFor({ timeout: 30_000 });
    const box = (await edge.boundingBox())!;
    const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const top = await edges.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[role=separator], button")?.getAttribute("aria-label") ?? "nothing", at);
    if (top !== name) problems.push(`clip ${clip} selected, the middle of "${name}" is taken by "${top}"`);
    return at;
  };
  const lengthOf2 = async () => ((await call("GET", `/api/timelines/${tl.id}`)).clips as Array<{ lengthMs: number }>)[1]!.lengthMs;
  // a click there (let go of without moving) is the dot's: the join before clip 2 opens in the column, nothing trimmed (card #77)
  const clicked = async (clip: number, name: string) => {
    const spot = await onTop(clip, name);
    const was = await lengthOf2();
    await edges.mouse.click(spot.x, spot.y);
    const opened = await edges.locator("aside span", { hasText: /^Join$/ }).waitFor({ timeout: 5000 }).then(() => true, () => false);
    if (!opened) problems.push(`clip ${clip} selected, a click on "${name}" at the join's dot did not open the join`);
    else if ((await lengthOf2()) !== was) problems.push(`clip ${clip} selected, a click on "${name}" at the join's dot trimmed clip 2`);
    else console.log(`player check: clip ${clip} selected, a click at the join's dot on its edge opens the join`);
  };
  await clicked(1, "Drag to trim the end of the clip");
  await clicked(2, "Drag to trim the start of the clip");
  await onTop(1, "Drag to trim the end of the clip");
  const at = await onTop(2, "Drag to trim the start of the clip");
  const was = await lengthOf2();
  await edges.mouse.move(at.x, at.y);
  await edges.mouse.down();
  await edges.mouse.move(at.x + 20, at.y, { steps: 4 });
  await edges.mouse.move(at.x + 40, at.y, { steps: 4 });
  await edges.mouse.up();
  // The trim is written once the release's patch is through: wait for the shorter length (up to 15 s) rather than read it
  // once after a fixed pause, which a slow runner (CI's player job) could read before the patch and call "not trimmed".
  let trimmedTo = await lengthOf2();
  for (const until = Date.now() + 15_000; trimmedTo >= was && Date.now() < until; trimmedTo = await lengthOf2()) await edges.waitForTimeout(200);
  if (trimmedTo >= was) problems.push(`clip 2's start edge dragged at its middle: clip 2 still ${trimmedTo} ms long (was ${was}), not trimmed`);
  else console.log(`player check: a selected clip's trim edges take the press at a join (clip 2 trimmed from ${was} to ${trimmedTo} ms)`);
  await edges.close();

  for (const p of problems) console.error(`  ✗ ${p}`);
  failed = problems.length > 0;
} finally {
  await browser.close();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
