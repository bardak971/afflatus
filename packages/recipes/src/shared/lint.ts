import { WEIGHT_SYNTAX, wordCount, type LintInput, type PromptLine } from "@afflatus/core";

/** Both Qwen families' rule, their authors' own rewriter: under 200 words, and no weights (Family.lint). */
export function qwenLint({ text, main }: LintInput): PromptLine[] {
  if (!text?.trim()) return [];
  const out: PromptLine[] = [];
  const n = wordCount(text);
  if (n > 200) out.push({ part: main, text: `${n} words; Qwen's own rewriter stops at 200.` });
  if (WEIGHT_SYNTAX.test(text)) out.push({ part: main, text: "A (word:1.2) weight: Qwen does not read weights." });
  return out;
}
