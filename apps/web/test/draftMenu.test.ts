import { describe, expect, it } from "vitest";
import { draftWords, openRow } from "../src/screens/studio/DraftMenu";
import type { DraftBrief } from "../src/api";

const brief = (over: Partial<DraftBrief>): DraftBrief => ({ id: "d1", recipe: "h3-t2v", title: "a red kite", name: null, updatedAt: "2026-10-15T10:00:00Z", empty: false, projectId: null, ...over });

describe("the open draft's row in the drafts menu", () => {
  it("says the model the open draft is on now, not the list's row from before the save", () => {
    const row = brief({ recipe: "h3-t2v-audio", cover: "out/1.mp4", coverKind: "video", outputs: 3, models: [{ family: "sdxl", outputs: 1 }] });
    const open = brief({ recipe: "h3-t2v", name: "Kite" });
    const shown = openRow(open, [brief({ id: "d2" }), row]);
    expect(shown.recipe).toBe("h3-t2v");
    expect(shown.name).toBe("Kite");
    // what only the list knows stays: its cover and what was made from it
    expect(shown).toMatchObject({ cover: "out/1.mp4", coverKind: "video", outputs: 3, models: [{ family: "sdxl", outputs: 1 }] });
  });

  it("is the open draft itself when the list does not hold it yet", () => {
    const open = brief({ id: "new" });
    expect(openRow(open, [brief({})])).toBe(open);
  });
});

describe("a draft whose model was taken out of Afflatus", () => {
  const data = { recipes: [{ id: "sdxl.txt2img", family: "sdxl", title: "Text to image" }], families: [{ id: "sdxl", name: "SDXL" }] } as unknown as Parameters<typeof draftWords>[0];
  it("names it as it was named, never by its id", () => {
    const words = draftWords(data);
    const d = brief({ recipe: "wananimate.motion", models: [{ family: "wananimate", outputs: 2 }, { family: "sdxl", outputs: 1 }] });
    expect(words.modelLine(d)).toBe("Wan Animate 2 (removed) · SDXL");
    expect(words.familyOf(d.recipe)).toBe("Wan Animate 2");
    // what it made is its own, not another model it was tried on
    expect(words.othersOf(d).map((m) => m.family)).toEqual(["sdxl"]);
  });
});
