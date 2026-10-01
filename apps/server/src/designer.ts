import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { secondsOf, type Family, type InputSpec, type LoraValue, type Recipe } from "@studai/core";
import { emptyLook, lookSchema, type Look } from "./entities";
import type { Services } from "./services";
import { instructionsInUse, llmInUse, readSettings, type Llm } from "./settings";

/**
 * The prompt designer: a conversation with a language model (any OpenAI-style address, set in Setup)
 * that writes and improves what a form's text boxes hold. It is given the model's own way of writing
 * prompts (the family's guide), what the boxes hold now, who is in it, the LoRAs in use and, when the
 * language model can read pictures, the picture the clip opens on. It answers with the full new text
 * of each box it changes, or with one question.
 *
 * Replies are labelled lines, not JSON: dialogue is full of quotes, and one unescaped quote makes a
 * whole JSON reply unreadable (learned in Noctown).
 */

export class DesignerError extends Error {
  statusCode = 400;
}

type Message = { role: "system" | "user" | "assistant"; content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> };

/** Roughly how many tokens a text is: enough to know what fits, with room to spare. */
export const tokensOf = (content: Message["content"]): number =>
  typeof content === "string" ? Math.ceil(content.length / 3.5) : content.reduce((n, part) => n + (part.type === "text" ? Math.ceil(part.text.length / 3.5) : 1200), 0);

/**
 * The end of a conversation that fits in what the model can read: its context, less the answer it may
 * write and what it is told first. The oldest turns go; the last thing said always stays.
 */
export function fitting(cfg: Llm, system: string, history: Message[]): Message[] {
  let room = cfg.contextSize - cfg.maxOutputTokens - tokensOf(system) - 200;
  const kept: Message[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    room -= tokensOf(history[i]!.content);
    if (room < 0 && kept.length) break;
    kept.unshift(history[i]!);
  }
  // a conversation starts with what the user said
  while (kept.length > 1 && kept[0]!.role !== "user") kept.shift();
  return kept;
}

