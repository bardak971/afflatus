import type { Recipe } from "@afflatus/core";

/**
 * What the designer wrote, held against the model's own rules, after the fact and without a second call
 * to the language model: a spoken line outside H3's tags, no audio sentence on LTX, dialogue on a model
 * that makes no sound, a prompt longer than the model reads, weights or quality words on a model that
 * ignores them, a camera phrase carried over from the turn before. Each miss is one short line for the
 * user: the text is not changed, the user decides.
 */

export interface OutputCheck {
  /** Which part of the form (an input id). */
  part: string;
  /** One line, plain. */
  text: string;
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
/** Comma-separated tags, as a tag model reads them. */
const tags = (s: string) => s.split(",").map((t) => t.trim()).filter(Boolean);
const WEIGHT = /\([^()]{1,80}:\s*\d+(\.\d+)?\)/;
const QUALITY = /\b(masterpiece|best quality|8k|4k uhd|ultra[- ]detailed|highly detailed|award[- ]winning|trending on artstation)\b/i;
const LIST_LINE = /^\s*(?:[-*•]|\d+[.)])\s+/m;
/** Camera words that come back prompt after prompt when nothing asked for them. */
const CAMERA = /\b(shallow depth of field|bokeh|\d{2,3}\s?mm(?:\s+lens)?|f\/\d(?:\.\d)?|anamorphic|golden hour|rim light(?:ing)?|volumetric light(?:ing)?)\b/gi;
/** Quoted speech: "…" with a verb of saying near it. */
const SPEECH = /(?:says?|whispers?|shouts?|asks?|replies|murmurs?|calls?)\s*[,:]?\s*["“][^"”]{2,}["”]/i;

/**
 * The checks for one reply: `changes` is what the designer wrote per part; `before` what the parts held
 * (for a phrase carried over); `family` the recipe's family id.
 */
export function checkOutput(recipe: Recipe<any>, family: string | undefined, changes: Record<string, string>, before: Record<string, string> = {}): OutputCheck[] {
  const out: OutputCheck[] = [];
  const main = (recipe.inputs as Array<{ id: string; type: string; optional?: boolean; style?: string; label?: string }>).find((i) => i.type === "prompt" && !i.optional);
  const mainId = main?.id ?? "prompt";
  const text = changes[mainId];
  const say = (part: string, t: string) => out.push({ part, text: t });

  if (text !== undefined && text.trim()) {
    const n = words(text);
    switch (family) {
      case "h3": {
        if (/integrated_multimodal_description:|overall_soundscape:|non_diegetic_music:/i.test(text)) say(mainId, "It wrote the layout's field labels into the prompt; Afflatus adds those itself.");
        if (/<d>(?!\s*\[)/i.test(text)) say(mainId, "A spoken line without its language tag: it should read <d>[English] …</d>.");
        if (!/<d>/i.test(text) && SPEECH.test(text)) say(mainId, "Speech in plain quotes: H3 only speaks what is inside <d>[Language] …</d>.");
        if (/\[Shot 1\]/i.test(text) && !/\[Shot 2\]/i.test(text)) say(mainId, "It wrote [Shot 1] itself; that mark is added for it.");
        if (n > 200) say(mainId, `${n} words for one shot; the model's guide wants 100 to 150.`);
        if (/\b(no|not|never|without|don't)\b/i.test(text) && /\b(no|without) (other|extra|additional) (people|person|text|objects?)\b/i.test(text)) say(mainId, "A ban written as a negative: H3 has no negative branch, say the wanted state instead.");
        break;
      }
      case "ltx": {
        if (!/\b(audio|sound|hear|heard|ambien|music|silen)/i.test(text)) say(mainId, "No audio sentence: LTX makes the sound too, and what is not written is not reliably heard. End with \"The audio is …\".");
        if (n > 220) say(mainId, `${n} words; the model's guide stops at 200.`);
        if (LIST_LINE.test(text)) say(mainId, "A list: LTX wants one flowing paragraph.");
        break;
      }
      case "wan": {
        if (/<d>|["“][^"”]{3,}["”]/.test(text) && SPEECH.test(text)) say(mainId, "Dialogue in a Wan prompt: Wan makes no sound, nobody is heard.");
        if (n > 140) say(mainId, `${n} words; the formula prompt works best at 40 to 120.`);
        if (WEIGHT.test(text)) say(mainId, "A (word:1.2) weight: Wan does not read weights.");
        break;
      }
      case "flux": {
        if (n > 90) say(mainId, `${n} words; FLUX.1 keeps detail best under 75.`);
        if (WEIGHT.test(text)) say(mainId, "A (word:1.2) weight: FLUX ignores weights.");
        if (QUALITY.test(text)) say(mainId, "Quality words (masterpiece, 8k…): FLUX ignores them.");
        break;
      }
      case "klein":
      case "krea2": {
        if (WEIGHT.test(text)) say(mainId, "A (word:1.2) weight: this model does not read weights.");
        if (QUALITY.test(text)) say(mainId, "Quality words (masterpiece, 8k…): this model ignores them.");
        if (n > 170) say(mainId, `${n} words; 30 to ${family === "klein" ? 100 : 150} is the range that works.`);
        break;
      }
      case "qwen":
      case "qwen21": {
        if (n > 200) say(mainId, `${n} words; Qwen's own rewriter stops at 200.`);
        if (WEIGHT.test(text)) say(mainId, "A (word:1.2) weight: Qwen does not read weights.");
        break;
      }
      case "sdxl": {
        const list = tags(text);
        if (list.some((t) => /_/.test(t) && !/^\(/.test(t))) say(mainId, "Underscores in tags: danbooru tags are written with spaces (long hair, not long_hair).");
        if (list.some((t) => /^(score_\d|masterpiece|best quality|source_|rating_|safe$|newest$|absurdres|highres)/i.test(t))) say(mainId, "Quality, score or rating tags in the prompt: those belong in Quality tags, set per checkpoint.");
        const dup = list.map((t) => t.toLowerCase().replace(/[()]|:\d+(\.\d+)?/g, "").trim()).filter((t, i, a) => t && a.indexOf(t) !== i);
        if (dup.length) say(mainId, `Repeated tags: ${[...new Set(dup)].slice(0, 4).join(", ")}.`);
        // CLIP reads 75 tokens a chunk; a tag is one to three tokens, so count words with a margin
        if (n > 75) say(mainId, `About ${n} words: over 75 tokens, ComfyUI splits the prompt and the later tags weigh less.`);
        break;
      }
      default:
        break;
    }
    // a camera phrase that was there before and is back: the designer's pet phrase, or the picture's
    const was = before[mainId] ?? "";
    if (was && family !== "sdxl") {
      const now = new Set((text.match(CAMERA) ?? []).map((m) => m.toLowerCase().replace(/\s+/g, " ")));
      const old = new Set((was.match(CAMERA) ?? []).map((m) => m.toLowerCase().replace(/\s+/g, " ")));
      const again = [...now].filter((m) => old.has(m));
      if (again.length) say(mainId, `Camera words carried over from the previous text: ${again.slice(0, 3).join(", ")}. Keep them only if the picture calls for them.`);
    }
  }
  // the other parts of H3: dialogue or music where only sounds go
  if (family === "h3") {
    const sound = changes.soundscape;
    if (sound && /<d>|\bmusic\b|\bsong\b|\bsoundtrack\b/i.test(sound)) say("soundscape", "Dialogue or music in Sound effects: that part is ambience and physical sound only.");
    const music = changes.music;
    if (music && /\bby\s+[A-Z][a-z]+(\s+[A-Z][a-z]+)?\b|\b(Hans Zimmer|Daft Punk|Beatles|Mozart|Beethoven|Taylor Swift)\b/.test(music)) say("music", "An artist or song name in Music: the model takes genre, tempo and instruments, never names.");
  }
  return out;
}
