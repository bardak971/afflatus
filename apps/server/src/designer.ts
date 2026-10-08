import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hasWildcards, type Family, type InputSpec, type Recipe } from "@afflatus/core";
import { lookSchema } from "./entities";
import { httpError } from "./errors";
import type { Services } from "./services";
import { designerContext } from "./designerContext";
import { instructionsInUse, llmInUse, readSettings, type Llm } from "./settings";
import { cleanTags } from "./tags";
import { checkOutput, type OutputCheck } from "./outputChecks";

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
 */

/**
 * Why a call never got an answer, in words: Node says "fetch failed" for every network failure and keeps
 * the reason in the error's cause (the address did not resolve, nothing listens there, it timed out).
 */
function whyNoAnswer(err: unknown): string {
  const e = err as Error & { cause?: { code?: string; message?: string }; name?: string };
  const code = e.cause?.code ?? "";
  if (e.name === "TimeoutError" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT") return "it took too long to answer (timed out).";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "the address could not be found: no internet connection, or the address is misspelt.";
  if (code === "ECONNREFUSED") return "nothing is listening at that address: the server is not running, or the port is wrong.";
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") return "the connection was cut while waiting.";
  if (code === "CERT_HAS_EXPIRED" || /certificate/i.test(e.cause?.message ?? "")) return `its certificate was refused (${e.cause?.message}).`;
  return e.cause?.message ? `${e.message} (${e.cause.message}).` : `${e.message}.`;
}

export class DesignerError extends Error {
  statusCode = 400;
}

/** The language model failed us (no answer, a refusal, nothing usable): the server in front of it answers 502, not the asker's 400. */
export class UpstreamError extends DesignerError {
  override statusCode = 502;
}

/**
 * A conversation as it is stored with a draft or a clip. One that outgrows its room loses its oldest
 * exchanges: cutting the text itself would leave something that cannot be read back at all.
 */
export function chatJson(chat: unknown[], most = 256 * 1024): string | null {
  let kept = chat;
  let json = JSON.stringify(kept);
  while (json.length > most && kept.length > 2) {
    kept = kept.slice(2);
    json = JSON.stringify(kept);
  }
  return kept.length && json.length <= most ? json : null;
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

/** What one exchange came back with: the answer, whether the model thought before it (a <think> part, or a reasoning field), and how long it took. */
export interface Reply { said: string; thought: boolean; ms: number }

/** One plain exchange with the language model, with what else came back. A busy server is asked a second time. */
export async function ask(cfg: Llm | undefined, messages: Message[], opts: { temperature?: number; maxTokens?: number } = {}): Promise<Reply> {
  if (!cfg || !cfg.baseUrl.trim() || !cfg.model.trim()) throw new DesignerError("The designer has no language model yet. Give it one in Settings.");
  const started = Date.now();
  const send = () =>
    fetch(`${cfg.baseUrl.trim().replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify({
        model: cfg.model, messages, stream: false, max_tokens: opts.maxTokens ?? cfg.maxOutputTokens, temperature: opts.temperature ?? 0.6,
        // asked not to think first: the field llama.cpp, vLLM and SGLang read, and the one Ollama reads
        ...(cfg.noThinking ? { chat_template_kwargs: { enable_thinking: false }, think: false } : {}),
      }),
      signal: AbortSignal.timeout(120_000),
    });
  let res: Response;
  try {
    res = await send();
    if (res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1200));
      res = await send();
    }
  } catch (err) {
    throw new UpstreamError(`The language model did not answer at ${cfg.baseUrl}: ${whyNoAnswer(err)}`);
  }
  if (!res.ok) throw new UpstreamError(`The language model refused (${res.status}): ${(await res.text().catch(() => "")).slice(0, 300)}`);
  const data = (await res.json().catch(() => ({}))) as { choices?: Array<{ message?: { content?: string; reasoning_content?: string; reasoning?: string }; finish_reason?: string }> };
  const message = data.choices?.[0]?.message;
  const raw = message?.content ?? "";
  const thought = /<think>/i.test(raw) || Boolean(message?.reasoning_content || message?.reasoning);
  // a model that thinks before it answers may leave its thinking in the answer: it is not part of it
  const said = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^[\s\S]*<\/think>/i, "").trim();
  if (!said && data.choices?.[0]?.finish_reason === "length") {
    throw new UpstreamError(`The language model used its whole answer (${opts.maxTokens ?? cfg.maxOutputTokens} tokens) before it wrote anything, as a model that thinks first can. Raise "Max output tokens" for it in Settings.`);
  }
  return { said, thought, ms: Date.now() - started };
}

/** One plain exchange with the language model: its answer. */
export async function chat(cfg: Llm | undefined, messages: Message[], opts: { temperature?: number; maxTokens?: number } = {}): Promise<string> {
  return (await ask(cfg, messages, opts)).said;
}

/** A 32 × 32 picture filled with red, shown to a model said to read pictures: it is asked its colour. */
const RED_SQUARE = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAKUlEQVR42u3NQQkAAAgEsBPs31gwhQ9hK7Ca3OoIBAKBQCAQCASCJ8ECA4QBews3utwAAAAASUVORK5CYII=";

/** How a family's prompts are written, when the family does not say itself. */
const GENERIC: Record<"tags" | "sentences", string> = {
  tags: `A GOOD PROMPT is comma-separated tags, most important first: the subject and how many, their look, the outfit one tag per garment, the expression, the pose, the framing and camera angle, the place and time of day, the light. One idea per tag, concrete, lower case, no contradictions.`,
  sentences: `A GOOD PROMPT is plain sentences, present tense, concrete nouns: who and what they do, what they wear, the place with a few concrete details, the light, the camera (framing, angle, one move for a video). One moment for a picture; for a video, the motion over time ("at first", "then", "as she…"). No tag lists, no weights.`,
};

/** A family's prompting guide as the designer is handed it: the built-in text, or the generic one for a family that has none. */
export const builtInGuide = (family: Family): string => family.guide ?? GENERIC[family.promptStyle === "tags" ? "tags" : "sentences"];

/** The family with the guide in use: the user's own from Settings when one is written, else the built-in. */
export function guidedFamily(family: Family | undefined, settings: { designerGuides: Record<string, string> }): Family | undefined {
  if (!family) return undefined;
  const own = settings.designerGuides[family.id]?.trim();
  return own ? { ...family, guide: own } : family;
}

/** The text boxes of a recipe: what the designer may write in. */
export const boxesOf = (recipe: Recipe<any>) => (recipe.inputs as InputSpec[]).filter((i): i is Extract<InputSpec, { type: "prompt" }> => i.type === "prompt");

export interface DesignerContext {
  /** What each text box holds now (input id → text). */
  values: Record<string, string>;
  seconds?: number | null;
  /** What the clip before it says happens, when this clip carries on from it. */
  previous?: string;
  /** What the clip after it says happens, when this clip has to end where that one begins. */
  next?: string;
  /** The clip is put between two others, in place of a stretch that was cut out. */
  between?: boolean;
  /** The whole video this clip is part of: what every clip says happens, in the order they play, and which one is being written. */
  story?: { clips: string[]; index: number };
  opensOnPicture?: boolean;
  endsOnPicture?: boolean;
  /**
   * How the pictures of the form were made, when Afflatus made them: every step back to the first prompt
   * (a picture that was upscaled, edited, or saved out of a video has its story behind it). It is what a
   * picture shows, in words, for a language model that cannot look at it, and a help for one that can.
   */
  madeFrom?: Array<{ what: string; steps: Array<{ title: string; with?: string; text: string; more: Array<{ label: string; text: string }>; loras: Array<{ name: string; trigger?: string }> }> }>;
  /** Who is in it, as names with their words: they are added on their own, the designer must not repeat them. */
  cast?: Array<{ name: string; words: string }>;
  /** The look and mood of the whole video. */
  mood?: string;
  loras?: Array<{ name: string; weight: number; trigger?: string }>;
  /** Bits of text the user ticked: they are added after the main text on their own. */
  snippets?: Array<{ name: string; text: string }>;
  /** The model makes the sound too: people can speak in the clip. */
  speaks?: boolean;
  /** The model file picked in the form, by name, when the form has a model picker: a guide can speak by lineage. */
  model?: string | null;
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
    // how much can be said in it: a figure to fill, not only to stay under (models left to themselves write lines far shorter than fit)
    video && ctx.seconds && ctx.speaks
      ? `SPOKEN LINES: about ${Math.round(ctx.seconds * 2.5)} words fit in this clip in all (speech runs about 2.5 words a second, and people speak while they move: the action does not need silence). A line the user wrote is kept whole when it fits in that. When YOU write what is said, use the room: ${Math.max(3, Math.round(ctx.seconds * 1.7))} to ${Math.round(ctx.seconds * 2.5)} words in all, unless the user asks for less. Do not stop at a few words when the clip has room for a full sentence or two.`
      : "",
    ctx.story && ctx.story.clips.length > 1
      ? `THE WHOLE VIDEO is ${ctx.story.clips.length} clips that play one after the other. You are writing clip ${ctx.story.index + 1}. What each clip says happens:\n${ctx.story.clips
          .map((c, i) => `${i + 1}.${i === ctx.story!.index ? " (THIS CLIP)" : ""} ${c.trim().slice(0, 700) || "(nothing written yet)"}`)
          .join("\n")}\nKeep it one story: do not show again what an earlier clip already showed, lead into what the next clip needs, and keep the people, the place, the clothes and the mood the same from clip to clip unless the user says otherwise. You only write clip ${ctx.story.index + 1}.`
      : "",
    ctx.previous ? `This clip CONTINUES the clip before it (the model is given that clip's last frames): carry the action on from where it ended, nothing resets. Restate how the people look in a short clause, so they stay the same people even if that clip ended on a close-up. What the clip before says, which has ALREADY HAPPENED and is not to be shown or said again:\n${ctx.previous.slice(0, 2500)}\nWrite ONLY what comes after it: the next action, and new words if someone speaks (never the same line a second time). A text that says again what the clip before says is wrong, however it is reworded.` : "",
    ctx.between ? "This clip is a BRIDGE put between two clips, in place of a stretch that was cut out: it picks up exactly where the clip before stops and must arrive exactly at how the clip after starts. Write only the action of that stretch, as much as fits in the time the clip has: no new scene, no reset, no ending of its own. SPEECH: a line spoken here is finished inside this clip, and it is never the line the clip after says (that line belongs to the clip after: do not start it here). If the clip after opens on speech, this clip ends on a breath, a look or a gesture, not on words." : "",
    ctx.next ? `The clip AFTER this one is already made (the model is given its first frames, or this clip's last frame is its first): the action has to ARRIVE at how it starts, and none of it is shown here. What the clip after says:\n${ctx.next.slice(0, 2500)}` : "",
    ctx.opensOnPicture && !ctx.previous ? "A picture is the FIRST FRAME: the action starts from exactly what it shows." : "",
    ctx.endsOnPicture ? "A picture is the LAST FRAME: the action has to arrive at it." : "",
    ctx.madeFrom?.length
      ? `${ctx.madeFrom
          .map((m) => `${m.what} was made here, in ${m.steps.length === 1 ? "one step" : `${m.steps.length} steps, the oldest first`}:\n${m.steps
            .map((x, i) => `${i + 1}. ${x.title}${x.with ? ` with ${x.with}` : ""}${x.text ? `: ${x.text.slice(0, 1500)}` : " (no text of its own: it worked on the picture as it was)"}${x.more.map((m) => `\n   ${m.label}: ${m.text.slice(0, 500)}`).join("")}${x.loras.length ? `\n   LoRAs on it: ${x.loras.map((l) => `${l.name}${l.trigger ? ` (its words: ${l.trigger})` : ""}`).join("; ")}` : ""}`)
            .join("\n")}`)
          .join("\n\n")}\nThose texts say what it shows and, for a clip, what has already happened and been said: the people and how they look, what they wear, the place, the light; a later step that changes something wins over an earlier one. ${
            video && ctx.opensOnPicture
              ? "THE PICTURE IS THE FIRST FRAME, so all of that is already on screen: do NOT write it again. Not the place, not the light, not the lens or the depth of field, not the clothes. Use those texts only to know who is there and where, keep the people the same with at most one short clause, and write what MOVES from there: the action, the expression, the camera, the sound."
              : "Take those from them, in your own words and in the way THIS model's prompts are written; do not copy their tags or quality words, and do not add what they do not say."
          } A LoRA named there shaped how it looks and is NOT in use now: where its look matters, say that look in plain words, never its trigger words.`
      : "",
    ctx.opensOnPicture && !ctx.seesPicture && !ctx.madeFrom?.length ? "You cannot see that picture. Never invent a place, props, light, weather, clothing or other people for it: say nothing about the setting and describe only the motion, the expression, the sound and the camera, unless the user says what the picture shows." : "",
    ctx.opensOnPicture && !ctx.seesPicture && ctx.madeFrom?.length ? "You cannot see the picture itself: what you know of it is the prompt it was made from. Do not invent what that prompt does not say." : "",
    ctx.seesPicture ? "You are shown the picture. Describe what is really in it; do not add a place, props or people it does not show unless the user asks." : "",
    ctx.cast?.length ? `Who is in it. Their words are added on their own when it is made: never repeat or contradict them, refer to them by what they are (the woman, he):\n${ctx.cast.map((c) => `- ${c.name}: ${c.words || "(no words)"}`).join("\n")}` : "",
    ctx.mood?.trim() ? `The look and mood of the whole video, which every clip keeps: ${ctx.mood.trim()}` : "",
    ctx.snippets?.length ? `These bits of text are added after the main text on their own when it is made: do not repeat or contradict them.\n${ctx.snippets.map((x) => `- ${x.name}: ${x.text.slice(0, 400)}`).join("\n")}` : "",
    Object.values(ctx.values).some(hasWildcards) ? "Choices in braces like {red|black|white} are the user's: one is picked for each picture. Keep them exactly as written, braces and bars included, unless asked to change them." : "",
    ctx.loras?.length ? `LoRAs in use: ${ctx.loras.map((l) => `${l.name} at ${l.weight}${l.trigger ? ` (its trigger words: ${l.trigger})` : ""}`).join("; ")}. A LoRA's trigger words must stay in the text for it to act: never remove them.` : "",
    ctx.model ? `The model file in use: ${ctx.model}.` : "",
  ].filter(Boolean).join("\n\n");

  const task =
    mode === "plan"
      ? `PLAN a longer video as ${plan!.clips} clips that play one after the other as one continuous scene. Clip 1 starts the scene; each next clip starts exactly where the one before ended (the model is given only its last frames), so every clip moves the action on a step and nothing resets. From clip 2 on, restate how the people look in a short clause. Reply with kind: plan, a note, then one CLIP block per clip.`
      : mode === "enhance"
        ? `The user pressed "Improve it": make what is written richer and cleaner without changing what it shows. Keep the subject and the intent, remove contradictions and repeats, fill what is thin. Return the full new text of each part you improve.`
        : main && ctx.values[main.id]?.trim()
          ? `Change what the user asks and keep the rest. Return the FULL new text of each part you change; a part you leave empty stays as it is. If the request is too vague to act on, ask ONE question. If the user only asks you something or wants ideas, answer them.`
          : `Nothing is written yet: write it all from the user's idea. If the idea is too vague to picture, ask ONE question instead. If the user only asks you something or wants ideas, answer them.`;

  return `You are the prompt designer of Afflatus, working on "${recipe.title}"${family ? ` for ${family.name}` : ""}, which makes ${recipe.output === "image" ? "a picture" : recipe.output === "video" ? "a video" : "a sound"}. You shape the prompt with the user in a conversation: your notes are brief, your prompts rich and precise. The user's explicit wishes (length, detail, tone, content) win over every guideline here.
${own.trim() ? `\nTHE USER'S STANDING INSTRUCTIONS FOR YOU (they hold for the whole conversation and win over the guidelines below; the reply format at the end still holds):\n${own.trim()}\n` : ""}
${guide}

The guide's examples show the FORM, not words to reuse: never carry a lens, an aperture, a depth of field, a light, a place, a garment or a mood from an example into a prompt the user's idea does not call for. Technical camera words (focal length, aperture, "shallow depth of field", "bokeh") belong only where a photographic look is asked for or the subject plainly needs them, and even then vary them: a pet phrase that returns in every prompt is a fault. Each prompt is written for its own picture.

THE PARTS YOU WRITE
${parts}

${where ? `CONTEXT\n${where}\n\n` : ""}WHAT IS WRITTEN NOW
${now}

YOUR TASK NOW
${task}

THIS IS A CONVERSATION. Each time, the user wants one of three things:
- the prompt written or changed: kind proposal. Send the text itself. What is not in the parts below does not exist for the user: never say you changed, wrote or printed something without its text being there.
- an answer (what you see, what you think, why, what could be done): kind answer. Say it in the note, in a few plain sentences, as in a chat, and change nothing. When you suggest ideas, put each one in options so that it can be picked with a click.
- you cannot act without knowing one thing: kind question.
If you will not write what is asked, say so in the note with kind answer: never pretend it was done.

REPLY in exactly this plain format, each label at the start of a line, nothing else (leave a label empty when it has nothing):
kind: proposal   (or: answer; or: question — only when you truly cannot act without an answer${mode === "plan" ? "; or: plan" : ""})
${boxes.map((b) => `${b.id}: the WHOLE new text of "${b.label}" when you change it (never a fragment, never only the line that changed: what is not in it is lost), or empty to leave it as it is`).join("\n")}
note: one or two short sentences saying what you did, written AFTER the text above and true to it; for kind answer, your answer
question: the one question (kind: question only)
options: 2 or 3 short things the user might say next, separated by |${mode === "plan" ? `\nthen one block per clip:\nCLIP 1\n${boxes.map((b) => `${b.id}: …`).join("\n")}\nCLIP 2\n…` : ""}`;
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
  /** proposal: text to put in the form. question: it needs to know one thing. answer: it only talks. plan: several clips. */
  kind: "proposal" | "question" | "answer" | "plan";
  note: string;
  /** Input id → its full new text, for the boxes that change. */
  changes: Record<string, string>;
  question: string;
  options: string[];
  /** A plan: the text boxes of each clip, in order. */
  clips: Array<Record<string, string>>;
  /** What the tag check did to what was written, when it is on: tags put right, and tags danbooru does not have. */
  tags?: { fixed: Array<{ from: string; to: string }>; unknown: string[] };
  /** What it wrote held against the model's own rules (a line each); the text is not changed. */
  checks?: OutputCheck[];
  /** It was asked a second time, and this is what it sent then. */
  retried?: boolean;
  /** It said it changed something and sent no text, twice: its note is not to be believed. */
  empty?: boolean;
  /** Parts whose new text is far shorter than what is written (by id: the lengths): it may be a fragment. */
  short?: Record<string, { was: number; now: number }>;
  /** It wrote the clip before again, twice, in place of what comes next. */
  repeats?: boolean;
  /** What the language model sent, when something was off with it: to look at. */
  raw?: string;
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
  const note = (l.note ?? "").trim();
  if (!Object.keys(changes).length) {
    // it only talked: said so, or wrote plain sentences without the labels
    if (/answer/.test(kindLine) && note) return { kind: "answer", note, changes: {}, question: "", options, clips: [] };
    if (!Object.keys(l).length && raw.trim()) return { kind: "answer", note: raw.trim().slice(0, 4000), changes: {}, question: "", options: [], clips: [] };
    if (!note) throw new UpstreamError("The language model returned nothing usable. Try saying it another way.");
  }
  return { kind: "proposal", note, changes, question: "", options, clips: [] };
}

/** The user asked for less text: a much shorter answer is then what was wanted. */
const asksShorter = (said: string) => /\b(short|brief|concise|trim|cut|summar|less|fewer|simpl|tight|condens|compact|court|raccourc|r[ée]sum|k[uü]rz)/i.test(said);

export type Trouble = { kind: "empty" } | { kind: "short"; parts: Record<string, { was: number; now: number }> } | { kind: "repeat"; part: string };

const wordsOf = (text: string) => text.toLowerCase().replace(/<[^>]*>/g, " ").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
/**
 * How much of a text is another one said again, 0 to 1: the share of its runs of three words that the
 * other has too. Rewording a sentence keeps few of them; copying it keeps nearly all.
 */
export function repeated(text: string, other: string): number {
  const runs = (words: string[]) => words.slice(0, -2).map((w, i) => `${w} ${words[i + 1]} ${words[i + 2]}`);
  const mine = runs(wordsOf(text));
  if (mine.length < 6) return 0;
  const theirs = new Set(runs(wordsOf(other)));
  return mine.filter((r) => theirs.has(r)).length / mine.length;
}
/**
 * What is off with a reply that says it changes the prompt: it carries no text (the note claims a
 * change that is not there), or the text of a part is a fraction of what is written (the changed line
 * alone, where the whole part was asked for: using it would wipe the rest).
 */
export function troubleWith(reply: DesignerReply, values: Record<string, string>, said: string, previous?: string): Trouble | null {
  if (reply.kind !== "proposal") return null;
  const ids = Object.keys(reply.changes);
  if (!ids.length) return { kind: "empty" };
  // a clip that carries on from another one, written as that one again: it would show the same thing twice
  if (previous?.trim()) {
    const again = ids.find((id) => repeated(reply.changes[id]!, previous) > 0.6);
    if (again) return { kind: "repeat", part: again };
  }
  if (asksShorter(said)) return null;
  const parts: Record<string, { was: number; now: number }> = {};
  for (const id of ids) {
    const was = (values[id] ?? "").trim().length;
    const now = reply.changes[id]!.length;
    if (was >= 240 && now < was * 0.4) parts[id] = { was, now };
  }
  return Object.keys(parts).length ? { kind: "short", parts } : null;
}

/** What the language model is told when its reply was off, to have it send it again. */
function nudge(trouble: Trouble, recipe: Recipe<any>): string {
  if (trouble.kind === "repeat") {
    return `Your text says again what the clip before says. That clip is over: this one starts where it ended. Reply again in the format with what happens NEXT: a new action that follows from it, and new words if someone speaks. Keep the people, the place and the look; do not reuse its sentences.`;
  }
  if (trouble.kind === "empty") {
    return `Your reply carried no new text: every part was empty, or the same as what is written now. Reply again in the format. If you are changing the prompt, write the WHOLE new text of each part you change, before the note. If you are changing nothing, use kind: answer and say so plainly in the note; if you will not write what was asked, say that.`;
  }
  const labels = boxesOf(recipe);
  const which = Object.entries(trouble.parts).map(([id, n]) => `"${labels.find((b) => b.id === id)?.label ?? id}" (${id}): you sent ${n.now} characters, ${n.was} are written now`).join("; ");
  return `Your text reads as a fragment: ${which}. Reply again in the format with the WHOLE text of each of those parts, your change worked into it and nothing else dropped. If you really mean to replace all of it with the short text, send the same reply again.`;
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
      const checks = checkOutput(recipe, recipe.family, reply.changes, ctx.values);
      if (checks.length) reply.checks = checks.slice(0, 6);
    }
    return { ...reply, sawPicture: Boolean(picture) };
  });

  /** Every family's prompting guide: the built-in text, and the user's own when one is written in Settings. */
  app.get("/api/designer/guides", async () => {
    const settings = await readSettings(s.db);
    return {
      items: s.registry.families().map((f) => ({ id: f.id, name: f.name, style: f.promptStyle, guide: builtInGuide(f), own: settings.designerGuides[f.id] ?? "" })),
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
