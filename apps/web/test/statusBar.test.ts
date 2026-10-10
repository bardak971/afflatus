import { describe, expect, it } from "vitest";
import { gpuTip, splitLabel } from "../src/StatusBar";
import { expiringSaid } from "../src/screens/studio/expiring";

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

describe("the GPU meter's tip", () => {
  it("gives the GPU's own figure, then the CPU's", () => {
    expect(gpuTip({ name: "Card", load: 2.4 }, 6.2)).toBe("Card: GPU 2 % · CPU 6 %");
    expect(gpuTip({ name: "", load: 40 }, undefined)).toBe("GPU 40 %");
  });
});

describe("the status bar's expiring chip", () => {
  const now = Date.parse("2026-10-09T12:00:00Z");
  it("says when the next and the last go to the bin, a day after their countdown started", () => {
    expect(expiringSaid({ from: "2026-10-08T15:00:00Z", to: "2026-10-08T17:30:00Z" }, now)).toEqual({ next: "3 h", last: "6 h", soon: false });
  });
  it("turns to the warning within the hour, and says nothing when there is nothing", () => {
    expect(expiringSaid({ from: "2026-10-08T12:40:00Z", to: "2026-10-08T12:40:00Z" }, now)).toEqual({ next: "40 min", last: "40 min", soon: true });
    expect(expiringSaid({ from: null, to: null }, now)).toBeNull();
  });
});
