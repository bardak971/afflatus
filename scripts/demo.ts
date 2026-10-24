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
import { FAKE_GPUS, startFakeComfy, startFakeRunpod, startFakeS3 } from "@afflatus/comfy/testing";
import { nodesOfPack, type Graph, type NodeCatalog } from "@afflatus/core";
import { buildApp } from "../apps/server/src/app";
import { migrate, openSqlite, takeOver } from "../apps/server/src/db";
import { createServices } from "../apps/server/src/services";
import { preflight } from "../apps/server/src/preflight";
import { AfflatusUpdates } from "../apps/server/src/updates";
import { seedRenderTimes } from "./demo-times";
import { seedHistory } from "./demo-history";
import { seedCosts } from "./demo-costs";
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
  // the length in frames is counted at the model's own speed; smoothing doubles the speed, not the length. The longest one
  // asked: a motion window also takes one frame of the clip before (ImageFromBatch's length 1), and made 1 frame long
  const frames = Math.max(0, ...nodes.map((n) => (typeof n.inputs.length === "number" ? n.inputs.length : 0)));
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
// They are listed as a real ComfyUI lists them (card #59): the older name first (unet before diffusion_models), and another
// app's folder shared through extra_model_paths.yaml before ComfyUI's own (an A1111's Lora), so that Download's place and
// its menu show; ComfyUI's own folder is the custom_nodes' parent.
const demoComfy = join(root, "data-demo", "comfy");
const demoModels = join(demoComfy, "models");
const demoOther = join(root, "data-demo", "other-app", "models");
const listedAs: Record<string, string[]> = {
  diffusion_models: [join(demoModels, "unet"), join(demoModels, "diffusion_models")],
  loras: [join(demoOther, "Lora"), join(demoModels, "loras")],
  checkpoints: [join(demoOther, "Stable-diffusion"), join(demoModels, "checkpoints")],
};
const folderPaths = process.env.DEMO_MANAGER === "1" ? undefined : {
  custom_nodes: [join(demoComfy, "custom_nodes")],
  ...Object.fromEntries(["checkpoints", "loras", "vae", "diffusion_models", "text_encoders", "upscale_models"].map((f) => [f, listedAs[f] ?? [join(demoModels, f)]])),
};
for (const dirs of Object.values(folderPaths ?? {})) for (const d of dirs) mkdirSync(d, { recursive: true });

/** The model files of a pretend ComfyUI, less those `lacks` names (a pattern on the file name). */
const lacking = (models: Record<string, string[]>, lacks?: RegExp) => (lacks ? Object.fromEntries(Object.entries(models).map(([k, v]) => [k, v.filter((f) => !lacks.test(f))])) : models);

// DEMO_NO_PACKS=ComfyUI-DaSiWa-Nodes,veda-sparse-attention: the first pretend ComfyUI lacks those node packs (their nodes out
// of its list); its pretend Manager installs them and its restart loads them, as a render that asks for one has done
// (queuePacks.ts: the job waits, Install and restart, Run without)
const noPackNodes = (process.env.DEMO_NO_PACKS ?? "").split(",").map((p) => p.trim()).filter(Boolean).flatMap(nodesOfPack);
const withoutPacks = Object.fromEntries(Object.entries(catalog).filter(([n]) => !noPackNodes.includes(n)));
const packsBack = Object.fromEntries(noPackNodes.flatMap((n) => (catalog[n] ? [[n, catalog[n]!]] : [])));

