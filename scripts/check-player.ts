/// <reference lib="dom" />
/**
 * The timeline player, frame by frame (`pnpm check:player`; CI runs it). A throwaway Afflatus (its own temporary data, no
 * ComfyUI) gets H3-shaped synthetic clips chained seamlessly, the second with its sound past its picture as a pod muxes it
 * (apps/server/test/framesKit.ts: each frame shows its clip and index as a barcode), the real editor plays the timeline in headless Chrome, and every frame the player shows is read off
 * the video that is visible at that moment. It fails on a frame shown out of order, a flash of the clip before after the
 * hand-over, a hidden run-up frame shown, or more dropped frames than a busy machine explains. The chain is played again under
 * load (CPU slowed, videos starting late: see playChain), where only the order, flicker and run-up faults count, and twice as
 * Safari's media plays it (its clock, slow seeks, frame callbacks that never come), where a frame held too long at a hand-over
 * (a freeze, which drops nothing) counts too, as it does in the first pass. Then, in a fresh page: Space
 * pressed twice on a clip whose video has not loaded yet must leave it still (it started on its own, with its sound, once
 * its file came), and a range looped (I, O, L) must go back to In at Out, again and again, without playing on past it. Last,
 * a selected clip's trim edges at a join must take a press there (the browser's own hit test), and a drag of one trims.
 *
 * Needs the web app built (`pnpm build`), ffmpeg, and Chrome (or CHROME=<path to a Chromium>). PLAYER_BROWSER=webkit plays it
 * in Playwright's WebKit instead (`pnpm exec playwright-core install webkit` once), Safari's engine but not its media (on
 * Windows it has no frame callbacks and its own clock): the pass under load is then played with late starts only, WebKit
 * having no CPU throttling to ask for.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit, type Page } from "playwright-core";
import { plural } from "@afflatus/core";
import { buildApp } from "../apps/server/src/app";
import { migrate, openSqlite } from "../apps/server/src/db";
import { createServices } from "../apps/server/src/services";
import { writeSettings } from "../apps/server/src/settings";
import { LocalStorage } from "../apps/server/src/storage";
import { lengthOnGrid } from "../apps/server/src/timelineModel";
import { BITS, H, soundPast, synth, W } from "../apps/server/test/framesKit";

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
/**
 * How long one frame may stay up at a hand-over: a frame at 48 a second is up 21 ms, and a busy machine shows one two or
 * three refreshes (up to 56 ms measured). Seeks slower than the pre-roll held the clip before's last frame 320 to 420 ms.
 */
const HELD_MS = 150;
/** How late every video starts in the pass under load (see playChain): past the 70 ms the player first expects (startLag). */
const LATE_PLAY_MS = 100;
/** Every video's play() taking effect LATE_PLAY_MS late, as a loaded machine's media pipeline does. Plain text, as WATCH. */
const LATE_PLAY = `{
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { return new Promise((done) => setTimeout(done, ${LATE_PLAY_MS})).then(() => play.call(this)); };
  }`;

/**
 * The player's frame callbacks never coming, as Safari may do for a video just seeked (WebKit bug 283662): asked for, never
 * called. WATCH keeps the browser's own. Plain text, as WATCH.
 */
const SILENT_FRAMES = `HTMLVideoElement.prototype.requestVideoFrameCallback = function () { return 1; };`;

/** How long a seek takes in the pass with slow seeks (see SLOW_SEEK): past the pre-roll the player gives the clip after. */
const SLOW_SEEK_MS = 350;
/**
 * Every seek taking SLOW_SEEK_MS before the video can play from it, as Safari's exact seek into a take with one keyframe
 * (every take a pod makes) may: a video told to play meanwhile starts only then, and a playing one stops until then. Plain
 * text, as WATCH.
 */
const SLOW_SEEK = `{
    const time = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime");
    const play = HTMLMediaElement.prototype.play;
    const seekAt = new WeakMap();
    Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
      configurable: true,
      get() { return time.get.call(this); },
      set(v) {
        const was = !this.paused;
        seekAt.set(this, performance.now());
        time.set.call(this, v);
        if (was) { this.pause(); setTimeout(() => play.call(this), ${SLOW_SEEK_MS}); }
      },
    });
    HTMLMediaElement.prototype.play = function () {
      const wait = (seekAt.get(this) ?? -1e9) + ${SLOW_SEEK_MS} - performance.now();
      return wait > 0 ? new Promise((done) => setTimeout(done, wait)).then(() => play.call(this)) : play.call(this);
    };
  }`;

/**
 * Every video's currentTime as Safari gives it to the page (WebKit's MediaPlayerPrivateRemote TimeProgressEstimator): the
 * media plays in another process, which says where it is every 100 ms (AVFoundation's periodic observer); in between the
 * page works it out from the clock, never going back, and after a play() or a seek it stays on the moment it was put at
 * until the next report. The frames themselves come as they do. Plain text, as WATCH.
 */
