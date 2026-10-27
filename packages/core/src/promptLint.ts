/**
 * The words a family's `lint` holds a written prompt to (Family.lint, read by the server's outputChecks.ts):
 * what each model reads or ignores is the family's; these are only the shared ways of spotting it.
 */

/** One miss, for the user: which part of the form (an input id) and one plain line. The text is never changed. */
export interface PromptLine {
  part: string;
  text: string;
}

/** What a family's lint is handed: the main prompt as written (undefined when the reply left it alone), its input id, and every part written. */
export interface LintInput {
  text: string | undefined;
  main: string;
  changes: Record<string, string>;
  /** The clip's sound is a recording: a form made around it (`lipSync`) or one it plays over (`over`). Its words are not the text's. */
  recording?: "lipSync" | "over";
}

/** How many words a prompt has. */
export const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
/** Comma-separated tags, as a tag model reads them. */
export const tagList = (s: string) => s.split(",").map((t) => t.trim()).filter(Boolean);
/** A "(word:1.2)" weight. */
export const WEIGHT_SYNTAX = /\([^()]{1,80}:\s*\d+(\.\d+)?\)/;
/** Quality words some models are trained to ignore. */
export const QUALITY_WORDS = /\b(masterpiece|best quality|8k|4k uhd|ultra[- ]detailed|highly detailed|award[- ]winning|trending on artstation)\b/i;
/** A line of a list. */
export const LIST_LINE = /^\s*(?:[-*•]|\d+[.)])\s+/m;
/** Quoted speech: "…" with a verb of saying near it, a few words between them ("says quietly, in English: "…""). */
export const QUOTED_SPEECH = /\b(?:says?|whispers?|shouts?|asks?|replies|murmurs?|calls?|sings?)\b[^"“.]{0,40}["“][^"”]{2,}["”]/i;
/**
 * A voice told in words: H3's numbered speaker "(S1)", or what a voice sounds like ("a soft, husky voice", "in a calm
 * voice"). A voice-over is a kind of shot, not a voice described.
 */
export const VOICE_DESCRIBED = /\(S\d+\)|\bvoice\b(?![\s-]*over)/i;
