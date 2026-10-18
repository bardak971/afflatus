import { hasWildcards, type Family, type Recipe, type ReferenceRole } from "@afflatus/core";
import { boxesOf, type DesignerContext } from "./designerContext";
import { UpstreamError } from "./llm";
import type { OutputCheck } from "./outputChecks";

/**
 * What the prompt designer tells the language model (the family's guide, the form, its context) and how its reply is
 * read: labelled lines into the form's boxes, and what is wrong with a reply that has to be asked for again.
 */

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

const ROLE_WORDS: Record<ReferenceRole, string> = { person: "who someone is", place: "the place", clothing: "what is worn", object: "a thing in it", style: "the look" };

/** The reference pictures, said by number: the text points at them, or knows that Afflatus says what each one is. */
function pictures(p: NonNullable<DesignerContext["pictures"]>): string {
  const lines = p.list.map((r, i) => `- picture ${p.first + i}: ${ROLE_WORDS[r.role]}${r.whose ? ` (${r.whose})` : ""}`).join("\n");
  const how = p.introduced
    ? "Afflatus tells the model what each one is itself: do not name or number them in the text."
    : `Where the text needs one, point at it the way this model's guide says, by its number${p.first === 2 ? " (picture 1 is the picture being changed)" : ""}.`;
  return `The model is given these reference pictures:\n${lines}\nWhat they show, it takes from them: never describe a face, hair, build or garment a picture already shows. ${how}`;
}

export function systemPrompt(recipe: Recipe<any>, family: Family | undefined, mode: "chat" | "enhance" | "plan", ctx: DesignerContext, plan?: { clips: number }, own = ""): string {
  const boxes = boxesOf(recipe);
  const main = boxes.find((b) => !b.optional) ?? boxes[0];
  const video = recipe.output === "video";
  // the form's own rules over its family's (a swap's prompt is the Character-Swap LoRA's sentence, not a scene)
  const guide = recipe.guide ?? family?.guide ?? GENERIC[main?.style === "tags" ? "tags" : "sentences"];
  const now = boxes.map((b) => `${b.id}: ${ctx.values[b.id]?.trim() || "(empty)"}`).join("\n");
  const parts = boxes.map((b) => `- ${b.id}: "${b.label}"${b.optional ? " (may stay empty)" : ""}, written as ${b.style === "tags" ? "tags" : "sentences"}${b.note ? ` — ${b.note}` : ""}`).join("\n");
  // the LoRAs that will be on it, named as madeFrom names them: a LoRA the source was made with may be on it again
  const inUse = new Set([...(ctx.loras ?? []), ...(ctx.kitLoras ?? [])].map((l) => l.name));
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
              : `Take those from them, in your own words and in the way THIS model's prompts are written; do not copy their tags or quality words, and do not add what they do not say.${ctx.cast?.length ? " Except how the people of the cast below look: that is added on its own." : ""}`
          } A LoRA named there ${inUse.size ? "and not listed as in use below " : ""}shaped how it looks and is NOT in use now: where its look matters, say that look in plain words, never its trigger words.`
      : "",
    ctx.opensOnPicture && !ctx.seesPicture && !ctx.madeFrom?.length ? "You cannot see that picture. Never invent a place, props, light, weather, clothing or other people for it: say nothing about the setting and describe only the motion, the expression, the sound and the camera, unless the user says what the picture shows." : "",
    ctx.opensOnPicture && !ctx.seesPicture && ctx.madeFrom?.length ? "You cannot see the picture itself: what you know of it is the prompt it was made from. Do not invent what that prompt does not say." : "",
    ctx.seesPicture ? "You are shown the picture. Describe what is really in it; do not add a place, props or people it does not show unless the user asks." : "",
    ctx.cast?.length ? `Who is in it. These words are added on their own when it is made, exactly as here: never repeat, reword or contradict them, refer to the people by what they are (the woman, he):\n${ctx.cast.map((c) => `- ${c.name}: ${c.words || "(no words)"}`).join("\n")}` : "",
    ctx.pictures ? pictures(ctx.pictures) : "",
    ctx.voice ? `The model is given a voice sample${ctx.voice.whose ? ` (${ctx.voice.whose}'s)` : ""}: the person speaks with that voice. Write what is said and how, never what the voice sounds like.` : "",
    ctx.mood?.trim() ? `The look and mood of the whole video, which every clip keeps. It is added at the end of the text on its own when it is made: do not write it again or reword it, and write nothing that fights it:\n${ctx.mood.trim()}` : "",
    ctx.style ? `The style ${ctx.style.name} is added at the end of the text on its own when it is made: do not write it again or reword it, and write nothing that fights it:\n${ctx.style.words.slice(0, 600)}` : "",
    ctx.snippets?.length ? `These bits of text are added after the main text on their own when it is made: do not repeat or contradict them.\n${ctx.snippets.map((x) => `- ${x.name}: ${x.text.slice(0, 400)}`).join("\n")}` : "",
    Object.values(ctx.values).some(hasWildcards) ? "Choices in braces like {red|black|white} are the user's: one is picked for each picture. Keep them exactly as written, braces and bars included, unless asked to change them." : "",
    ctx.kitLoras?.length ? `LoRAs the cast and the style add when it is made: ${ctx.kitLoras.map((l) => `${l.name} (${l.from})`).join("; ")}. Their trigger words are added with them: never write them.` : "",
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
export function nudge(trouble: Trouble, recipe: Recipe<any>): string {
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