/** One plain exchange with the language model. A busy server is asked a second time. */
export async function chat(cfg: Llm | undefined, messages: Message[], opts: { temperature?: number; maxTokens?: number } = {}): Promise<string> {
  if (!cfg || !cfg.baseUrl.trim() || !cfg.model.trim()) throw new DesignerError("The designer has no language model yet. Give it one in Setup.");
  const ask = () =>
    fetch(`${cfg.baseUrl.trim().replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify({ model: cfg.model, messages, stream: false, max_tokens: opts.maxTokens ?? cfg.maxOutputTokens, temperature: opts.temperature ?? 0.6 }),
      signal: AbortSignal.timeout(120_000),
    });
  let res: Response;
  try {
    res = await ask();
    if (res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1200));
      res = await ask();
    }
  } catch (err) {
    throw new DesignerError(`The language model did not answer at ${cfg.baseUrl}: ${(err as Error).message}`);
  }
  if (!res.ok) throw new DesignerError(`The language model refused (${res.status}): ${(await res.text().catch(() => "")).slice(0, 300)}`);
  const data = (await res.json().catch(() => ({}))) as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }> };
  // a model that thinks before it answers may leave its thinking in the answer: it is not part of it
  const said = (data.choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^[\s\S]*<\/think>/i, "").trim();
  if (!said && data.choices?.[0]?.finish_reason === "length") {
    throw new DesignerError(`The language model used its whole answer (${opts.maxTokens ?? cfg.maxOutputTokens} tokens) before it wrote anything, as a model that thinks first can. Raise "Max output tokens" for it in Setup.`);
  }
  return said;
}

/** How a family's prompts are written, when the family does not say itself. */
const GENERIC: Record<"tags" | "sentences", string> = {
  tags: `A GOOD PROMPT is comma-separated tags, most important first: the subject and how many, their look, the outfit one tag per garment, the expression, the pose, the framing and camera angle, the place and time of day, the light. One idea per tag, concrete, lower case, no contradictions.`,
  sentences: `A GOOD PROMPT is plain sentences, present tense, concrete nouns: who and what they do, what they wear, the place with a few concrete details, the light, the camera (framing, angle, one move for a video). One moment for a picture; for a video, the motion over time ("at first", "then", "as she…"). No tag lists, no weights.`,
};

/** The text boxes of a recipe: what the designer may write in. */
const boxesOf = (recipe: Recipe<any>) => (recipe.inputs as InputSpec[]).filter((i): i is Extract<InputSpec, { type: "prompt" }> => i.type === "prompt");

export interface DesignerContext {
  /** What each text box holds now (input id → text). */
  values: Record<string, string>;
  seconds?: number | null;
  /** What the clip before it says happens, when this clip carries on from it. */
  previous?: string;
  /** The whole video this clip is part of: what every clip says happens, in the order they play, and which one is being written. */
  story?: { clips: string[]; index: number };
  opensOnPicture?: boolean;
  endsOnPicture?: boolean;
  /** Who is in it, as names with their words: they are added on their own, the designer must not repeat them. */
  cast?: Array<{ name: string; words: string }>;
  /** The look and mood of the whole video. */
  mood?: string;
  loras?: Array<{ name: string; weight: number; trigger?: string }>;
  /** Whether the picture is given to the language model with the request. */
  seesPicture?: boolean;
}

export function systemPrompt(recipe: Recipe<any>, family: Family | undefined, mode: "chat" | "enhance" | "plan", ctx: DesignerContext, plan?: { clips: number }, own = ""): string {
  const boxes = boxesOf(recipe);
  const main = boxes.find((b) => !b.optional) ?? boxes[0];
  const video = recipe.output === "video";
  const guide = family?.guide ?? GENERIC[main?.style === "tags" ? "tags" : "sentences"];
  const now = boxes.map((b) => `${b.id}: ${ctx.values[b.id]?.trim() || "(empty)"}`).join("\n");
  const parts = boxes.map((b) => `- ${b.id}: "${b.label}"${b.optional ? " (may stay empty)" : ""}, written as ${b.style === "tags" ? "tags" : "sentences"}${b.note ? ` — ${b.note}` : ""}`).join("\n");
  const where = [
    video && ctx.seconds ? `The clip is ${ctx.seconds} seconds long: it holds about ${Math.max(1, Math.round(ctx.seconds / 3))} main action${ctx.seconds >= 6 ? "s" : ""}. Do not cram a story into it.` : "",
    ctx.story && ctx.story.clips.length > 1
      ? `THE WHOLE VIDEO is ${ctx.story.clips.length} clips that play one after the other. You are writing clip ${ctx.story.index + 1}. What each clip says happens:\n${ctx.story.clips
          .map((c, i) => `${i + 1}.${i === ctx.story!.index ? " (THIS CLIP)" : ""} ${c.trim().slice(0, 700) || "(nothing written yet)"}`)
          .join("\n")}\nKeep it one story: do not show again what an earlier clip already showed, lead into what the next clip needs, and keep the people, the place, the clothes and the mood the same from clip to clip unless the user says otherwise. You only write clip ${ctx.story.index + 1}.`
      : "",
    ctx.previous ? `This clip CONTINUES the clip before it (the model is given that clip's last frames): carry the action on from where it ended, nothing resets. Restate how the people look in a short clause, so they stay the same people even if that clip ended on a close-up. What the clip before says:\n${ctx.previous.slice(0, 2500)}` : "",
    ctx.opensOnPicture && !ctx.previous ? "A picture is the FIRST FRAME: the action starts from exactly what it shows." : "",
    ctx.endsOnPicture ? "A picture is the LAST FRAME: the action has to arrive at it." : "",
    ctx.opensOnPicture && !ctx.seesPicture ? "You cannot see that picture. Never invent a place, props, light, weather, clothing or other people for it: say nothing about the setting and describe only the motion, the expression, the sound and the camera, unless the user says what the picture shows." : "",
    ctx.seesPicture ? "You are shown the picture. Describe what is really in it; do not add a place, props or people it does not show unless the user asks." : "",
    ctx.cast?.length ? `Who is in it. Their words are added on their own when it is made: never repeat or contradict them, refer to them by what they are (the woman, he):\n${ctx.cast.map((c) => `- ${c.name}: ${c.words || "(no words)"}`).join("\n")}` : "",
    ctx.mood?.trim() ? `The look and mood of the whole video, which every clip keeps: ${ctx.mood.trim()}` : "",
    ctx.loras?.length ? `LoRAs in use: ${ctx.loras.map((l) => `${l.name} at ${l.weight}${l.trigger ? ` (its trigger words: ${l.trigger})` : ""}`).join("; ")}. A LoRA's trigger words must stay in the text for it to act: never remove them.` : "",
  ].filter(Boolean).join("\n\n");

  const task =
    mode === "plan"
      ? `PLAN a longer video as ${plan!.clips} clips that play one after the other as one continuous scene. Clip 1 starts the scene; each next clip starts exactly where the one before ended (the model is given only its last frames), so every clip moves the action on a step and nothing resets. From clip 2 on, restate how the people look in a short clause. Reply with kind: plan, a note, then one CLIP block per clip.`
      : mode === "enhance"
        ? `The user pressed "Improve it": make what is written richer and cleaner without changing what it shows. Keep the subject and the intent, remove contradictions and repeats, fill what is thin. Return the full new text of each part you improve.`
        : main && ctx.values[main.id]?.trim()
          ? `Change what the user asks and keep the rest. Return the FULL new text of each part you change; a part you leave empty stays as it is. If the request is too vague to act on, ask ONE question.`
          : `Nothing is written yet: write it all from the user's idea. If the idea is too vague to picture, ask ONE question instead.`;

  return `You are the prompt designer of studai, working on "${recipe.title}"${family ? ` for ${family.name}` : ""}, which makes ${recipe.output === "image" ? "a picture" : recipe.output === "video" ? "a video" : "a sound"}. You shape the prompt with the user in a conversation: your notes are brief, your prompts rich and precise. The user's explicit wishes (length, detail, tone, content) win over every guideline here.
${own.trim() ? `\nTHE USER'S STANDING INSTRUCTIONS FOR YOU (they hold for the whole conversation and win over the guidelines below; the reply format at the end still holds):\n${own.trim()}\n` : ""}
${guide}

THE PARTS YOU WRITE
${parts}

${where ? `CONTEXT\n${where}\n\n` : ""}WHAT IS WRITTEN NOW
${now}

YOUR TASK NOW
${task}

REPLY in exactly this plain format, each label at the start of a line, nothing else (leave a label empty when it has nothing):
kind: proposal   (or: question — only when you truly cannot act without an answer${mode === "plan" ? "; or: plan" : ""})
note: one or two short sentences to the user, saying what you did or why you ask
${boxes.map((b) => `${b.id}: the full new text of "${b.label}", or empty to keep it`).join("\n")}
question: the one question (kind: question only)
options: 2 or 3 short things the user might want next, separated by |${mode === "plan" ? `\nthen one block per clip:\nCLIP 1\n${boxes.map((b) => `${b.id}: …`).join("\n")}\nCLIP 2\n…` : ""}`;
}

/** `label: value` lines; a value runs over several lines until the next known label. */
function labelled(text: string, labels: string[]): Record<string, string> {
  const re = new RegExp(`^\\s*(?:[-•]\\s*)?[*_#]*\\s*(${labels.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\s*[*_]*\\s*:[*_]*\\s*`, "i");
  const out: Record<string, string> = {};
  let cur: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = re.exec(line);
    if (m) {
      cur = labels.find((l) => l.toLowerCase() === m[1]!.toLowerCase())!;
      out[cur] = line.slice(m[0].length);
    } else if (cur) out[cur] += `\n${line}`;
  }
  for (const k of Object.keys(out)) out[k] = out[k]!.replace(/\s*\((?:or:|only|leave|e\.g\.)[^)]*\)\s*$/i, "").trim();
  return out;
}

