/**
 * The real Afflatus, with a pretend ComfyUI behind it: renders take a few seconds and give coloured
 * placeholder pictures. For trying the app, and working on it, without a GPU. It never contacts a real
 * ComfyUI: the address in the demo's settings is set to the pretend one on every start.
 *   pnpm demo            then open http://127.0.0.1:8720 (after `pnpm build`), or run the web app's dev server
 */
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeComfy } from "@afflatus/comfy/testing";
import type { Graph, NodeCatalog } from "@afflatus/core";
import { buildApp } from "../apps/server/src/app";
import { migrate, openSqlite, takeOver } from "../apps/server/src/db";
import { createServices } from "../apps/server/src/services";
import { seedRenderTimes } from "./demo-times";
import { seedHistory } from "./demo-history";
import { writeSettings } from "../apps/server/src/settings";
import { LocalStorage } from "../apps/server/src/storage";
import { mkdirSync } from "node:fs";

const root = fileURLToPath(new URL("..", import.meta.url));
const catalog = JSON.parse(readFileSync(join(root, "reference/comfy-object-info.json"), "utf-8")) as NodeCatalog;
const checkpoints = ["demo-illustrious.safetensors", "demo-pony.safetensors"];
const upscalers = ["demo-upscaler-4x.pth"];
catalog.CheckpointLoaderSimple!.input.required!.ckpt_name = [checkpoints];
catalog.UpscaleModelLoader!.input.required!.model_name = ["COMBO", { options: upscalers }];
// what the picture tools pick from: a face finder and a model that finds the background
catalog.UltralyticsDetectorProvider!.input.required!.model_name = [["bbox/face_yolov8m.pt", "bbox/hand_yolov8s.pt"]];
catalog.LoadBackgroundRemovalModel!.input.required!.bg_removal_name = ["COMBO", { options: ["demo-birefnet.safetensors"] }];

/**
 * What a video prompt "renders": a test pattern of the size, the length and the speed that were asked
 * for, tinted by the seed so that two takes look different, with a tone. Made with ffmpeg when it is installed.
 */
let warned = false;
function pretendClip(graph: Graph, seed: number): Uint8Array | undefined {
  const nodes = Object.values(graph);
  const sized = [...nodes].reverse().find((n) => typeof n.inputs.width === "number" && typeof n.inputs.height === "number");
  const even = (n: unknown, fallback: number) => Math.max(64, Math.round((Number(n) || fallback) / 2) * 2);
  const width = even(sized?.inputs.width, 832);
  const height = even(sized?.inputs.height, 480);
  const out = nodes.find((n) => /VideoCombine/.test(n.class_type));
  const fps = Math.round(Number(out?.inputs.frame_rate) || 16);
  // the length in frames is counted at the model's own speed; smoothing doubles the speed, not the length
  const frames = Number(nodes.find((n) => typeof n.inputs.length === "number")?.inputs.length) || 0;
  const base = nodes.some((n) => /FrameInterpolate/.test(n.class_type)) ? fps / 2 : fps;
  const seconds = frames ? (frames / base).toFixed(3) : "4";
  const file = join(tmpdir(), `afflatus-demo-clip-${process.pid}.mp4`);
  const made = spawnSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", `testsrc2=size=${width}x${height}:rate=${fps}:duration=${seconds},hue=h=${seed % 360}`,
    "-f", "lavfi", "-i", `sine=frequency=${220 + (seed % 12) * 30}:duration=${seconds}`,
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file,
  ]);
  if (made.status !== 0) {
    if (!warned) console.log("ffmpeg was not found: videos fail in this demo, pictures work");
    warned = true;
    return undefined;
  }
  const bytes = new Uint8Array(readFileSync(file));
  rmSync(file, { force: true });
  return bytes;
}

// the models the video workflows load are listed, so that one the demo does not have shows as missing and can be fetched
catalog.UNETLoader!.input.required!.unet_name = [["minimax_h3_fl2va_demo.safetensors", "minimax_h3_ref2va_demo.safetensors", "SomeoneMinimaxH3_hybridTurboV3_demo.safetensors", "flux-2-klein-base-4b-demo.safetensors", "wan2.2_i2v_high_noise_14B_demo.safetensors", "wan2.2_i2v_low_noise_14B_demo.safetensors"]];

// the pretend ComfyUI's model folders on disk, in the demo's data folder: "Download" in the demo writes there, as
// Afflatus does into a ComfyUI on the same machine (DEMO_MANAGER=1 leaves them out: the download then goes through Manager)
const demoModels = join(root, "data-demo", "comfy-models");
const folderPaths = process.env.DEMO_MANAGER === "1" ? undefined : Object.fromEntries(
  ["checkpoints", "loras", "vae", "diffusion_models", "text_encoders", "upscale_models"].map((f) => {
    mkdirSync(join(demoModels, f), { recursive: true });
    return [f, [join(demoModels, f)]];
  }),
);

