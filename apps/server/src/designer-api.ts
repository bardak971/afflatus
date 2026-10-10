import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Recipe } from "@afflatus/core";
import { lookSchema } from "./entities";
import { httpError } from "./errors";
import type { Services } from "./services";
import { boxesOf, designerContext } from "./designerContext";
import { builtInGuide, guidedFamily, nudge, parseReply, systemPrompt, troubleWith, type DesignerReply } from "./designerPrompt";
import { ask, chat, DesignerError, fitting, UpstreamError, type Message } from "./llm";
import { instructionsInUse, llmInUse, readSettings, type Llm } from "./settings";
import { cleanTags } from "./tags";
import { checkOutput } from "./outputChecks";

/**
 * The prompt designer: a conversation with a language model (any OpenAI-style address, set in Settings)
 * that writes and improves what a form's text boxes hold. It is given the model's own way of writing
 * prompts (the family's guide), what the boxes hold now, who is in it, the LoRAs in use and, when the
 * language model can read pictures, the picture the clip opens on. It answers with the full new text
 * of each box it changes, with one question, or with a plain answer when it is only talked to.
 *
 * What it says it did is checked against what it sent: a note that claims a change with no text, or a
 * text that is a fragment of what was there, is asked for again once, and said plainly when it stays so.
 *
 * Replies are labelled lines, not JSON: dialogue is full of quotes, and one unescaped quote makes a
 * whole JSON reply unreadable (learned in Noctown).

/** A 32 × 32 picture filled with red, shown to a model said to read pictures: it is asked its colour. */
const RED_SQUARE = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAKUlEQVR42u3NQQkAAAgEsBPs31gwhQ9hK7Ca3OoIBAKBQCAQCASCJ8ECA4QBews3utwAAAAASUVORK5CYII=";

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
  /** The session's own language model and instructions (ids from Settings; "" = no instructions). Left out: the usual ones. */
  llm: z.string().max(40).optional(),
  instruction: z.string().max(40).optional(),
});

/**
 * The language model's reply to one turn, held against what it says it did. A claim with no text, or a
 * fragment in place of the whole text, is asked for again once: models that slip usually put it right
 * when told. What is still wrong after that is marked on the reply (empty, short, a repeat of the clip
 * before), with the raw answer to look at.
 */
async function checkedReply(llm: Llm | undefined, sent: Message[], recipe: Recipe<any>, values: Record<string, string>, said: string, previous: string | undefined): Promise<DesignerReply> {
  const raw = await chat(llm, sent);
  let reply = parseReply(raw, recipe, values);
  const first = troubleWith(reply, values, said, previous);
  if (first) {
    const again = await chat(llm, [...sent, { role: "assistant", content: raw }, { role: "user", content: nudge(first, recipe) }])
      .then((r) => parseReply(r, recipe, values))
      .catch(() => null);
    const second = again && troubleWith(again, values, said, previous);
    if (again && !second) reply = { ...again, retried: true };
    else if (again && second?.kind === "repeat") reply = { ...again, retried: true, repeats: true, raw: raw.slice(0, 6000) };
    else if (first.kind === "repeat" && (!again || second?.kind === "empty")) reply = { ...reply, repeats: true, raw: raw.slice(0, 6000) };
    else if (again && second?.kind === "short") reply = { ...again, retried: true, short: second.parts, raw: raw.slice(0, 6000) };
    else if (first.kind === "short") reply = { ...reply, short: first.parts, raw: raw.slice(0, 6000) };
    // twice nothing: it is shown as what it is, talk with no text behind it
    else reply = { ...reply, kind: "answer", note: again?.note || reply.note, options: again?.options.length ? again.options : reply.options, empty: true, raw: raw.slice(0, 6000) };
  }
  return reply;
}

