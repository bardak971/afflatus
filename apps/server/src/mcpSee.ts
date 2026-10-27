import { modelOf, plural, type InputSpec } from "@afflatus/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { assetDetail } from "./assets-api";
import type { Tables } from "./db";
import { httpError } from "./errors";
import { quoted, Rich, tool } from "./mcpTool";
import type { Services } from "./services";
import { makeStill, sideBySide } from "./thumbs";

/**
 * Seeing results, from outside (MCP): a library item as an agent can see it (a picture as an image, a video as a few of
 * its frames with its facts, a sound as audio where it fits) with how it was made; and two to four side by side in one
 * picture, with what differs between how each was made.
 */

/** The longest edge of a picture shown to an agent: enough to judge a face or a hand, a few hundred kB at most. */
const PICTURE_EDGE = 1024;
/** How tall a video's frames are shown (the peek's largest). */
const FRAME_HEIGHT = 480;
/** About this many frames of a video, spread over its length. */
const FRAMES = 6;
/** A sound sent whole as audio up to this size; past it, its facts only. */
const SOUND_MOST = 4 * 2 ** 20;
/** The audio a client is sent as it is (MCP audio content takes these). */
const AUDIO_MIMES = new Set(["audio/mpeg", "audio/wav", "audio/x-wav", "audio/ogg", "audio/flac", "audio/mp4", "audio/aac"]);

type Content = CallToolResult["content"];
const text = (value: unknown): Content[number] => ({ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) });
const image = (bytes: Uint8Array, mimeType = "image/jpeg"): Content[number] => ({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType });

/** A library item by id, in the bin or not; refused with where to find the ids. */
async function itemOf(s: Services, id: string): Promise<Tables["assets"]> {
  const a = await s.db.selectFrom("assets").selectAll().where("id", "=", id).executeTakeFirst();
  if (!a) throw httpError(`There is no library item ${id}: job gives what a render made, read_draft the items a draft uses.`, 404);
  return a;
}

/**
 * How an item was made, as its detail says it ("made with"): its form, model, prompts, seed, LoRAs and the rest of the
 * form's settings; for a copy of a render (a frame, a cut, a mirror), the render it comes from. Null for an upload.
 */
async function madeWith(s: Services, a: Tables["assets"]) {
  const d = await assetDetail(s, a);
  const g = d.generation ?? d.ancestor;
  if (!g) return null;
  const recipe = s.registry.recipe(g.recipe);
  const specs = (recipe?.inputs ?? []) as InputSpec[];
  const prompts = Object.fromEntries(specs.filter((i) => i.type === "prompt" && typeof g.inputs[i.id] === "string" && (g.inputs[i.id] as string).trim()).map((i) => [i.id, g.inputs[i.id]]));
  const loras = specs.filter((i) => i.type === "loras").flatMap((i) => (Array.isArray(g.inputs[i.id]) ? (g.inputs[i.id] as unknown[]) : []));
  const shown = new Set(specs.filter((i) => i.type === "prompt" || i.type === "loras" || i.type === "seed" || i.internal).map((i) => i.id));
  return {
    ...(d.generation ? {} : { from: "the render this copy was taken from" }),
    form: g.recipe, formTitle: recipe?.title ?? null, model: modelFile(specs, g.inputs),
    prompts, seed: g.resolved.seed ?? null, loras,
    settings: Object.fromEntries(Object.entries(g.inputs).filter(([k]) => !shown.has(k))),
    ...(g.asked ? { asked: "the cast changed some of the form: `settings` is what rendered" } : {}),
    tookMs: g.tookMs,
  };
}

/** The model file a form rendered with, as it names it; the model's name when the form picks none (its family's usual file). */
function modelFile(specs: InputSpec[], inputs: Record<string, unknown>): string | null {
  const spec = specs.find((i) => i.type === "model");
  const file = spec ? inputs[spec.id] : undefined;
  return typeof file === "string" && file ? file : modelOf(specs, inputs);
}

/** An item's facts: its kind, size, length, frames a second, sound, name, where it is. */
const factsOf = (a: Tables["assets"]) => ({
  item: a.id, kind: a.kind, name: a.name, mime: a.mime, width: a.width, height: a.height,
  ...(a.kind !== "image" ? { durationMs: a.duration_ms, ...(a.kind === "video" ? { fps: a.fps, hasSound: Boolean(a.has_sound) } : {}) } : {}),
  kept: a.kept_at !== null, inBin: a.deleted_at !== null, createdAt: a.created_at,
});