const fake = await startFakeComfy({
  catalog,
  // a pretend ComfyUI-Manager: "Download" in the demo fetches from the pretend site below
  manager: true,
  folderPaths,
  models: {
    checkpoints, upscale_models: upscalers,
    loras: ["demo-watercolour.safetensors", "demo-film-grain.safetensors", "demo-detail.safetensors", "minimax_h3_turbo_demo.safetensors", "minimax_h3_ref2v_turbo_demo.safetensors"],
    // the built-in video recipe finds its files by name: these make it ready in the demo
    diffusion_models: ["minimax_h3_fl2va_demo.safetensors", "minimax_h3_ref2va_demo.safetensors", "SomeoneMinimaxH3_hybridTurboV3_demo.safetensors", "flux-2-klein-base-4b-demo.safetensors", "wan2.2_i2v_high_noise_14B_demo.safetensors", "wan2.2_i2v_low_noise_14B_demo.safetensors"],
    text_encoders: ["qwen3vl_32b_minimax_h3_demo.safetensors", "qwen_3_4b_demo.safetensors", "umt5_xxl_demo.safetensors"],
    vae: ["minimax_h3_video_vae_demo.safetensors", "minimax_h3_audio_vae_demo.safetensors", "flux2-vae-demo.safetensors", "wan_2.1_vae_demo.safetensors"],
    frame_interpolation: ["rife_demo.pth"],
  },
  simulate: { stepMs: Number(process.env.DEMO_STEP_MS) || 220, video: pretendClip },
});

/**
 * A pretend language model for the designer: it answers in the designer's format with what it was told,
 * dressed up a little, so that the conversation can be tried without a real model. It writes nothing clever.
 * To see how the designer copes with a model that misbehaves: a message with a question mark is answered
 * and nothing is changed; "claim" has it say it changed the text and send none; "fragment" has it send one
 * line in place of the whole text.
 */
const pretendLlm = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}") as { messages?: Array<{ role: string; content: unknown }> };
  const system = String(body.messages?.[0]?.content ?? "");
  const last = body.messages?.at(-1)?.content;
  const said = typeof last === "string" ? last : (last as Array<{ text?: string }> | undefined)?.find((p) => p.text)?.text ?? "";
  const parts = [...system.matchAll(/^- ([\w.]+): "/gm)].map((m) => m[1]!);
  const main = parts[0] ?? "prompt";
  const now = new RegExp(`^${main}: (.*)$`, "m").exec(system.split("WHAT IS WRITTEN NOW")[1] ?? "")?.[1] ?? "";
  const clips = Number(/PLAN a longer video as (\d+) clips/.exec(system)?.[1] ?? 0);
  const text = clips
    ? `kind: plan\nnote: (pretend designer) ${clips} clips from your idea.\n${Array.from({ length: clips }, (_x, i) => `CLIP ${i + 1}\n${main}: Part ${i + 1} of ${clips}: ${said}`).join("\n")}`
    : /^ready|single word/i.test(said)
      ? "ready"
      : /\bclaim\b/i.test(said) || /carried no new text/.test(said)
        ? "kind: proposal\nnote: (pretend designer) I rewrote the whole prompt as you asked."
        : /\bfragment\b/i.test(said) || /reads as a fragment/.test(said)
          ? `kind: proposal\n${main}: Only this line.\nnote: (pretend designer) I changed one line.`
          : /\?\s*$/.test(said)
            ? `kind: answer\nnote: (pretend designer) Yes. What is written now is ${now && now !== "(empty)" ? `"${now.slice(0, 80)}"` : "nothing yet"}. Here are three ways it could go.\noptions: make it warmer | add a second person | change the place`
            : `kind: proposal\n${main}: ${now && now !== "(empty)" ? `${now} ` : ""}${said.replace(/\.?$/, ".")}\nnote: (pretend designer) I worked "${said}" into it.\noptions: even more | shorter | another angle`;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
});
await new Promise<void>((resolve) => pretendLlm.listen(0, "127.0.0.1", resolve));
const llmUrl = `http://127.0.0.1:${(pretendLlm.address() as AddressInfo).port}/v1`;

/**
 * A pretend Civitai, and the place its files come from: it "has" whatever file it is asked for, 48 MB of
 * nothing sent over a few seconds, so that looking a missing file up and fetching it can be tried. It resumes
 * from a byte (Range). DEMO_DOWNLOAD_MB makes the file larger and sends it as fast as it can; DEMO_DOWNLOAD_CUTS=n
 * cuts the connection at 30% and at 60% of the file, n times in all, to see a download picked up again.
 */
