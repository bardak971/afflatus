import { describe, expect, it } from "vitest";
import { splitLabel } from "../src/StatusBar";

describe("the status bar's job label", () => {
  it("splits a clip render into what it is and the timeline it is of", () => {
    expect(splitLabel({ label: "Big Air · clip 2 · finish", clipId: "c" })).toEqual({ what: "Clip 2 · finish", of: "Big Air" });
    expect(splitLabel({ label: "A · B · clip 12 · take 1 of 3", clipId: "c" })).toEqual({ what: "Clip 12 · take 1 of 3", of: "A · B" });
  });
  it("keeps any other label whole", () => {
    expect(splitLabel({ label: "Big Air · clip 2", clipId: null })).toEqual({ what: "Big Air · clip 2", of: null });
    expect(splitLabel({ label: "Krea · portrait", clipId: "c" })).toEqual({ what: "Krea · portrait", of: null });
  });
});
