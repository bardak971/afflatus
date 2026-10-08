import { describe, expect, it } from "vitest";
import type { InputSpec } from "@afflatus/core";
import { withNote } from "../src/fieldNotes";

describe("a setting's ?", () => {
  it("keeps the recipe's own words", () => {
    const spec = { id: "scheduler", type: "choice", label: "Scheduler", options: ["normal"], default: "normal", note: "Its own." } as unknown as InputSpec;
    expect(withNote(spec).note).toBe("Its own.");
  });

  it("takes the list's words by id, then by name as ComfyUI writes it", () => {
    const byId = { id: "scheduler", type: "choice", label: "Scheduler", options: ["normal"], default: "normal" } as unknown as InputSpec;
    expect(withNote(byId).note).toMatch(/noise level falls/);
    // an imported workflow's setting: its id is the node's, its name ComfyUI's
    const byName = { id: "12.cfg", type: "number", label: "CFG", min: 0, max: 30, default: 7 } as unknown as InputSpec;
    expect(withNote(byName).note).toMatch(/prompt is followed/);
  });

  it("says nothing it does not know", () => {
    const spec = { id: "x", type: "number", label: "Something odd", min: 0, max: 1, default: 0 } as unknown as InputSpec;
    expect(withNote(spec).note).toBeUndefined();
  });
});
