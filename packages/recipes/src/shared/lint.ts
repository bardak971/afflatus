import { WEIGHT_SYNTAX, wordCount, type LintInput, type PromptLine } from "@afflatus/core";

/** Qwen Image's rule, its authors' own rewriter: under 200 words, and no weights (Family.lint). */
export function qwenLint({ text, main }: LintInput): PromptLine[] {
  if (!text?.trim()) return [];
  const out: PromptLine[] = [];
  const n = wordCount(text);
  if (n > 200) out.push({ part: main, text: `${n} words; Qwen's own rewriter stops at 200.` });
  if (WEIGHT_SYNTAX.test(text)) out.push({ part: main, text: "A (word:1.2) weight: Qwen does not read weights." });
  return out;
}

/**
 * Qwen Image 2.1's: no weights. No word cap: its authors' rewriter (Qwen-Image-2.1-PE-T2I) writes 400 to 500 words for a new
 * picture, and the 200 of Qwen Image's held the designer to prompts shorter than the model was trained on.
 */
export function qwen21Lint({ text, main }: LintInput): PromptLine[] {
  if (!text?.trim() || !WEIGHT_SYNTAX.test(text)) return [];
  return [{ part: main, text: "A (word:1.2) weight: Qwen does not read weights." }];
}