const SAFARI_CLOCK = `{
    const time = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime");
    const play = HTMLMediaElement.prototype.play;
    const told = new WeakMap();
    const put = (v, t, held) => told.set(v, { t, at: performance.now(), held, last: undefined });
    setInterval(() => document.querySelectorAll("video").forEach((v) => { if (!v.paused && !v.seeking) put(v, time.get.call(v), false); }), 100);
    Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
      configurable: true,
      get() {
        const s = told.get(this);
        if (!s || this.paused) return time.get.call(this);
        if (s.held) return s.t;
        const t = Math.min(this.duration || Infinity, Math.max(s.last ?? 0, s.t + ((performance.now() - s.at) / 1000) * this.playbackRate));
        s.last = t;
        return t;
      },
      set(v) { time.set.call(this, v); put(this, v, true); },
    });
    HTMLMediaElement.prototype.play = function () { put(this, time.get.call(this), true); return play.call(this); };
  }`;

/** Safari's user agent, for the passes played as its media (the player tells WebKit by it, useHandover's slowSeeks). */
const SAFARI_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";

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
    // the browser's own, kept before a pass changes the player's (see SAFARI_FRAMES)
    const rvfc = HTMLVideoElement.prototype.requestVideoFrameCallback;
    const watch = (v) => {
      if (watched.has(v)) return;
      watched.add(v);
      const tick = (now) => {
        const seen = v.isConnected && v.style.visibility !== "hidden" && Number(getComputedStyle(v).opacity) > 0.5 && v.offsetWidth > 0;
        if (seen) {
          ctx.drawImage(v, 0, 0, W, H);
          const px = ctx.getImageData(0, 0, W, H).data;
          const word = (y) => { let n = 0; for (let j = 0; j < BITS; j++) if (px[(y * W + j * 16 + 8) * 4] > 128) n += 2 ** j; return n; };
          shown.push({ clip: word(48), index: word(16), at: now });
        }
        next(tick);
      };
      // a browser without the video's own frame callback (Playwright's WebKit) is read at every redraw, a frame repainted
      // there counted once (as everywhere: see playChain)
      const next = rvfc ? (f) => rvfc.call(v, f) : (f) => requestAnimationFrame(f);
      next(tick);
    };
    const all = () => document.querySelectorAll("video").forEach(watch);
    window.__watch = all;
    new MutationObserver(all).observe(document, { subtree: true, childList: true });
  })();`;

/** The frames a page has seen so far, as `WATCH` read them. */
type Shown = { clip: number; index: number; at: number };
const shownIn = (page: Page) => page.evaluate(() => (window as unknown as { __shown: Shown[] }).__shown.slice());

let failed = false;
const inWebkit = process.env.PLAYER_BROWSER === "webkit";
const browser = inWebkit
  ? await webkit.launch({ headless: true })
  : await chromium.launch({
    ...(process.env.CHROME ? { executablePath: process.env.CHROME } : { channel: "chrome" }),
    headless: true,
    args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  });
try {
  // the chain: three clips, each after the first carrying on from the one before, decoded as one piece with it. The second
  // as a pod made it, its sound 134 ms past its picture: handed over at its picture's end, not its sound's (card #207)
  const tl = await call("POST", "/api/timelines", { name: "player check" });
  const assets: string[] = [];
  for (const clip of [1, 2, 3]) {
    const made = synth(clip, FILE, 48);
    const res = await app.inject({ method: "POST", url: `/api/assets?name=c${clip}.mp4`, headers: { "content-type": "video/mp4" }, payload: Buffer.from(clip === 2 ? await soundPast(made, 134) : made) });
    const asset = res.json() as { id: string };
    assets.push(asset.id);
    await db.updateTable("assets").set({ latent_frames: N }).where("id", "=", asset.id).execute();
    await call("POST", `/api/timelines/${tl.id}/clips`, { asset: asset.id });
  }
  // each clip's playing take is sent by its id, found among its takes
  const sent = (await call("GET", `/api/timelines/${tl.id}`)).clips as Array<{ id: string; take: string; takes: Array<{ id: string; asset: { id: string } }> }>;
  const clips = sent.map((c) => ({ id: c.id, take: c.takes.find((x) => x.id === c.take)! }));
  for (let i = 1; i < clips.length; i++) {
    await call("PATCH", `/api/clips/${clips[i]!.id}`, { joined: "continue" });
    // where the clip before ends as the timeline plays it, as a render's plan hands over (plays(before).end)
    const before = await db.selectFrom("assets").selectAll().where("id", "=", assets[i - 1]!).executeTakeFirstOrThrow();
    await db.updateTable("takes").set({ head_ms: 917, join_kind: "seamless", prev_take_id: clips[i - 1]!.take.id, prev_at_ms: lengthOnGrid(before) }).where("id", "=", clips[i]!.take.id).execute();
  }

  /**
   * The chain played from its start in a page of its own: the frames seen, consecutive repeats of one frame as one (a
   * repaint). `loaded` plays it as on a machine busy elsewhere (a render running, a CI runner): the page's CPU four times
   * slower, and every video starting LATE_PLAY_MS after it is told to play. CPU throttling alone leaves the decoder (another
   * process) as fast and passed; the late start is what a loaded machine does to the clip after, which then runs behind its
   * start at the cut (the 0.6.0 release run showed a run-up frame so, card #48). `safari` plays it as Safari's media does
   * (SAFARI_CLOCK and SLOW_SEEK), with its frame callbacks never coming too when `silent` (SILENT_FRAMES).
   */
  const playChain = async (loaded: boolean, as: { safari?: boolean; silent?: boolean } = {}) => {
    // as Safari, the player is told it is on WebKit too (SAFARI_UA): it seeks the clip after ahead only there
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, ...(as.safari && !inWebkit ? { userAgent: SAFARI_UA } : {}) });
    await page.addInitScript(WATCH);
    if (as.safari) {
      await page.addInitScript(SAFARI_CLOCK);
      await page.addInitScript(SLOW_SEEK);
    }
    if (as.silent) await page.addInitScript(SILENT_FRAMES);
    if (loaded) {
      await page.addInitScript(LATE_PLAY);
      if (!inWebkit) await (await page.context().newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: 4 });
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
   * `early`: frames of the run-up let through, for a cut made on the clock (no frame callbacks), "a frame early rather than
   * late" by design (useHandover CUT_EARLY_MS).
   */
  const orderFaults = (seen: Shown[], under: string, early = 0) => {
    const landed: number[] = [];
    for (let i = 1; i < seen.length; i++) {
      const a = seen[i - 1]!;
      const b = seen[i]!;
      if (b.clip < a.clip) problems.push(`${under}clip ${a.clip} frame ${a.index} → clip ${b.clip} frame ${b.index}: the clip before shows again after the hand-over (a flicker)`);
      else if (b.clip === a.clip && b.index <= a.index) problems.push(`${under}clip ${b.clip}: frame ${a.index} then ${b.index}, out of order (a duplicated or repeated stretch)`);
      else if (b.clip !== a.clip) {
        landed.push(b.index);
        if (b.index < RUN_UP_LAST - early) problems.push(`${under}clip ${b.clip} starts at frame ${b.index}: a frame of its hidden run-up is shown`);
      }
    }
    const clipsSeen = [...new Set(seen.map((f) => f.clip))];
    if (clipsSeen.join() !== "1,2,3") problems.push(`${under}clips seen: ${clipsSeen.join(", ") || "none"} (expected 1, 2, 3)`);
    return landed;
  };

  /**
   * The longest any frame stayed up around each hand-over (from the clip before's last second to the clip after's first),
   * in ms, by when each frame was first presented: a freeze there, the clip before held on its last frame or the clip after
   * stalled by a seek, shows every frame in order and drops none, and only its time tells it.
   */
  const heldAround = (seen: Shown[]) => [1, 2].map((clip) => {
    let most = 0;
    for (let i = 1; i < seen.length; i++) {
      const a = seen[i - 1]!;
      const b = seen[i]!;
      const near = (a.clip === clip && a.index >= LAST_SECOND) || (a.clip === clip + 1 && a.index < RUN_UP_LAST + 48);
      if (near && b.clip <= clip + 1) most = Math.max(most, b.at - a.at);
    }
    return Math.round(most);
  });
  /** A frame held past HELD_MS at a hand-over is a fault (a warning on a CI runner, as the drops); says the longest. */
  const heldFaults = (seen: Shown[], under: string) => {
    const held = heldAround(seen);
    held.forEach((ms, i) => {
      if (ms <= HELD_MS) return;
      const said = `${under}a frame stayed up ${ms} ms at the hand-over from clip ${i + 1} to ${i + 2} (at most ${HELD_MS}): a freeze`;
      if (process.env.CI) console.log(`::warning::player check: ${said} (a slow runner, not failed in CI)`);
      else problems.push(said);
    });
    return held;
  };
  const seen = await playChain(false);
  orderFaults(seen, "");
  console.log(`  longest a frame stayed up around the hand-overs: ${heldFaults(seen, "").join(" ms, ")} ms`);
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

  // ---- the chain as Safari plays it (its clock, its slow seeks), then with its frame callbacks never coming too: the
  // hand-overs in order and past the run-up, and no freeze at them (the owner saw freezes and jumps in Safari, 2026-11-10)
  for (const silent of [false, true]) {
    const under = silent ? "as Safari, no frame callbacks: " : "as Safari: ";
    const played = await playChain(false, { safari: true, silent });
    const where = orderFaults(played, under, silent ? 1 : 0);
    console.log(`player check, ${under}landed on frames ${where.join(", ") || "none"}, the longest a frame stayed up ${heldFaults(played, under).join(" ms, ")} ms`);
  }

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
