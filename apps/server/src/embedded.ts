import { execFile } from "node:child_process";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { modelStem } from "@afflatus/core";
import { localInputs, tools } from "./video";

/**
 * What a picture or a video carries inside it about how it was made:
 *  - A1111 / Forge / Civitai: the "parameters" text (a PNG text chunk, or EXIF UserComment in JPEG and WebP);
 *  - ComfyUI: the graph that ran ("prompt") and the workflow as the editor shows it ("workflow"), in PNG
 *    text chunks, or in the tags of a video it saved.
 * From these come two things: settings that can fill a form, and a workflow that can be imported.
 */

/** Settings read from a file, in Afflatus's own terms. Model and LoRAs are names, not yet files of a ComfyUI. */
export interface FoundSettings {
  source: "a1111" | "comfyui";
  prompt: string;
  negative: string;
  /** The checkpoint's name without folder or extension. */
  checkpoint?: string;
  loras: Array<{ name: string; weight: number; /** Its Civitai version, when the file says. */ civitai?: number }>;
  steps?: number;
  cfg?: number;
  /** ComfyUI's names. */
  sampler?: string;
  scheduler?: string;
  seed?: number;
  clipSkip?: number;
  width?: number;
  height?: number;
  hires?: { scale?: number; upscaler?: string; denoise?: number; steps?: number };
  /** The checkpoint's Civitai version, when the file says. */
  checkpointCivitai?: number;
  /** What could not be carried over, in words. */
  notes: string[];
}

export interface Embedded {
  settings: FoundSettings | null;
  /** A ComfyUI workflow: the editor's own form when the file has it, else the graph that ran. */
  workflow: unknown | null;
  /** Why there are no settings, when there are none. */
  why?: string;
}

// ---------------------------------------------------------------- containers

/**
 * How much a PNG's compressed text may unpack to, per chunk and in all. A stranger's file can carry a
 * few kilobytes that unpack to gigabytes (a "decompression bomb"); a ComfyUI workflow is far smaller
 * than this, and a chunk past it is not read.
 */
const TEXT_CHUNK_MAX = 1 << 20;
const TEXT_TOTAL_MAX = 4 << 20;

/** PNG tEXt / zTXt / iTXt chunks, by keyword. */
function pngText(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return out;
  let left = TEXT_TOTAL_MAX;
  const inflate = (raw: Buffer): Buffer => {
    // past the limit inflateSync throws, and the chunk is skipped like a broken one
    const text = inflateSync(raw, { maxOutputLength: Math.max(1, Math.min(TEXT_CHUNK_MAX, left)) });
    left -= text.length;
    return text;
  };
  let pos = 8;
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === "IEND") break;
    const nul = data.indexOf(0);
    if (nul < 0) continue;
    const key = data.toString("latin1", 0, nul);
    try {
      if (type === "tEXt") out[key] = data.toString("utf8", nul + 1);
      else if (type === "zTXt") out[key] = inflate(data.subarray(nul + 2)).toString("utf8");
      else if (type === "iTXt") {
        const compressed = data[nul + 1] === 1;
        let p = nul + 3;
        p = data.indexOf(0, p) + 1; // language tag
        p = data.indexOf(0, p) + 1; // translated keyword
        const raw = data.subarray(p);
        out[key] = (compressed ? inflate(raw) : raw).toString("utf8");
      }
    } catch {
      /* a broken chunk just is not read */
    }
  }
  return out;
}

/** The EXIF block of a JPEG (APP1) or a WebP (EXIF chunk), without a picture library. */
function exifOf(buf: Buffer): Buffer | null {
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let pos = 2;
    while (pos + 4 <= buf.length && buf[pos] === 0xff) {
      const marker = buf[pos + 1]!;
      const len = buf.readUInt16BE(pos + 2);
      if (marker === 0xe1 && buf.toString("latin1", pos + 4, pos + 10) === "Exif\0\0") return buf.subarray(pos + 4, pos + 2 + len);
      if (marker === 0xda) break;
      pos += 2 + len;
    }
    return null;
  }
  if (buf.length > 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") {
    let pos = 12;
    while (pos + 8 <= buf.length) {
      const id = buf.toString("latin1", pos, pos + 4);
      const len = buf.readUInt32LE(pos + 4);
      if (id === "EXIF") return buf.subarray(pos + 8, pos + 8 + len);
      pos += 8 + len + (len % 2);
    }
  }
  return null;
}