export function registerDesigner(app: FastifyInstance, s: Services): void {
  const recipeOf = (id: string) => {
    const recipe = s.registry.recipe(id);
    if (!recipe) throw new DesignerError(`there is no recipe called ${id}`);
    return recipe;
  };

  const { pictureOf, madeFrom, carriedOn, context } = designerContext(s);

  /** One turn of the conversation about a form. */
  app.post("/api/designer", async (req) => {
    const b = body.parse(req.body);
    const recipe = recipeOf(b.recipe);
    if (!boxesOf(recipe).length) throw new DesignerError("This model has no text to write.");
    if (!b.messages.length || b.messages.at(-1)!.role !== "user") throw new DesignerError("Say what you want first.");
    const settings = await readSettings(s.db);
    // the conversation's own choice; one that is gone from Settings falls back to the usual one
    const llm = settings.llms.find((l) => l.id === b.llm) ?? llmInUse(settings);
    const own = b.instruction === undefined ? instructionsInUse(settings) : settings.designerInstructions.find((i) => i.id === b.instruction)?.text.trim() ?? "";
    const picture = llm?.vision ? await pictureOf(recipe, b.values) : null;
    const ctx = await context(recipe, b.values, b, Boolean(picture));
    const system = systemPrompt(recipe, guidedFamily(s.registry.family(recipe.family), settings), b.mode, ctx, undefined, own);
    const history: Message[] = b.messages.map((m) => ({ role: m.role, content: m.content }));
    // the picture rides with the last thing the user said
    if (picture) history[history.length - 1] = { role: "user", content: [{ type: "text", text: b.messages.at(-1)!.content }, { type: "image_url", image_url: { url: picture } }] };
    // as much of the conversation as the model can read, the latest first
    const sent: Message[] = [{ role: "system", content: system }, ...(llm ? fitting(llm, system, history) : history)];
    let reply = await checkedReply(llm, sent, recipe, ctx.values, b.messages.at(-1)!.content, ctx.previous);
    // tags written for an anime model are put right against danbooru's list: other names and one-letter typos
    if (settings.tagCheck) {
      const fixed: Array<{ from: string; to: string }> = [];
      const unknown: string[] = [];
      const ignore = (ctx.loras ?? []).map((l) => l.trigger ?? "");
      for (const box of boxesOf(recipe)) {
        if (box.style !== "tags" || box.optional || !reply.changes[box.id]) continue;
        const clean = cleanTags(reply.changes[box.id]!, ignore);
        reply.changes[box.id] = clean.tags;
        fixed.push(...clean.fixed);
        unknown.push(...clean.unknown);
      }
      if (fixed.length || unknown.length) reply.tags = { fixed: fixed.slice(0, 30), unknown: unknown.slice(0, 30) };
    }
    // what it wrote, against the model's rules: said, not changed
    if (reply.kind === "proposal") {
      const checks = checkOutput(recipe, s.registry.family(recipe.family), reply.changes, ctx.values);
      if (checks.length) reply.checks = checks.slice(0, 6);
    }
    return { ...reply, sawPicture: Boolean(picture) };
  });

  /** Every family's prompting guide: the built-in text, and the user's own when one is written in Settings. */
  app.get("/api/designer/guides", async () => {
    const settings = await readSettings(s.db);
    return {
      items: s.registry.families().map((f) => ({ id: f.id, name: f.name, ...(f.imported ? { imported: true as const } : {}), style: f.promptStyle, guide: builtInGuide(f), own: settings.designerGuides[f.id] ?? "" })),
    };
  });

  /** The system prompt the designer would be given for this form, word for word: what it knows, and what it does not. */
  app.post("/api/designer/system", async (req) => {
    const b = body.omit({ messages: true }).parse(req.body);
    const recipe = recipeOf(b.recipe);
    if (!boxesOf(recipe).length) throw new DesignerError("This model has no text to write.");
    const settings = await readSettings(s.db);
    const llm = settings.llms.find((l) => l.id === b.llm) ?? llmInUse(settings);
    const own = b.instruction === undefined ? instructionsInUse(settings) : settings.designerInstructions.find((i) => i.id === b.instruction)?.text.trim() ?? "";
    const sees = Boolean(llm?.vision) && (await pictureOf(recipe, b.values)) !== null;
    const ctx = await context(recipe, b.values, b, sees);
    return { system: systemPrompt(recipe, guidedFamily(s.registry.family(recipe.family), settings), b.mode, ctx, undefined, own), sees };
  });

  /**
   * What the designer will know about a form before anything is said: the pictures whose story it has
   * (and how many steps back it goes), and whether it knows the clip the form carries on from. The panel
   * says so, and offers ways to start that use it.
   */
  app.post("/api/designer/knows", async (req) => {
    const b = z.strictObject({ recipe: z.string().min(1), values: z.record(z.string(), z.unknown()).default({}) }).parse(req.body);
    const recipe = recipeOf(b.recipe);
    const pictures = await madeFrom(recipe, b.values);
    return {
      pictures: pictures.map((p) => ({ what: p.what, steps: p.steps.map((x) => ({ title: x.title, with: x.with ?? null, said: Boolean(x.text) })) })),
      continues: Boolean(await carriedOn(recipe, b.values)),
    };
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
    const system = systemPrompt(recipe, guidedFamily(s.registry.family(recipe.family), settings), "plan", ctx, { clips: b.clips }, instructionsInUse(settings));
    // a plan is one answer holding every clip: it needs room for each, within what the model can hold
    const room = llm ? Math.max(llm.maxOutputTokens, Math.min(700 * b.clips + 500, Math.floor(llm.contextSize / 2))) : undefined;
    const ask: Message = { role: "user", content: picture ? [{ type: "text", text: b.idea }, { type: "image_url", image_url: { url: picture } }] : b.idea };
    // a model that ignores the format once usually follows it the second time
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = parseReply(await chat(llm, [{ role: "system", content: system }, ask], { maxTokens: room }), recipe, {});
      if (reply.kind === "plan") return { note: reply.note, clips: reply.clips.slice(0, b.clips) };
      if (reply.kind === "question") return { note: reply.question, clips: [] };
    }
    throw new UpstreamError("The language model did not return a usable plan. Try again, or say it another way.");
  });

  /**
   * A clip put between two others, written by the designer: what takes the action from the end of the clip
   * before to the start of the clip after, in the clip's time. The texts come back with what the form held
   * when it was asked; the page puts them in unless something was typed meanwhile. `arrive`: the clip
   * whose start this one must reach, when it is not the next (a loop clip arrives at the clip under In).
   */
  app.post<{ Params: { id: string } }>("/api/clips/:id/between", async (req) => {
    const b = z.object({ arrive: z.string().optional() }).parse(req.body ?? {});
    const { view, index } = await s.timelines.whereIs(req.params.id);
    const loopTo = b.arrive ? view.clips.findIndex((c) => c.id === b.arrive) : -1;
    const clip = view.clips[index]!;
    if (!clip.recipe) throw new DesignerError("This clip has no model yet: choose one first.");
    const recipe = recipeOf(clip.recipe);
    const mainOf = (r: Recipe<any>) => boxesOf(r).find((b) => !b.optional) ?? boxesOf(r)[0];
    const sayOf = (c: (typeof view.clips)[number]) => {
      if (c.kind === "still") return `(a picture held on screen for ${(c.lengthMs / 1000).toFixed(1)} s)`;
      const r = c.recipe ? s.registry.recipe(c.recipe) : undefined;
      const m = r ? mainOf(r) : undefined;
      return m ? String(c.inputs[m.id] ?? "") : "(a video added as it is)";
    };
    const before = index > 0 ? view.clips[index - 1] : undefined;
    const after = loopTo >= 0 ? view.clips[loopTo] : view.clips[index + 1];
    const settings = await readSettings(s.db);
    const llm = llmInUse(settings);
    const ctx = await context(recipe, clip.inputs, { previous: before && clip.joined === "continue" ? sayOf(before) : undefined, story: { clips: view.clips.map(sayOf), index }, look: clip.look ?? view.look, mood: view.mood }, false);
    ctx.next = after && (loopTo >= 0 || after.joined === "continue" || ctx.endsOnPicture) ? sayOf(after) : undefined;
    ctx.between = true;
    const system = systemPrompt(recipe, guidedFamily(s.registry.family(recipe.family), settings), "chat", ctx, undefined, instructionsInUse(settings));
    const seconds = ctx.seconds ? `${ctx.seconds} seconds` : "the time it has";
    const ask = loopTo >= 0
      ? `Write what happens in this clip. It closes a loop: it starts from how the clip before ends and must arrive at how clip ${loopTo + 1} starts (the clip after, in this prompt), in ${seconds}, so that the stretch plays round without a jump: a return to the first position, the same framing, nothing new begun. What is written now came from the old clip and describes more than this: replace it with only the return.`
      : `Write what happens in this clip. It is put between the clip before and the clip after: it starts from how the clip before ends and must arrive at how the clip after starts, in ${seconds}. What is written now came from the old clip and describes more than this stretch: replace it with only what happens here.`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = parseReply(await chat(llm, [{ role: "system", content: system }, { role: "user", content: ask }]), recipe, ctx.values);
      if (reply.kind === "proposal" && Object.keys(reply.changes).length) return { changes: reply.changes, note: reply.note, was: ctx.values };
      if (reply.kind === "question") return { changes: {}, note: reply.question, was: ctx.values };
    }
    throw new UpstreamError("The language model did not write the clip. Try again, or write it yourself.");
  });

  /**
   * Ask a language model one word, to see that the address, the model and the key work: the one named, else the one
   * in use. With it, how long the answer took, whether the model thought first, and, for one said to read
   * pictures, whether it names the colour of a red square.
   */
  app.post("/api/designer/test", async (req) => {
    const { id } = z.strictObject({ id: z.string().optional() }).parse(req.body ?? {});
    const settings = await readSettings(s.db);
    const llm = id ? settings.llms.find((l) => l.id === id) : llmInUse(settings);
    if (id && !llm) throw httpError("there is no LLM with this id in Settings", 404);
    // room for a model that thinks before it says its one word
    const room = { maxTokens: Math.min(llm?.maxOutputTokens ?? 400, 400), temperature: 0 };
    const first = await ask(llm, [{ role: "user", content: "Answer with the single word: ready" }], room);
    let vision: { ok: boolean; answer: string } | null = null;
    if (llm?.vision) {
      const seen = await ask(llm, [{ role: "user", content: [{ type: "text", text: "What colour fills this image? Answer with one word." }, { type: "image_url", image_url: { url: `data:image/png;base64,${RED_SQUARE}` } }] }], room)
        .catch((err: Error) => ({ said: err.message, thought: false, ms: 0 }));
      vision = { ok: /\bred\b/i.test(seen.said), answer: seen.said.slice(0, 120) };
    }
    return { ok: true, model: llm!.model, answer: first.said.slice(0, 80), ms: first.ms, thinks: first.thought, vision };
  });

  /** A fresh start everywhere: every conversation with the designer is forgotten, in drafts and on timelines. What it wrote into forms stays. */
  app.delete("/api/designer/conversations", async () => {
    const drafts = await s.db.updateTable("drafts").set({ chat: null }).where("chat", "is not", null).executeTakeFirst();
    const clips = await s.db.updateTable("clips").set({ chat: null }).where("chat", "is not", null).executeTakeFirst();
    return { forgotten: Number(drafts.numUpdatedRows ?? 0) + Number(clips.numUpdatedRows ?? 0) };
  });
}