const pretendComfy = (lacks?: RegExp, first = false) => startFakeComfy({
  catalog: first && noPackNodes.length ? withoutPacks : catalog,
  ...(first && noPackNodes.length ? { afterReboot: packsBack } : {}),
  // a pretend ComfyUI-Manager: "Download" in the demo fetches from the pretend site below
  manager: true,
  folderPaths,
  models: lacking({
    checkpoints, upscale_models: upscalers,
    loras: ["demo-watercolour.safetensors", "demo-film-grain.safetensors", "demo-detail.safetensors", "minimax_h3_turbo_demo.safetensors", "minimax_h3_ref2v_turbo_demo.safetensors", "h3_character_swap_demo.safetensors"],
    // the built-in video recipe finds its files by name: these make it ready in the demo
    diffusion_models: ["minimax_h3_fl2va_demo.safetensors", "minimax_h3_ref2va_demo.safetensors", "SomeoneMinimaxH3_hybridTurboV3_demo.safetensors", "flux-2-klein-base-4b-demo.safetensors", "wan2.2_i2v_high_noise_14B_demo.safetensors", "wan2.2_i2v_low_noise_14B_demo.safetensors"],
    text_encoders: ["qwen3vl_32b_minimax_h3_demo.safetensors", "qwen_3_4b_demo.safetensors", "umt5_xxl_demo.safetensors"],
    vae: ["minimax_h3_video_vae_demo.safetensors", "minimax_h3_audio_vae_demo.safetensors", "flux2-vae-demo.safetensors", "wan_2.1_vae_demo.safetensors"],
    frame_interpolation: ["rife_demo.pth"],
    // H3's Fun ControlNet: Motion transfer's windows moved by their pose
    model_patches: ["minimax_h3_fun_controlnet_union_2.0_demo.safetensors"],
  }, lacks),
  simulate: { stepMs: Number(process.env.DEMO_STEP_MS) || 220, video: pretendClip },
});
const fake = await pretendComfy(undefined, true);
// DEMO_MACHINES=2 (up to 8): as many pretend ComfyUIs, as if this computer had that many GPUs (Settings › ComfyUI, the queue's lanes)
// each with files of its own, so that Settings › Models shows a difference: the second has none of MiniMax H3's models nor
// the Pony checkpoint, the third none of Wan's; the others have everything
const OTHERS_LACK = [/minimax|pony/i, /wan/i];
const others = await Promise.all(Array.from({ length: Math.min(7, Math.max(0, (Number(process.env.DEMO_MACHINES) || 1) - 1)) }, (_x, i) => pretendComfy(OTHERS_LACK[i])));
// the pretend ComfyUIs run this repository's node pack, as one Afflatus wrote it into does: its lock among what can be tried
const PACK = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(join(root, "comfy-nodes", "afflatus-nodes", "pyproject.toml"), "utf-8"))?.[1] ?? null;
for (const f of [fake, ...others]) f.packVersion = PACK;
// and its GPU's power, as the pack reads it on an NVIDIA card: a demo render's electricity in Queue › Costs
for (const f of [fake, ...others]) f.watts = 265;
// DEMO_RUNPOD=1: a pretend RunPod with three pods (two with a pretend ComfyUI and the node pack, one without ComfyUI's
// port), for adding a rented machine or deploying a GPU in Settings › Rented GPUs with the key said at start. A started
// pod takes 8 s to come up; a deployed one 8 s, then 20 s pulling its image (no uptime yet), then 20 s of its boot log
// (start.sh's steps, ComfyUI's start) before its ComfyUI answers
const RUNPOD_KEY = "demo-runpod-key";
const podComfys: Array<Awaited<ReturnType<typeof pretendComfy>>> = [];
const pod = async () => {
  const c = Object.assign(await pretendComfy(), { packVersion: PACK });
  podComfys.push(c);
  return c;
};
// DEMO_POD_DIES=<seconds>: a pod's ComfyUI dies that long into a render, out of system memory, as the Afflatus image says
// it (deploy/runpod/died.py, broken.py "comfy_died"): the render fails with why, the pod is terminated as a crash. Each pod once
const diesAfter = Number(process.env.DEMO_POD_DIES) * 1000;
if (diesAfter > 0) {
  const busySince = new Map<object, number>();
  setInterval(() => {
    for (const c of podComfys) {
      if (c.podDied || !c.running.length) continue;
      const since = busySince.get(c) ?? Date.now();
      busySince.set(c, since);
      if (Date.now() - since < diesAfter) continue;
      const GiB = 2 ** 30;
      c.podDied = {
        error: "ComfyUI was killed: out of system memory (peak 49.8 of 50.0 GB)",
        report: { cause: "oom", signal: 9, exit: null, oom_kills: 1, ram_peak: Math.round(49.8 * GiB), ram_limit: 50 * GiB, vram_used: 30 * GiB, vram_total: 48 * GiB, ran_s: Math.round(diesAfter / 1000) },
      };
      c.bootLog?.lines.push({ t: new Date().toISOString(), m: "[afflatus-pod] ComfyUI ended (status 137)" }, { t: new Date().toISOString(), m: "[afflatus-pod] ComfyUI was killed: out of system memory (peak 49.8 of 50.0 GB)" });
    }
  }, 1000).unref();
}
const pretendRunpod = process.env.DEMO_RUNPOD === "1" ? await startFakeRunpod({
  key: RUNPOD_KEY, bootMs: 8000, pullMs: 20_000, startMs: 20_000,
  // Deploy a GPU: a new pod is a new pretend ComfyUI with the node pack, up as said above; two network volumes, the
  // 5090 mounted on the first (in use while it runs), the second never used
  spawn: pod,
  // the L4's hosts with an older driver only: the Deploy dialog says "12.8 only" of it, and a deploy gets the 12.8 build
  gpus: FAKE_GPUS.map((g) => (g.id === "NVIDIA L4" ? { ...g, cuda13: false } : g)),
  volumes: [{ id: "demo-volume", name: "afflatus-models", size: 100, dataCenter: "EU-RO-1" }, { id: "demo-old", name: "old-loras", size: 50, dataCenter: "US-TX-3" }],
  pods: [
    { name: "comfy-5090", rate: 0.69, gpu: "NVIDIA GeForce RTX 5090", dataCenterId: "EU-RO-1", ports: ["8188/http", "22/tcp"], diskGb: 50, volumeId: "demo-volume", comfy: await pod() },
    { name: "a100-tests", rate: 1.64, gpu: "NVIDIA A100", dataCenterId: "US-TX-3", ports: ["8188/http"], diskGb: 80, comfy: await pod() },
    { name: "jupyter-only", rate: 0.34, gpu: "NVIDIA RTX A4000", dataCenterId: "EU-SE-1", ports: ["8888/http"], diskGb: 20, comfy: await pod() },
  ],
}) : null;
if (pretendRunpod) {
  // its bill written by itself from what the pods run (their GPU and disks, the stopped ones' disks), five minutes late,
  // and the balance going down by it: Queue › Costs and the caps work on it as on RunPod's
  pretendRunpod.autoBill = true;
  pretendRunpod.billLagMs = 5 * 60_000;
  process.env.RUNPOD_API_URL = pretendRunpod.url;
  process.env.RUNPOD_PROXY = "http://127.0.0.1:{id}";
}
// and its S3 API (a volume's Files): the first volume's models folder, some files untouched for weeks; the second volume is
// in a data center RunPod's S3 API does not serve, so its Files say so
const S3_USER = "user_demo";
const S3_SECRET = "rps_demo_secret_0123";
const GB = 2 ** 30;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const pretendS3 = pretendRunpod ? await startFakeS3({
  user: S3_USER,
  volumes: {
    "demo-volume": Object.fromEntries(([
      ["diffusion_models/wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors", 14.3, 2],
      ["diffusion_models/wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors", 14.3, 2],
      ["diffusion_models/qwen_image_edit_2509_fp8_e4m3fn.safetensors", 20.4, 41],
      ["text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors", 6.7, 2],
      ["text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors", 9.4, 41],
      ["checkpoints/illustrious.safetensors", 6.9, 9],
      ["loras/Wan21_I2V_lightx2v_4steps_rank64.safetensors", 0.74, 2],
      ["loras/Qwen-Image-Lightning-8steps-V2.0.safetensors", 0.85, 50],
      ["loras/styles/zz-test watercolor.safetensors", 0.22, 60],
      ["vae/wan_2.1_vae.safetensors", 0.25, 2],
      ["vae/qwen_image_vae.safetensors", 0.25, 41],
      ["upscale_models/4x-UltraSharp.pth", 0.067, 20],
    ] as const).map(([path, gb, days]) => [`comfyui/models/${path}`, { size: Math.round(gb * GB), modified: daysAgo(days) }])),
  },
}) : null;
if (pretendS3) process.env.RUNPOD_S3_URL = pretendS3.url;
// the account's id, which the S3 key's access key is: RunPod tells it with the API key
if (pretendRunpod) pretendRunpod.userId = S3_USER;

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
  // as the real Civitai, the search names the file otherwise than the version's page (`<words>.safetensors` there,
  // `model.safetensors` here) under the same id: a download finds it by that id (card #80)
  const version = (file: string) => ({ id: 1001, name: "v1 (pretend)", baseModel: "Demo", trainedWords: ["demo"], model: { name: "Pretend model" }, files: [{ id: 90001, name: file, type: "Model", primary: true, sizeKB: PRETEND_BYTES / 1024, downloadUrl: `${self}/files/demo` }] });
  if (url.pathname === "/api/v1/models") {
    const file = `${(url.searchParams.get("query") ?? "model").trim().replace(/\s+/g, "_")}.safetensors`;
    return json({ items: [{ id: 501, name: "Pretend model (the demo's Civitai)", type: "Checkpoint", modelVersions: [version(file)] }] });
  }
  // the pretend LoRA's own version (1002, below), else the search's
  if (url.pathname === "/api/v1/model-versions/1002") return json({ ...version("zz-test-pretend-lora.safetensors"), id: 1002, modelId: 777 });
  if (url.pathname.startsWith("/api/v1/model-versions/")) return json(version("model.safetensors"));
  // one model by its id: what a pasted link to a model's page reads (the command bar, Find models)
  if (/^\/api\/v1\/models\/\d+$/.test(url.pathname)) {
    return json({ id: Number(url.pathname.split("/").pop()), name: "Pretend LoRA (the demo's Civitai)", type: "LORA", creator: { username: "demo" }, stats: { downloadCount: 1234, thumbsUpCount: 56 }, modelVersions: [{ ...version("zz-test-pretend-lora.safetensors"), id: 1002, baseModel: "SDXL 1.0" }] });
  }
  // GitHub's latest release, as the updates check reads it (DEMO_RELEASE below)
  if (url.pathname === "/releases/latest" && process.env.DEMO_RELEASE) {
    const v = process.env.DEMO_RELEASE.trim();
    const notes = ["- Pretend highlight one", "- Pretend highlight two", ...(process.env.DEMO_SECURITY ? ["", "Security: a pretend fix, for the demo's banner"] : [])];
    return json({ tag_name: `v${v}`, name: `Afflatus ${v}`, html_url: `${self}/releases/tag/v${v}`, published_at: new Date().toISOString(), prerelease: false, body: notes.join("\n"), assets: [] });
  }
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
// DEMO_RELEASE=0.9.0: the pretend site stands in for GitHub with that release, so that Settings → About can show a new
// version (DEMO_SECURITY=1 marks it a security fix); without it the updates check asks nothing
if (process.env.DEMO_RELEASE) process.env.UPDATES_URL = `http://127.0.0.1:${(pretendSite.address() as AddressInfo).port}/releases/latest`;

