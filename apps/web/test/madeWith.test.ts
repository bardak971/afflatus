import { describe, expect, it } from "vitest";
import type { RecipeInfo, Take, TakeMade } from "../src/api";
import { diffWords, madeDiff, madeShown, settingsPatch } from "../src/timeline/madeWith";

/** What a take was made with against its clip's form (card #89): the words, the carried first frame, what Use puts back. */

const recipe = {
  id: "zz.video", title: "Video with audio",
  inputs: [
    { id: "prompt", type: "prompt", label: "Prompt" },
    { id: "negative", type: "prompt", label: "Negative prompt", optional: true },
    { id: "start", type: "image", role: "start", label: "First frame" },
    { id: "end", type: "image", role: "end", label: "Last frame" },
    { id: "previous", type: "clip", role: "previous", label: "Previous" },
    { id: "voice", type: "audio", role: "voice", label: "Voice", window: { start: "voiceStart", seconds: "voiceSeconds" } },
    { id: "voiceStart", type: "number", label: "Voice from" },
    { id: "voiceSeconds", type: "number", label: "Voice length" },
    { id: "steps", type: "number", label: "Steps" },
    { id: "cfg", type: "number", label: "CFG" },
    { id: "goesOn", type: "toggle", label: "", internal: true },
    { id: "seed", type: "seed", label: "Seed" },
  ],
} as unknown as RecipeInfo;
const other = { id: "zz.lipsync", title: "Lip sync", inputs: [] } as unknown as RecipeInfo;
const made = (form: Record<string, unknown>, more: Partial<TakeMade> = {}): TakeMade => ({ recipe: recipe.id, form, mirror: [], ...more });
const diff = (m: TakeMade, whole: Record<string, unknown>, carries = false) => diffWords(madeDiff(m, { recipe, whole, carries }, [recipe, other]));

describe("how a take differs from the form", () => {
  it("names the pinned frames and sounds, says a prompt changed, counts the settings; the seed is not compared", () => {
    expect(diff(made({ prompt: "a", start: "p1", steps: 8, cfg: 1, seed: 5 }), { prompt: "a", start: "p1", steps: 8, cfg: 1, seed: -1 })).toBeNull();
    expect(diff(made({ prompt: "a", start: "p1", end: "e1" }), { prompt: "a", start: "p2" })).toBe("first frame and last frame differ");
    expect(diff(made({ prompt: "a", negative: "x" }), { prompt: "b", negative: "y" })).toBe("prompt and negative prompt changed");
    expect(diff(made({ prompt: "a", steps: 8, cfg: 1 }), { prompt: "a", steps: 20, cfg: 4 })).toBe("2 settings differ");
    // a voice's part is the voice's: one word for the sample and where it is cut
    expect(diff(made({ voice: "v", voiceStart: 2, voiceSeconds: 5 }), { voice: "v", voiceStart: 3, voiceSeconds: 5 })).toBe("voice sample differs");
  });

  it("takes a first frame carried on from the clip before for no picture of the form's", () => {
    expect(diff(made({ prompt: "a" }, { carried: true }), { prompt: "a", start: "old pin" }, true)).toBeNull();
    // carried then, a picture of its own now
    expect(diff(made({ prompt: "a" }, { carried: true }), { prompt: "a", start: "p1" })).toBe("first frame differs");
  });

  it("says the other form, and nothing else, for a take made with another", () => {
    expect(diff(made({ prompt: "a" }, { recipe: other.id }), { prompt: "b" })).toBe("made with Lip sync");
  });

  it("leaves out an input the take's render did not have", () => {
    expect(diff(made({ prompt: "a" }), { prompt: "a", steps: 20 })).toBeNull();
  });
});

describe("what a take shows", () => {
  it("shows a carried first frame as the clip before's, and its voice with its part", () => {
    const s = madeShown(made({ prompt: "walks", end: "e1", voice: "v", voiceStart: 2, voiceSeconds: 5 }, { carried: true, mirror: ["end"] }), recipe);
    expect(s.pins).toEqual([{ where: "start", word: "first frame: the clip before's", asset: null, mirrored: false }, { where: "end", word: "last frame", asset: "e1", mirrored: true }]);
    expect(s.sounds).toEqual([{ word: "voice sample", asset: "v", part: { start: 2, seconds: 5 } }]);
    expect(s.prompt).toBe("walks");
  });
});

describe("Use this take's settings", () => {
  const take = (m: TakeMade) => ({ id: "t1", made: m }) as unknown as Take & { made: TakeMade };

  it("puts the take's form back, takes out what it did not have, keeps what the timeline fills in", () => {
    const p = settingsPatch(take(made({ prompt: "a", start: "p1", seed: 7 }, { mirror: ["start"] })), recipe, { prompt: "b", end: "e9", steps: 20, goesOn: true, gone: 1 }, false);
    expect(p).toEqual({ recipe: recipe.id, inputs: { prompt: "a", start: "p1", seed: 7, goesOn: true }, pinMirror: { start: true, end: false }, settingsOf: "t1" });
  });

  it("pins no first frame for a take that carried on from the clip before", () => {
    const p = settingsPatch(take(made({ prompt: "a" }, { carried: true })), recipe, { prompt: "b", start: "p1" }, true);
    expect(p.inputs).toEqual({ prompt: "a" });
    expect(p.pinMirror).toEqual({ start: false, end: false });
  });
});