const PRETEND_BYTES = (Number(process.env.DEMO_DOWNLOAD_MB) || 48) * 2 ** 20;
const PRETEND_FAST = Boolean(process.env.DEMO_DOWNLOAD_MB);
let pretendCuts = Number(process.env.DEMO_DOWNLOAD_CUTS) || 0;
const PATTERN = Buffer.from(Array.from({ length: 2 ** 20 + 251 }, (_x, i) => i % 251));
// it starts as a safetensors file does (its header's length, then the header), or Afflatus refuses it before naming it
const HEAD = Buffer.concat([Buffer.alloc(8), Buffer.from("{}")]);
HEAD.writeBigUInt64LE(2n);
const pretendSite = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://site");
  const self = `http://127.0.0.1:${(pretendSite.address() as AddressInfo).port}`;
  const json = (value: unknown) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value));
  };
  const version = (file: string) => ({ id: 1001, name: "v1 (pretend)", baseModel: "Demo", trainedWords: ["demo"], model: { name: "Pretend model" }, files: [{ name: file, type: "Model", primary: true, sizeKB: PRETEND_BYTES / 1024, downloadUrl: `${self}/files/demo` }] });
  if (url.pathname === "/api/v1/models") {
    const file = `${(url.searchParams.get("query") ?? "model").trim().replace(/\s+/g, "_")}.safetensors`;
    return json({ items: [{ id: 501, name: "Pretend model (the demo's Civitai)", type: "Checkpoint", modelVersions: [version(file)] }] });
  }
  if (url.pathname.startsWith("/api/v1/model-versions/")) return json(version("model.safetensors"));
  if (url.pathname === "/files/demo") {
    const from = Math.min(PRETEND_BYTES, Number(/^bytes=(\d+)-$/.exec(req.headers.range ?? "")?.[1] ?? 0));
    res.writeHead(from ? 206 : 200, { "Content-Type": "application/octet-stream", "Content-Length": PRETEND_BYTES - from, ...(from ? { "Content-Range": `bytes ${from}-${PRETEND_BYTES - 1}/${PRETEND_BYTES}` } : {}) });
    // where this answer is cut, when cuts are asked for: the next of 30% and 60% past where it starts
    const cutAt = pretendCuts > 0 ? [0.3, 0.6].map((f) => Math.floor(PRETEND_BYTES * f)).find((at) => at > from) : undefined;
    for (let sent = from; sent < PRETEND_BYTES && !res.destroyed; sent += 2 ** 20) {
      if (cutAt !== undefined && sent >= cutAt) {
        pretendCuts--;
        res.socket?.destroy();
        return;
      }
      // byte n of the file is n % 251 past its first ten: a piece put in the wrong place shows
      let piece = PATTERN.subarray(sent % 251, sent % 251 + Math.min(2 ** 20, PRETEND_BYTES - sent));
      if (sent < HEAD.length) piece = Buffer.concat([HEAD.subarray(sent), piece.subarray(HEAD.length - sent)]);
      // as fast as the disk takes it for a large file; slowly for the 48 MB one, so that its progress shows
      if (!res.write(piece)) await new Promise((r) => (res.once("drain", r), res.once("close", r)));
      if (!PRETEND_FAST) await new Promise((r) => setTimeout(r, 120));
    }
    return res.end();
  }
  res.writeHead(404);
  res.end();
});
await new Promise<void>((resolve) => pretendSite.listen(0, "127.0.0.1", resolve));
process.env.CIVITAI_URL = `http://127.0.0.1:${(pretendSite.address() as AddressInfo).port}`;
// the pretend site is plain http, and no real site is asked in its place (civitai.ts pretendSites)
process.env.AFFLATUS_PRETEND_SITES = "1";

const dataDir = join(root, "data-demo");
mkdirSync(dataDir, { recursive: true });
const db = openSqlite(takeOver(dataDir));
await migrate(db);
await writeSettings(db, { comfyUrl: fake.url, llm: { baseUrl: llmUrl, model: "pretend-designer", apiKey: "", vision: false } });

// a few months of pretend render times, so that the "Render times" tab has something to show
await seedRenderTimes(db);
await seedHistory(db);
const services = await createServices(db, "sqlite", new LocalStorage(join(dataDir, "files")));
// WEB_DIR: another build of the web app than the one `pnpm start` serves
const dist = process.env.WEB_DIR ? join(root, process.env.WEB_DIR) : join(root, "apps/web/dist");
const app = buildApp(services, { webDir: existsSync(join(dist, "index.html")) ? dist : undefined, backup: { dataDir, filesDir: join(dataDir, "files") } });
const port = Number(process.env.PORT) || 8720;
await app.listen({ host: "127.0.0.1", port });
await services.queue.start();
console.log(`Afflatus demo on http://127.0.0.1:${port}  (pretend ComfyUI at ${fake.url}, pretend designer at ${llmUrl}, data in data-demo/)`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await app.close();
    await services.close();
    await fake.close();
    pretendLlm.close();
    pretendSite.close();
    process.exit(0);
  });
}