// DEMO_DATA=data-demo-2: a data folder of its own, for a second demo beside the first (two on one folder take it from each other)
const dataDir = join(root, process.env.DEMO_DATA ?? "data-demo");
mkdirSync(dataDir, { recursive: true });
const db = openSqlite(takeOver(dataDir));
await migrate(db);
await writeSettings(db, { comfyUrl: fake.url, llm: { baseUrl: llmUrl, model: "pretend-designer", apiKey: "", vision: false } });
if (others.length) {
  const names = ["Studio PC", "Second GPU", "Garage PC", "Cloud", "Office PC", "Laptop", "Rack 1", "Rack 2"];
  await writeSettings(db, { machines: [fake, ...others].map((f, i) => ({ id: `m${i + 1}`, name: names[i]!, url: f.url, dir: "", takes: "all" as const })) });
}

// a few months of pretend render times, so that the "Render times" tab has something to show
await seedRenderTimes(db);
await seedHistory(db);
// a week of pretend pod sessions for Queue › Costs, with the pretend RunPod
if (pretendRunpod) await seedCosts(db);
// the data folder named, as a real start does: the password's reset codes and sign-ins go to its logs/afflatus.log
// the start-up checks as a real start runs them (start.ts): the tools, the Node, this data folder; ffmpeg chosen and said in About
await preflight.run(dataDir);
const services = await createServices(db, "sqlite", new LocalStorage(join(dataDir, "files")), undefined, { dataDir });
// WEB_DIR: another build of the web app than the one `pnpm start` serves
const dist = process.env.WEB_DIR ? join(root, process.env.WEB_DIR) : join(root, "apps/web/dist");
// Afflatus's own updates, for Settings → About: the check asks only a stand-in site (UPDATES_URL), and a restart is said, not done
const updates = new AfflatusUpdates({ services, dataDir, restart: async () => console.log("[demo] an update would restart Afflatus here (exit 75)") });
await updates.init();
const app = buildApp(services, { webDir: existsSync(join(dist, "index.html")) ? dist : undefined, backup: { dataDir, filesDir: join(dataDir, "files") }, updates });
const port = Number(process.env.PORT) || 8720;
await app.listen({ host: "127.0.0.1", port });
await services.queue.start();
if (pretendRunpod) console.log(`Pretend RunPod at ${pretendRunpod.url}: its API key is ${RUNPOD_KEY}`);
if (pretendS3) console.log(`Pretend S3 at ${pretendS3.url}: its S3 API key's secret is ${S3_SECRET}`);
console.log(`Afflatus demo on http://127.0.0.1:${port}  (pretend ComfyUI at ${fake.url}, pretend designer at ${llmUrl}, data in ${process.env.DEMO_DATA ?? "data-demo"}/)`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await app.close();
    await services.close();
    await fake.close();
    await Promise.all(others.map((o) => o.close()));
    pretendLlm.close();
    pretendSite.close();
    process.exit(0);
  });
}