/** EXIF UserComment (tag 0x9286): where A1111 puts its text for JPEG and WebP. */
function exifUserComment(exif: Buffer): string | null {
  const start = exif.indexOf("Exif\0\0") === 0 ? 6 : 0;
  const t = exif.subarray(start);
  if (t.length < 8) return null;
  const le = t.toString("latin1", 0, 2) === "II";
  const u16 = (o: number) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o: number) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  const findTag = (ifd: number, tag: number): { count: number; off: number } | null => {
    if (ifd + 2 > t.length) return null;
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (e + 12 > t.length) return null;
      if (u16(e) === tag) return { count: u32(e + 4), off: u32(e + 8) };
    }
    return null;
  };
  const exifIfd = findTag(u32(4), 0x8769);
  const uc = exifIfd ? findTag(exifIfd.off, 0x9286) : null;
  if (!uc || uc.count <= 8 || uc.off + uc.count > t.length) return null;
  const head = t.toString("latin1", uc.off, uc.off + 8);
  const body = t.subarray(uc.off + 8, uc.off + uc.count);
  if (head.startsWith("UNICODE")) {
    // written big-endian by some tools and little-endian by others: whichever reads as text
    const be = Buffer.from(body).swap16().toString("utf16le");
    const lev = body.toString("utf16le");
    const printable = (x: string) => (x.match(/[\x20-\x7e\n]/g)?.length ?? 0) / Math.max(1, x.length);
    return (printable(be) >= printable(lev) ? be : lev).replace(/\0+$/, "");
  }
  return body.toString("utf8").replace(/\0+$/, "");
}

/** The tags of a video or sound file on disk, read with ffprobe, their names in lower case. Empty when ffprobe is not installed. */
async function tagsOfFile(file: string): Promise<Record<string, string>> {
  try {
    const out = await new Promise<string>((done) => {
      execFile(tools.ffprobe, localInputs(["-v", "error", "-show_entries", "format_tags", "-of", "json", file]), { encoding: "utf8", timeout: 30_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout) => done(err ? "" : stdout));
    });
    const tags = (JSON.parse(out || "{}") as { format?: { tags?: Record<string, string> } }).format?.tags ?? {};
    return Object.fromEntries(Object.entries(tags).map(([k, v]) => [k.toLowerCase(), v]));
  } catch {
    return {};
  }
}