const CLIP = /^\s*[#*_[(]*\s*clip\s*\d+\s*[\])*_:.-]*\s*$/im;
/** A value that means "nothing to say": the model was told to leave a label empty and wrote a word for it. */
const kept = (v: string) => /^\(?(empty|unchanged|keep|kept|same|none|nothing|n\/a|-)?\)?\.?$/i.test(v.trim());
const unquote = (v: string) => v.trim().replace(/^["'`]|["'`]$/g, "").trim();

export interface DesignerReply {
  kind: "proposal" | "question" | "plan";
  note: string;
  /** Input id → its full new text, for the boxes that change. */
  changes: Record<string, string>;
  question: string;
  options: string[];
  /** A plan: the text boxes of each clip, in order. */
  clips: Array<Record<string, string>>;
}

export function parseReply(raw: string, recipe: Recipe<any>, values: Record<string, string>): DesignerReply {
  const ids = boxesOf(recipe).map((b) => b.id);
  const [head = "", ...blocks] = raw.split(new RegExp(CLIP.source, "gim"));
  const l = labelled(head, ["kind", "note", "question", "options", ...ids]);
  const options = (l.options ?? "").split("|").map(unquote).filter((o) => o && o.length <= 80).slice(0, 3);
  const pick = (from: Record<string, string>) => {
    const out: Record<string, string> = {};
    for (const id of ids) {
      const v = unquote(from[id] ?? "");
      if (v && !kept(v) && v !== (values[id] ?? "").trim()) out[id] = v;
    }
    return out;
  };
  const clips = blocks.map((b) => pick(labelled(b, ids))).filter((c) => Object.keys(c).length);
  const question = unquote(l.question ?? "");
  const kindLine = (l.kind ?? "").toLowerCase();
  if (clips.length >= 2) return { kind: "plan", note: l.note ?? "", changes: {}, question: "", options, clips };
  if (/question/.test(kindLine) && question) return { kind: "question", note: l.note ?? "", changes: {}, question, options, clips: [] };
  const changes = pick(l);
  if (!Object.keys(changes).length && !(l.note ?? "").trim()) throw new DesignerError("The language model returned nothing usable. Try saying it another way.");
  return { kind: "proposal", note: l.note ?? "", changes, question: "", options, clips: [] };
}

const body = z.strictObject({
  recipe: z.string().min(1),
  values: z.record(z.string(), z.unknown()),
  messages: z.array(z.strictObject({ role: z.enum(["user", "assistant"]), content: z.string().max(8000) })).max(40),
  mode: z.enum(["chat", "enhance"]).default("chat"),
  /** What the clip before it says happens, when this one carries on from it. */
  previous: z.string().max(8000).optional(),
  /** The whole video the clip is part of: every clip's text in order, and which one this is. */
  story: z.strictObject({ clips: z.array(z.string().max(8000)).max(60), index: z.number().int().min(0) }).optional(),
  look: lookSchema.nullable().optional(),
  mood: z.string().max(2000).optional(),
});

export function registerDesigner(app: FastifyInstance, s: Services): void {
  const recipeOf = (id: string) => {
    const recipe = s.registry.recipe(id);
    if (!recipe) throw new DesignerError(`there is no recipe called ${id}`);
    return recipe;
  };

  /** Who is in it, with their words in the form the recipe's main text is written in. */
  async function castOf(recipe: Recipe<any>, look: Look | null | undefined) {
    if (emptyLook(look)) return [];
    const rows = await s.db.selectFrom("entities").selectAll().where("id", "in", look!.cast.map((c) => c.id)).execute();
    const tags = boxesOf(recipe).find((b) => !b.optional)?.style === "tags";
    return look!.cast.flatMap((member) => {
      const row = rows.find((r) => r.id === member.id);
      if (!row) return [];
      const d = JSON.parse(row.def) as { tags?: string; sentence?: string; outfits?: Array<{ id: string; tags: string; sentence: string }> };
      const worn = d.outfits?.find((o) => o.id === member.outfit);
      return [{ name: row.name, words: [tags ? d.tags : d.sentence, tags ? worn?.tags : worn?.sentence].filter(Boolean).join(tags ? ", " : " ") }];
    });
  }

  /** The picture a form opens on, small, as something a language model that reads pictures can be shown. */
  async function pictureOf(recipe: Recipe<any>, values: Record<string, unknown>): Promise<string | null> {
    const spec = (recipe.inputs as InputSpec[]).find((i) => i.type === "image" && (i.role === "start" || i.role === "source"));
    const id = spec ? values[spec.id] : undefined;
    if (typeof id !== "string") return null;
    const asset = await s.db.selectFrom("assets").select(["thumb_key", "file_key", "mime", "kind"]).where("id", "=", id).executeTakeFirst();
    if (!asset || asset.kind !== "image") return null;
    const bytes = await s.storage.get(asset.thumb_key ?? asset.file_key).catch(() => null);
    return bytes ? `data:${asset.thumb_key ? "image/webp" : asset.mime};base64,${Buffer.from(bytes).toString("base64")}` : null;
  }

  async function context(recipe: Recipe<any>, values: Record<string, unknown>, extra: { previous?: string; story?: DesignerContext["story"]; look?: Look | null; mood?: string }, sees: boolean): Promise<DesignerContext> {
    const specs = recipe.inputs as InputSpec[];
    const text: Record<string, string> = {};
    for (const b of boxesOf(recipe)) text[b.id] = typeof values[b.id] === "string" ? (values[b.id] as string) : "";
    const has = (role: "start" | "end") => specs.some((i) => i.type === "image" && i.role === role && typeof values[i.id] === "string");
    const loraSpec = specs.find((i) => i.type === "loras");
    const loras = loraSpec && Array.isArray(values[loraSpec.id]) ? (values[loraSpec.id] as LoraValue[]) : [];
    const info = loras.length ? await s.db.selectFrom("model_info").select(["file", "info"]).where("folder", "=", "loras").where("file", "in", loras.map((l) => l.file)).execute() : [];
    return {
      values: text,
      seconds: secondsOf(specs, values),
      previous: extra.previous,
      story: extra.story,
      opensOnPicture: has("start"),
      endsOnPicture: has("end"),
      cast: await castOf(recipe, extra.look),
      mood: extra.mood,
      loras: loras.filter((l) => l.weight !== 0).map((l) => ({
        name: (l.file.split(/[\\/]/).pop() ?? l.file).replace(/\.[a-z]+$/i, ""), weight: l.weight,
        trigger: (JSON.parse(info.find((x) => x.file === l.file)?.info ?? "{}") as { trigger?: string }).trigger,
      })),
      seesPicture: sees,
    };
  }

  /** One turn of the conversation about a form. */
  app.post("/api/designer", async (req) => {
    const b = body.parse(req.body);
    const recipe = recipeOf(b.recipe);
    if (!boxesOf(recipe).length) throw new DesignerError("This model has no text to write.");
    if (!b.messages.length || b.messages.at(-1)!.role !== "user") throw new DesignerError("Say what you want first.");
    const settings = await readSettings(s.db);
    const llm = llmInUse(settings);
    const picture = llm?.vision ? await pictureOf(recipe, b.values) : null;
    const ctx = await context(recipe, b.values, b, Boolean(picture));
    const system = systemPrompt(recipe, s.registry.family(recipe.family), b.mode, ctx, undefined, instructionsInUse(settings));
    const history: Message[] = b.messages.map((m) => ({ role: m.role, content: m.content }));
    // the picture rides with the last thing the user said
    if (picture) history[history.length - 1] = { role: "user", content: [{ type: "text", text: b.messages.at(-1)!.content }, { type: "image_url", image_url: { url: picture } }] };
    // as much of the conversation as the model can read, the latest first
    const raw = await chat(llm, [{ role: "system", content: system }, ...(llm ? fitting(llm, system, history) : history)]);
    return { ...parseReply(raw, recipe, ctx.values), sawPicture: Boolean(picture) };
  });

  /** A scene as several clips: the designer writes the text of each, nothing is rendered. */
  app.post("/api/designer/plan", async (req) => {
    const b = z.strictObject({
      recipe: z.string().min(1), idea: z.string().min(1).max(4000), clips: z.number().int().min(2).max(12),
      values: z.record(z.string(), z.unknown()).default({}), look: lookSchema.nullable().optional(), mood: z.string().max(2000).optional(),
    }).parse(req.body);
    const recipe = recipeOf(b.recipe);
    const settings = await readSettings(s.db);
    const llm = llmInUse(settings);
    const picture = llm?.vision ? await pictureOf(recipe, b.values) : null;
    const ctx = await context(recipe, b.values, b, Boolean(picture));
    const system = systemPrompt(recipe, s.registry.family(recipe.family), "plan", ctx, { clips: b.clips }, instructionsInUse(settings));
    // a plan is one answer holding every clip: it needs room for each, within what the model can hold
    const room = llm ? Math.max(llm.maxOutputTokens, Math.min(700 * b.clips + 500, Math.floor(llm.contextSize / 2))) : undefined;
    const ask: Message = { role: "user", content: picture ? [{ type: "text", text: b.idea }, { type: "image_url", image_url: { url: picture } }] : b.idea };
    // a model that ignores the format once usually follows it the second time
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = parseReply(await chat(llm, [{ role: "system", content: system }, ask], { maxTokens: room }), recipe, {});
      if (reply.kind === "plan") return { note: reply.note, clips: reply.clips.slice(0, b.clips) };
      if (reply.kind === "question") return { note: reply.question, clips: [] };
    }
    throw new DesignerError("The language model did not return a usable plan. Try again, or say it another way.");
  });

  /** Ask a language model one word, to see that the address, the model and the key work: the one named, else the one in use. */
  app.post("/api/designer/test", async (req) => {
    const { id } = z.strictObject({ id: z.string().optional() }).parse(req.body ?? {});
    const settings = await readSettings(s.db);
    const llm = id ? settings.llms.find((l) => l.id === id) : llmInUse(settings);
    // room for a model that thinks before it says its one word
    const answer = await chat(llm, [{ role: "user", content: "Answer with the single word: ready" }], { maxTokens: Math.min(llm?.maxOutputTokens ?? 400, 400), temperature: 0 });
    return { ok: true, model: llm!.model, answer: answer.slice(0, 80) };
  });

  /** A fresh start everywhere: every conversation with the designer is forgotten, in drafts and on timelines. What it wrote into forms stays. */
  app.delete("/api/designer/conversations", async () => {
    const drafts = await s.db.updateTable("drafts").set({ chat: null }).where("chat", "is not", null).executeTakeFirst();
    const clips = await s.db.updateTable("clips").set({ chat: null }).where("chat", "is not", null).executeTakeFirst();
    return { forgotten: Number(drafts.numUpdatedRows ?? 0) + Number(clips.numUpdatedRows ?? 0) };
  });
}
