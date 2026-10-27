import { QUOTED_SPEECH, VOICE_DESCRIBED, type Family, type PromptLine, type Recipe } from "@afflatus/core";

/**
 * What the designer wrote, held against the model's own rules, after the fact and without a second call
 * to the language model: a spoken line outside H3's tags, no audio sentence on LTX, dialogue on a model
 * that makes no sound, a prompt longer than the model reads, weights or quality words on a model that
 * ignores them (each family's own `lint`), and a camera phrase carried over from the turn before (here,
 * for every family). Each miss is one short line for the user: the text is not changed, the user decides.
 */

/** One miss: which part of the form (an input id), and one plain line. */
export type OutputCheck = PromptLine;

/** Camera words that come back prompt after prompt when nothing asked for them. */
const CAMERA = /\b(shallow depth of field|bokeh|\d{2,3}\s?mm(?:\s+lens)?|f\/\d(?:\.\d)?|anamorphic|golden hour|rim light(?:ing)?|volumetric light(?:ing)?)\b/gi;

/**
 * What was written as speech on a clip whose sound is a recording (card #129): a line in H3's <d> tags or in quotes, or a
 * voice described. The recording is what is said, in its own voice: the model would draw a mouth saying something else.
 */
function spokenUnder(changes: Record<string, string>, recording: "lipSync" | "over"): OutputCheck[] {
  const out: OutputCheck[] = [];
  const why = recording === "lipSync" ? "the recording is what is said" : "the recording plays over this clip and is all that is heard";
  for (const [part, text] of Object.entries(changes)) {
    if (/<d>/i.test(text) || QUOTED_SPEECH.test(text)) out.push({ part, text: `A spoken line: ${why}, so the text says how they speak, never the words.` });
    else if (VOICE_DESCRIBED.test(text)) out.push({ part, text: `A voice described: ${why}, in its own voice.` });
  }
  return out;
}

/**
 * The checks for one reply: `changes` is what the designer wrote per part; `before` what the parts held
 * (for a phrase carried over); `family` the recipe's family, whose own rules are its `lint`; `recording`, the clip's
 * sound is a recording, made around it or playing over it.
 */
export function checkOutput(recipe: Recipe<any>, family: Family | undefined, changes: Record<string, string>, before: Record<string, string> = {}, recording?: "lipSync" | "over"): OutputCheck[] {
  const main = (recipe.inputs as Array<{ id: string; type: string; optional?: boolean; style?: string; label?: string }>).find((i) => i.type === "prompt" && !i.optional);
  const mainId = main?.id ?? "prompt";
  const text = changes[mainId];
  const own = [...(recording ? spokenUnder(changes, recording) : []), ...(family?.lint?.({ text, main: mainId, changes, recording }) ?? [])];
  // the family's lines on the prompt, then a phrase carried over, then its lines on the other parts
  const out: OutputCheck[] = own.filter((c) => c.part === mainId);
  if (text !== undefined && text.trim()) {
    // a camera phrase that was there before and is back: the designer's pet phrase, or the picture's (a tag prompt has none)
    const was = before[mainId] ?? "";
    if (was && family?.promptStyle !== "tags") {
      const now = new Set((text.match(CAMERA) ?? []).map((m) => m.toLowerCase().replace(/\s+/g, " ")));
      const old = new Set((was.match(CAMERA) ?? []).map((m) => m.toLowerCase().replace(/\s+/g, " ")));
      const again = [...now].filter((m) => old.has(m));
      if (again.length) out.push({ part: mainId, text: `Camera words carried over from the previous text: ${again.slice(0, 3).join(", ")}. Keep them only if the picture calls for them.` });
    }
  }
  return [...out, ...own.filter((c) => c.part !== mainId)];
}