/** The same for a file in memory, written to a temporary folder for ffprobe. */
async function mediaTags(bytes: Uint8Array): Promise<Record<string, string>> {
  const dir = await mkdtemp(join(tmpdir(), "afflatus-tags-"));
  try {
    const file = join(dir, "in.bin");
    await writeFile(file, bytes);
    return await tagsOfFile(file);
  } catch {
    return {};
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------- A1111 text

/** Only real model extensions: "Slider_v1.0" keeps its ".0". */
export const stemOf = modelStem;

/** `<lora:name:w>` tags, taken out of the text into a list. */
function splitLoras(prompt: string): { text: string; loras: Array<{ name: string; weight: number }> } {
  const loras: Array<{ name: string; weight: number }> = [];
  const text = prompt
    .replace(/<(?:lora|lyco):([^:>]+)(?::(-?[\d.]+))?(?::[^>]*)?>/gi, (_m, name: string, w?: string) => {
      loras.push({ name: stemOf(name.trim()), weight: w !== undefined && Number.isFinite(Number(w)) ? Number(w) : 1 });
      return "";
    })
    .replace(/\s*,\s*(,\s*)+/g, ", ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[\s,]+|[\s,]+$/g, "");
  return { text, loras };
}

/** Cut a `Key: [ … ]` or `Key: { … }` JSON value out of the settings line (Civitai writes these; a plain split on commas would break them). */
function takeJson(line: string, key: string): { value: unknown; rest: string } | null {
  const i = line.indexOf(`${key}: `);
  if (i < 0) return null;
  const j = i + key.length + 2;
  const open = line[j];
  if (open !== "[" && open !== "{") return null;
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inStr = false;
  for (let k = j; k < line.length; k++) {
    const c = line[k];
    if (inStr) {
      if (c === "\\") k++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) {
      try {
        return { value: JSON.parse(line.slice(j, k + 1)), rest: line.slice(0, i) + line.slice(k + 1).replace(/^\s*,\s*/, "") };
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** A1111's sampler names → ComfyUI's. A name that ends in a schedule ("DPM++ 2M Karras") carries it. */
const SAMPLERS: Record<string, string> = {
  "euler a": "euler_ancestral", euler: "euler", "euler cfg++": "euler_cfg_pp", "euler a cfg++": "euler_ancestral_cfg_pp", lms: "lms", heun: "heun",
  dpm2: "dpm_2", "dpm2 a": "dpm_2_ancestral", "dpm++ 2s a": "dpmpp_2s_ancestral", "dpm++ 2m": "dpmpp_2m", "dpm++ sde": "dpmpp_sde",
  "dpm++ 2m sde": "dpmpp_2m_sde", "dpm++ 2m sde heun": "dpmpp_2m_sde", "dpm++ 3m sde": "dpmpp_3m_sde", "dpm fast": "dpm_fast", "dpm adaptive": "dpm_adaptive",
  ddim: "ddim", "ddim cfg++": "ddim", plms: "euler", unipc: "uni_pc", lcm: "lcm", restart: "restart", "ddpm": "ddpm",
};
const SCHEDULES: Record<string, string> = {
  karras: "karras", exponential: "exponential", "sgm uniform": "sgm_uniform", simple: "simple", normal: "normal", uniform: "normal", ddim: "ddim_uniform", beta: "beta",
  "kl optimal": "kl_optimal", "align your steps": "normal", automatic: "normal", polyexponential: "exponential",
};
function samplerOf(name: string | undefined, schedule: string | undefined): { sampler?: string; scheduler?: string } {
  if (!name) return {};
  let s = name.trim().toLowerCase();
  let from: string | undefined;
  for (const tail of ["karras", "exponential", "sgm uniform", "beta"]) {
    if (s.endsWith(` ${tail}`)) {
      from = tail;
      s = s.slice(0, -tail.length - 1);
    }
  }
  // ComfyUI's own names, written by Civitai as "<sampler>_<scheduler>": the end that is a scheduler is one
  let tail: string | undefined;
  if (!SAMPLERS[s] && /^[a-z0-9_]+$/.test(s)) {
    tail = ["sgm_uniform", "ddim_uniform", "linear_quadratic", "kl_optimal", "exponential", "karras", "simple", "normal", "beta"].find((x) => s.endsWith(`_${x}`));
    if (tail) s = s.slice(0, -tail.length - 1);
  }
  const sampler = SAMPLERS[s] ?? (/^[a-z0-9_]+$/.test(s) ? s : undefined);
  const scheduler = SCHEDULES[(schedule ?? "").trim().toLowerCase()] ?? (from ? SCHEDULES[from] : undefined) ?? tail;
  return { sampler, scheduler };
}

/** A1111's text: prompt lines, "Negative prompt:" lines, then one line of `key: value` pairs. */
export function parseA1111(infotext: string): FoundSettings {
  const lines = infotext.trim().split("\n");
  let paramLine = "";
  if (/(^|,\s*)Steps:\s*\d+/.test(lines[lines.length - 1] ?? "")) paramLine = lines.pop()!;
  let prompt = "";
  let negative = "";
  let inNeg = false;
  for (const l of lines) {
    if (l.startsWith("Negative prompt:")) {
      inNeg = true;
      negative += l.slice("Negative prompt:".length).trim();
    } else if (inNeg) negative += `\n${l}`;
    else prompt += (prompt ? "\n" : "") + l;
  }
  const civ = takeJson(paramLine, "Civitai resources");
  if (civ) paramLine = civ.rest;
  for (const key of ["Hashes", "Civitai metadata"]) {
    const cut = takeJson(paramLine, key);
    if (cut) paramLine = cut.rest;
  }
  const kv: Record<string, string> = {};
  for (const m of paramLine.matchAll(/\s*(\w[\w \-/+]+):\s*("(?:\\.|[^\\"])+"|[^,]*)(?:,|$)/g)) {
    let v = m[2]!.trim();
    if (v.startsWith('"') && v.endsWith('"')) {
      try {
        v = JSON.parse(v) as string;
      } catch {
        v = v.slice(1, -1);
      }
    }
    kv[m[1]!.trim()] = v;
  }
  const num = (k: string) => (kv[k] !== undefined && kv[k] !== "" && !Number.isNaN(Number(kv[k])) ? Number(kv[k]) : undefined);
  const [w, h] = (kv.Size ?? "").split("x").map(Number);
  const pos = splitLoras(prompt);
  const neg = splitLoras(negative);
  const notes: string[] = [];
  if (kv.VAE && !/automatic|none/i.test(kv.VAE)) notes.push(`It was made with the VAE "${kv.VAE}": the model's own is used here.`);
  if (Object.keys(kv).some((k) => k.startsWith("ADetailer"))) notes.push('It had a face detailer pass: use "Face detailer" on the result.');
  const hires = kv["Hires upscale"] || kv["Hires upscaler"];
  if (kv["Denoising strength"] && !hires) notes.push("It was made with img2img: here it is txt2img.");

  const loras: FoundSettings["loras"] = pos.loras;
  let checkpointCivitai: number | undefined;
  let checkpointName: string | undefined;
  if (Array.isArray(civ?.value)) {
    for (const r of civ!.value as Array<{ type?: string; modelVersionId?: number; modelName?: string; weight?: number }>) {
      if (!r.modelVersionId) continue;
      if (r.type === "checkpoint") {
        checkpointCivitai = r.modelVersionId;
        checkpointName = r.modelName;
      } else if (/lora|locon|lycoris|dora/i.test(r.type ?? "")) {
        const known = loras.find((l) => r.modelName && l.name.toLowerCase() === r.modelName.toLowerCase());
        if (known) known.civitai = r.modelVersionId;
        else loras.push({ name: r.modelName ?? `Civitai ${r.modelVersionId}`, weight: typeof r.weight === "number" ? r.weight : 1, civitai: r.modelVersionId });
      }
    }
  }
  return {
    source: "a1111", prompt: pos.text, negative: neg.text,
    checkpoint: kv.Model ? stemOf(kv.Model) : checkpointName, checkpointCivitai,
    loras, steps: num("Steps"), cfg: num("CFG scale"), seed: num("Seed"),
    ...samplerOf(kv.Sampler, kv["Schedule type"]),
    clipSkip: (num("Clip skip") ?? 1) > 1 ? num("Clip skip") : undefined,
    width: w || undefined, height: h || undefined,
    ...(hires ? { hires: { scale: num("Hires upscale"), upscaler: kv["Hires upscaler"], denoise: num("Denoising strength"), steps: num("Hires steps") || undefined } } : {}),
    notes,
  };
}

// ---------------------------------------------------------------- ComfyUI graph

type Node = { class_type: string; inputs: Record<string, unknown> };
type Graph = Record<string, Node>;
const isLink = (v: unknown): v is [string, number] => Array.isArray(v) && v.length === 2 && typeof v[0] === "string";
const isGraph = (v: unknown): v is Graph =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v) && Object.values(v as object).length > 0 &&
  Object.values(v as object).every((n) => n && typeof n === "object" && typeof (n as Node).class_type === "string" &&
    Boolean((n as Node).inputs) && typeof (n as Node).inputs === "object" && !Array.isArray((n as Node).inputs));

/** The settings of a graph built around a checkpoint and a KSampler. Null when it is another kind of workflow. */
function parseComfy(graph: Graph): FoundSettings | null {
  try {
    return settingsOfGraph(graph);
  } catch {
    // a file's metadata is a stranger's: one shaped in a way this reading did not foresee gives no settings, not a server error
    return null;
  }
}

function settingsOfGraph(graph: Graph): FoundSettings | null {
  const node = (v: unknown) => (isLink(v) ? graph[v[0]] : undefined);
  const textOf = (v: unknown, depth = 0): string => {
    if (typeof v === "string") return v;
    const n = node(v);
    if (!n || depth > 6) return "";
    for (const k of ["text", "text_g", "value", "string", "prompt", "Text"]) {
      if (k in n.inputs) {
        const t = textOf(n.inputs[k], depth + 1);
        if (t) return t;
      }
    }
    return "";
  };
  const encoderText = (cond: unknown, depth = 0): string => {
    const n = node(cond);
    if (!n || depth > 6) return "";
    if (/CLIPTextEncode/.test(n.class_type)) return textOf(n.inputs.text ?? n.inputs.text_g);
    for (const k of ["conditioning", "positive", "conditioning_1", "conditioning_to"]) if (k in n.inputs) return encoderText(n.inputs[k], depth + 1);
    return "";
  };
  const samplers = Object.entries(graph)
    .filter(([, n]) => n.class_type === "KSampler" || n.class_type === "KSamplerAdvanced")
    .sort(([a], [b]) => Number(a) - Number(b) || a.localeCompare(b));
  const ckpt = Object.values(graph).find((n) => /CheckpointLoader/.test(n.class_type) && typeof n.inputs.ckpt_name === "string");
  if (!samplers.length || !ckpt) return null;
  // the first pass starts from an empty picture; a later sampler fed from it is the hi-res pass
  const fromEmpty = (v: unknown, depth = 0): boolean => {
    const n = node(v);
    if (!n || depth > 8) return false;
    if (/EmptyLatent|EmptySD3Latent/.test(n.class_type)) return true;
    if (n.class_type === "KSampler" || n.class_type === "KSamplerAdvanced") return false;
    return Object.values(n.inputs).some((x) => isLink(x) && fromEmpty(x, depth + 1));
  };
  const baseEntry = samplers.find(([, n]) => fromEmpty(n.inputs.latent_image)) ?? samplers[0]!;
  const i = baseEntry[1].inputs;
  const second = samplers.find(([id]) => id !== baseEntry[0])?.[1];
  const notes: string[] = [];
  const empty = Object.values(graph).find((n) => /EmptyLatent/.test(n.class_type));
  const width = Number(empty?.inputs.width) || undefined;
  const lastLayer = Object.values(graph).find((n) => n.class_type === "CLIPSetLastLayer");
  let hires: FoundSettings["hires"];
  if (second) {
    const up = Object.values(graph).find((n) => n.class_type === "LatentUpscale" || n.class_type === "LatentUpscaleBy");
    const model = Object.values(graph).find((n) => n.class_type === "UpscaleModelLoader");
    const w2 = Number(up?.inputs.width ?? Object.values(graph).find((n) => n.class_type === "ImageScale" && Number(n.inputs.width) > (width ?? 0))?.inputs.width);
    hires = {
      denoise: Number(second.inputs.denoise) || undefined, steps: Number(second.inputs.steps) || undefined,
      upscaler: typeof model?.inputs.model_name === "string" ? model.inputs.model_name : up ? "latent" : undefined,
      scale: up?.inputs.scale_by ? Number(up.inputs.scale_by) : w2 && width ? Math.round((w2 / width) * 100) / 100 : undefined,
    };
  }
  if (Object.values(graph).some((n) => n.class_type === "LoadImage") && !second && Number(i.denoise ?? 1) < 1) notes.push("It was made with img2img: here it is txt2img.");
  if (Object.values(graph).some((n) => /Detailer/.test(n.class_type))) notes.push('It had a face detailer pass: use "Face detailer" on the result.');
  const pos = splitLoras(encoderText(i.positive));
  const neg = splitLoras(encoderText(i.negative));
  if (!pos.text) notes.push("The text it was made from could not be found in its workflow.");
  const loaded = Object.values(graph)
    .filter((n) => /LoraLoader/.test(n.class_type) && typeof n.inputs.lora_name === "string")
    .map((n) => ({ name: stemOf(n.inputs.lora_name as string), weight: Number(n.inputs.strength_model ?? 1) }));
  const seed = i.seed ?? i.noise_seed;
  return {
    source: "comfyui", prompt: pos.text, negative: neg.text, checkpoint: stemOf(ckpt.inputs.ckpt_name as string),
    loras: [...loaded, ...pos.loras],
    steps: Number(i.steps) || undefined, cfg: Number(i.cfg) || undefined,
    sampler: typeof i.sampler_name === "string" ? i.sampler_name : undefined, scheduler: typeof i.scheduler === "string" ? i.scheduler : undefined,
    seed: typeof seed === "number" ? seed : undefined,
    clipSkip: lastLayer && Number(lastLayer.inputs.stop_at_clip_layer) <= -2 ? -Number(lastLayer.inputs.stop_at_clip_layer) : undefined,
    width, height: Number(empty?.inputs.height) || undefined,
    ...(hires ? { hires } : {}),
    notes,
  };
}

// ---------------------------------------------------------------- entry

const json = (text: string | undefined): unknown => {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const asText = (v: unknown) => (typeof v === "string" ? v : v ? JSON.stringify(v) : undefined);

/**
 * The graph that ran and the workflow, from a video's tags (their names in lower case). ComfyUI's video savers write
 * them as they are ("prompt", "workflow"), or together as JSON under "comment" (or "description", where some savers
 * put it), or the editor's workflow alone under one of those; a tag that is not JSON is a plain comment.
 */
export function videoTexts(tags: Record<string, string>): { prompt: string; workflow: string } {
  let prompt: string | undefined;
  let workflow: string | undefined;
  for (const key of ["comment", "description", "workflow"]) {
    const v = json(tags[key]);
    if (!v || typeof v !== "object") continue;
    if ("nodes" in v) workflow ??= JSON.stringify(v);
    else {
      const both = v as { prompt?: unknown; workflow?: unknown };
      prompt ??= asText(both.prompt);
      workflow ??= asText(both.workflow);
    }
  }
  return { prompt: prompt ?? tags.prompt ?? "", workflow: workflow ?? tags.workflow ?? "" };
}

/** The workflow of a file's texts: the editor's own form when it has it, else the graph that ran. */
function workflowOf(texts: Record<string, string>): unknown | null {
  const graph = json(texts.prompt);
  const editor = json(texts.workflow);
  return editor && typeof editor === "object" ? editor : isGraph(graph) ? graph : null;
}

const isPictureBytes = (buf: Buffer) => buf.length > 12 && (buf.readUInt32BE(0) === 0x89504e47 || (buf[0] === 0xff && buf[1] === 0xd8) || buf.toString("latin1", 8, 12) === "WEBP");

/**
 * The workflow a file on disk carries (POST /api/workflows/extract): read as readEmbedded reads it, a video's tags
 * straight from the file rather than through memory. Null when it carries none.
 */
export async function embeddedWorkflowOf(file: string): Promise<unknown | null> {
  const handle = await open(file, "r");
  const head = Buffer.alloc(16);
  try {
    await handle.read(head, 0, 16, 0);
  } finally {
    await handle.close();
  }
  if (isPictureBytes(head)) return (await readEmbedded(new Uint8Array(await readFile(file)))).workflow;
  return workflowOf(videoTexts(await tagsOfFile(file)));
}

/** Everything a dropped file says about how it was made. Never throws: a file that says nothing gives nothing. */
export async function readEmbedded(bytes: Uint8Array): Promise<Embedded> {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let texts = pngText(buf);
  const isPicture = isPictureBytes(buf);
  let comment: string | null = null;
  if (!Object.keys(texts).length && isPicture) {
    const exif = exifOf(buf);
    comment = exif ? exifUserComment(exif) : null;
  }
  // a video ComfyUI saved: the graph and the workflow are in its tags (videoTexts)
  if (!isPicture) texts = videoTexts(await mediaTags(bytes));
  const graph = json(texts.prompt);
  const workflow = workflowOf(texts);
  const infotext = texts.parameters ?? (comment && /Steps:\s*\d+/.test(comment) ? comment : null);
  if (infotext) return { settings: parseA1111(infotext), workflow };
  if (isGraph(graph)) {
    const settings = parseComfy(graph);
    return settings ? { settings, workflow } : { settings: null, workflow, why: "Its workflow is not built around a checkpoint and a sampler, so it cannot fill the SDXL form. Import its workflow instead: it becomes something to create with." };
  }
  return {
    settings: null, workflow,
    why: workflow ? "It only carries the workflow as the editor shows it. Import its workflow instead." : "Nothing about how it was made is stored in this file. It was saved without it, or a site removed it.",
  };
}
