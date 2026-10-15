import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useInputEdits } from "../../src/hooks";

/**
 * A form's changes made on its inputs as they stand: a field that sets two inputs at once (the part of a sound, its start
 * then its length) keeps both, where the second, made on the inputs drawn, put the start back (a lip sync's recording in
 * the timeline snapped back to 0 and grew shorter, 2026-10-15).
 */
describe("a form's changes, one after another", () => {
  it("keeps both of two changes sent before the form is drawn again", () => {
    const saved: Record<string, unknown>[] = [];
    const { result } = renderHook(({ stored }) => useInputEdits(stored, (next) => saved.push(next)), { initialProps: { stored: { prompt: "a", audio_start: 0, audio_seconds: 6.4 } as Record<string, unknown> } });
    result.current("audio_start", 2.6);
    result.current("audio_seconds", 3.8);
    expect(saved.at(-1)).toEqual({ prompt: "a", audio_start: 2.6, audio_seconds: 3.8 });
  });

  it("builds on the inputs drawn anew, not on a change the screen did not take", () => {
    const saved: Record<string, unknown>[] = [];
    const { result, rerender } = renderHook(({ stored }) => useInputEdits(stored, (next) => saved.push(next)), { initialProps: { stored: { a: 1 } as Record<string, unknown> } });
    result.current("a", 2);
    // the clip was changed elsewhere meanwhile (an Undo): what is drawn now is what the next change is made on
    rerender({ stored: { a: 5, b: 1 } });
    result.current("b", 2);
    expect(saved.at(-1)).toEqual({ a: 5, b: 2 });
  });
});
