import { describe, expect, it } from "vitest";
import type { HistoryJob } from "../src/api";
import { fixLink } from "../src/screens/queue/fixLink";
import { rowFacts, rowName } from "../src/screens/queue/historyText";

type Made = HistoryJob["made"][number];
const made = (m: Partial<Made>): Made => ({ id: "a1", kind: "image", width: 1536, height: 864, durationMs: null, kept: false, inBin: false, name: "", ...m });
const job = (j: Partial<Pick<HistoryJob, "label" | "kind" | "status" | "made">>) => ({ label: "Sample job", kind: "render" as const, status: "done" as const, made: [], ...j });

describe("a failed job's link to its fix", () => {
  it("opens the settings tab the error names", () => {
    expect(fixLink("Both are one click in Settings → Models. Or pick another route.")).toEqual({ href: "/settings/models", label: "Open Settings › Models" });
    expect(fixLink("Turn it on (Settings → Models → Missing models says how).")?.href).toBe("/settings/models");
    expect(fixLink("Add one in Settings › Command bar first")?.href).toBe("/settings/bar");
  });
  it("offers nothing when no tab is named", () => {
    expect(fixLink(null)).toBeNull();
    expect(fixLink("out of memory")).toBeNull();
    expect(fixLink("Turn it on in Settings.")).toBeNull();
    expect(fixLink("Settings → Nowhere")).toBeNull();
  });
});

describe("a history row's words", () => {
  it("is called after what it made, else the job's label", () => {
    expect(rowName([job({ made: [made({ name: "Harbour at dusk 01" })] })])).toBe("Harbour at dusk 01");
    expect(rowName([job({ made: [made({})] })])).toBe("Sample job");
  });
  it("says the kind and the size or length", () => {
    expect(rowFacts([job({ made: [made({})] })])).toBe("picture · 1536×864");
    expect(rowFacts([job({ made: [made({ kind: "video", width: 1024, height: 576, durationMs: 5900 })] })])).toBe("video · 0:05.9 · 1024×576");
    expect(rowFacts([job({ made: [made({})] }), job({ made: [made({ id: "a2" })] })])).toBe("2 pictures · 1536×864");
    expect(rowFacts([job({ kind: "cut", made: [made({ kind: "video" })] })])).toBe("cut · 1 video in the library");
    expect(rowFacts([job({ kind: "cut", label: "Timeline 1 · clip 2 · finish" })])).toBe("finish · a new take of the clip");
    expect(rowFacts([job({ status: "cancelled" })])).toBe("cancelled");
    expect(rowFacts([job({})])).toBe("its result was deleted since");
  });
});