/** A still of an item for an agent: a picture itself, or a video's frame at `atMs` (its middle when left out). */
async function stillOf(s: Services, a: Tables["assets"], height: number, atMs?: number): Promise<Uint8Array> {
  if (a.kind === "image") {
    const still = await makeStill(await s.storage.get(a.file_key), height * 2);
    if (!still) throw httpError(`${a.name || a.id}: this picture could not be read.`);
    return still;
  }
  if (a.kind === "video") return s.timelines.media.peek(a.id, atMs ?? Math.max(0, (a.duration_ms ?? 0) / 2), Math.min(height, FRAME_HEIGHT));
  throw httpError(`${a.name || a.id} is a sound: it has no picture to compare.`);
}

const viewItem = tool({
  name: "view_item",
  scope: "look",
  title: "View an item",
  description: "A library item as you can see it: a picture as an image (1024 px at most); a video as about six frames spread over its length, with its facts (length, fps, size, sound); a sound as audio where it fits, else its facts. With how it was made (\"made with\": form, model, prompts, seed, LoRAs, settings).",
  input: {
    item: z.string().min(1).describe("A library item's id (job › made, read_draft's values)."),
    frames: z.number().int().min(1).max(12).optional().describe("Of a video: how many frames (6 when left out)."),
  },
  async run({ item, frames }, ctx) {
    const { s } = ctx;
    const a = await itemOf(s, item);
    const made = await madeWith(s, a);
    const content: Content = [];
    if (a.kind === "image") {
      const still = await makeStill(await s.storage.get(a.file_key), PICTURE_EDGE);
      if (still) content.push(image(still));
    } else if (a.kind === "video") {
      const n = frames ?? FRAMES;
      const length = a.duration_ms ?? 0;
      const at = Array.from({ length: n }, (_, i) => Math.round(((i + 0.5) / n) * length));
      for (const ms of at) {
        const frame = await s.timelines.media.peek(a.id, ms, FRAME_HEIGHT).catch(() => null);
        if (frame) content.push(text(`at ${(ms / 1000).toFixed(2)} s`), image(frame));
      }
    } else if (a.kind === "audio" && Number(a.bytes) <= SOUND_MOST && AUDIO_MIMES.has(a.mime)) {
      content.push({ type: "audio", data: Buffer.from(await s.storage.get(a.file_key)).toString("base64"), mimeType: a.mime });
    }
    content.unshift(text({ ...factsOf(a), madeWith: made }));
    ctx.said(`Viewed ${quoted(a.name || a.id)} (${a.kind}${a.kind === "video" ? `, ${plural(content.filter((c) => c.type === "image").length, "frame")}` : ""})`);
    return new Rich(content);
  },
});

/** The settings that differ between how each item was made: each one's value per item, in the items' order. */
function differing(made: Array<Awaited<ReturnType<typeof madeWith>>>): Record<string, unknown[]> {
  const flat = made.map((m) => (m ? { form: m.form, model: m.model, seed: m.seed, loras: m.loras, ...m.prompts, ...m.settings } : {})) as Array<Record<string, unknown>>;
  const keys = new Set(flat.flatMap((f) => Object.keys(f)));
  const out: Record<string, unknown[]> = {};
  for (const k of keys) {
    const values = flat.map((f) => f[k]);
    if (new Set(values.map((v) => JSON.stringify(v ?? null))).size > 1) out[k] = values.map((v) => v ?? null);
  }
  return out;
}

const compare = tool({
  name: "compare",
  scope: "look",
  title: "Compare",
  description: "Two to four library items side by side in one picture, numbered in the order given (a video by its middle frame, or `atMs`), with what differs between how each was made (seed, prompt, model, LoRAs, settings).",
  input: {
    items: z.array(z.string().min(1)).min(2).max(4).describe("Library item ids, in the order to show them."),
    atMs: z.number().min(0).optional().describe("Of videos: the moment to compare at (each one's middle when left out)."),
  },
  async run({ items, atMs }, ctx) {
    const { s } = ctx;
    const rows = await Promise.all(items.map((id) => itemOf(s, id)));
    const stills = await Promise.all(rows.map((a) => stillOf(s, a, 512, atMs === undefined ? undefined : Math.min(atMs, a.duration_ms ?? atMs))));
    const joined = await sideBySide(stills, 512);
    const made = await Promise.all(rows.map((a) => madeWith(s, a)));
    const said = { items: rows.map((a, i) => ({ n: i + 1, ...factsOf(a) })), differs: differing(made) };
    ctx.said(`Compared ${plural(rows.length, "item")}`);
    return new Rich(joined ? [text(said), image(joined)] : [text(said), ...stills.map((b) => image(b))]);
  },
});

export const SEE_TOOLS = [viewItem, compare];
