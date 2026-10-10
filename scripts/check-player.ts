/// <reference lib="dom" />
/**
 * The timeline player, frame by frame (`pnpm check:player`; CI runs it). A throwaway Afflatus (its own temporary data, no
 * ComfyUI) gets H3-shaped synthetic clips chained seamlessly (apps/server/test/framesKit.ts: each frame shows its clip and
 * index as a barcode), the real editor plays the timeline in headless Chrome, and every frame the player shows is read off
 * the video that is visible at that moment. It fails on a frame shown out of order, a flash of the clip before after the
 * hand-over, a hidden run-up frame shown, or more dropped frames than a busy machine explains.
 *
 * Needs the web app built (`pnpm build`), ffmpeg, and Chrome (or CHROME=<path to a Chromium>).
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
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
 * few percent are the machine. Drops gathered in the last second before a hand-over are said (the next clip pre-rolls under
 * the one seen, two decodes at once: measured 2026-10-08, frames 215–245 of a 247-frame clip), not failed.
 */
const DROPS_ALLOWED = 0.1;
const LAST_SECOND = FILE - 48;

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
  const clips = (await call("GET", `/api/timelines/${tl.id}`)).clips as Array<{ id: string; take: { id: string } }>;
  for (let i = 1; i < clips.length; i++) {
    await call("PATCH", `/api/clips/${clips[i]!.id}`, { joined: "continue" });
    await db.updateTable("takes").set({ head_ms: 917, join_kind: "seamless", prev_take_id: clips[i - 1]!.take.id, prev_at_ms: Math.round((N * 1000) / 24) }).where("id", "=", clips[i]!.take.id).execute();
  }

  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  // every frame a video presents, read off it when it is the one seen (the hidden pre-roll is near transparent). Plain text:
  // a function passed here would be compiled with helpers (esbuild's __name) the page does not have
  await page.addInitScript(`(() => {
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
  })();`);

  await page.goto(`${base}/timelines/${tl.id}`);
  await page.waitForFunction(() => document.querySelectorAll("video").length > 0, null, { timeout: 30_000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => (window as unknown as { __watch: () => void }).__watch());
  await page.locator("body").press("Space");
  // the whole chain, and a margin
  await page.waitForTimeout(16_500);
  const raw = await page.evaluate(() => (window as unknown as { __shown: Array<{ clip: number; index: number }> }).__shown);

  // what was seen: consecutive repeats of one frame are one frame (a repaint)
  const seen = raw.filter((f, i) => !(i && raw[i - 1]!.clip === f.clip && raw[i - 1]!.index === f.index));
  const problems: string[] = [];
  let drops = 0;
  const gaps: string[] = [];
  for (let i = 1; i < seen.length; i++) {
    const a = seen[i - 1]!;
    const b = seen[i]!;
    if (b.clip < a.clip) problems.push(`clip ${a.clip} frame ${a.index} → clip ${b.clip} frame ${b.index}: the clip before shows again after the hand-over (a flicker)`);
    else if (b.clip === a.clip && b.index <= a.index) problems.push(`clip ${b.clip}: frame ${a.index} then ${b.index}, out of order (a duplicated or repeated stretch)`);
    else if (b.clip === a.clip) {
      drops += b.index - a.index - 1;
      if (b.index - a.index > 1) gaps.push(`${b.clip}:${a.index + 1}${b.index - a.index > 2 ? `–${b.index - 1}` : ""}`);
    }
    else {
      // a hand-over: the clip before to its last frame, the next from the frame after its hidden run-up
      if (b.index < RUN_UP_LAST) problems.push(`clip ${b.clip} starts at frame ${b.index}: a frame of its hidden run-up is shown`);
      drops += Math.max(0, FILE - 1 - a.index) + Math.max(0, b.index - RUN_UP_LAST);
    }
  }
  const clipsSeen = [...new Set(seen.map((f) => f.clip))];
  if (clipsSeen.join() !== "1,2,3") problems.push(`clips seen: ${clipsSeen.join(", ") || "none"} (expected 1, 2, 3)`);
  const expected = FILE + 2 * (FILE - RUN_UP_LAST);
  // A GitHub runner (two cores, no GPU) drops about a third of the frames evenly, measured 2026-10-10 against 4% on a
  // desktop, so there the drop count is a warning; the order, flicker and run-up faults still fail everywhere.
  if (drops > expected * DROPS_ALLOWED) {
    if (process.env.CI) console.log(`::warning::player check: ${drops} of ${expected} frames dropped (a slow runner, not failed in CI)`);
    else problems.push(`${drops} of ${expected} frames dropped`);
  }
  console.log(`player check: ${seen.length} frames seen of ${expected}, ${drops} dropped${problems.length ? "" : ", every hand-over clean"}`);
  if (gaps.length) console.log(`  dropped (clip:frame): ${gaps.join(" ")}`);
  const late = gaps.filter((g) => Number(g.split(":")[1]!.split("–")[0]) >= LAST_SECOND && Number(g.split(":")[0]) < 3).length;
  if (late && late >= gaps.length / 2) console.log(`  ! ${late} of ${gaps.length} drops fall in the last second before a hand-over: the next clip pre-rolling under the one seen`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  failed = problems.length > 0;
} finally {
  await browser.close();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
