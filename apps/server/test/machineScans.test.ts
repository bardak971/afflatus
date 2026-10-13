import { describe, expect, it } from "vitest";
import type { RecipeStatus, Scan } from "@afflatus/comfy";
import { familyOn, mergeScans } from "../src/machineScans";
import type { Machine } from "../src/settings";

const machine = (id: string, families: Record<string, boolean> = {}): Machine => ({ id, name: id, url: `http://${id}:8188`, dir: "", takes: "all", families });
const recipe = (id: string, ready: boolean, options: Record<string, string[]> = {}): RecipeStatus => ({
  id, ready, missingNodes: [], missingSlots: ready ? [] : ["model"], emptyInputs: [], missingFiles: [], missing: [], problems: [], limitedBy: [], options,
});
const scan = (recipes: RecipeStatus[], online = true): Scan => ({
  at: "now",
  comfy: online ? ({ online: true, url: "x", nodes: 1 } as Scan["comfy"]) : { online: false, url: "x", error: "away" },
  families: [{ id: "sdxl", slots: [] }, { id: "h3", slots: [] }],
  recipes,
});
const familyOf = (id: string) => (id.startsWith("sdxl") ? "sdxl" : "h3");

describe("familyOn", () => {
  it("takes the machine's switch, then every machine's, then its files", () => {
    expect(familyOn({ families: {} }, machine("a"), "h3", true)).toBe(true);
    expect(familyOn({ families: {} }, machine("a"), "h3", false)).toBe(false);
    expect(familyOn({ families: { h3: false } }, machine("a"), "h3", true)).toBe(false);
    expect(familyOn({ families: { h3: false } }, machine("a", { h3: true }), "h3", false)).toBe(true);
  });
});

describe("mergeScans", () => {
  it("gives one machine's scan unchanged", () => {
    const one = scan([recipe("sdxl-t2i", false)]);
    expect(mergeScans([{ machine: machine("a"), scan: one }], { families: {} }, familyOf)).toBe(one);
  });

  it("is ready where any machine is, and offers every machine's files", () => {
    const a = scan([recipe("sdxl-t2i", true, { ckpt: ["one.safetensors"] }), recipe("h3-i2v", false)]);
    const b = scan([recipe("sdxl-t2i", true, { ckpt: ["two.safetensors", "one.safetensors"] }), recipe("h3-i2v", true, { unet: ["h3.safetensors"] })]);
    const merged = mergeScans([{ machine: machine("a"), scan: a }, { machine: machine("b"), scan: b }], { families: {} }, familyOf);
    expect(merged.recipes.find((r) => r.id === "sdxl-t2i")?.options.ckpt).toEqual(["one.safetensors", "two.safetensors"]);
    expect(merged.recipes.find((r) => r.id === "h3-i2v")?.ready).toBe(true);
  });

  it("leaves out a machine where the family is off, and one that does not answer", () => {
    const a = scan([recipe("h3-i2v", false)]);
    const b = scan([recipe("h3-i2v", true)]);
    const c = scan([recipe("h3-i2v", true)], false);
    const off = mergeScans([{ machine: machine("a"), scan: a }, { machine: machine("b", { h3: false }), scan: b }, { machine: machine("c"), scan: c }], { families: {} }, familyOf);
    expect(off.recipes.find((r) => r.id === "h3-i2v")?.ready).toBe(false);
  });
});
