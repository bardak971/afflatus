import { describe, expect, it } from "vitest";
import { families, recipes } from "@afflatus/recipes";
import type { RecipeInfo } from "../src/api";
import { toolOf } from "../src/viewer/shared";

// the built-in recipes as /api/recipes lists them (only what toolOf reads)
const all = recipes.map((r) => ({ id: r.id, family: r.family, version: r.version, title: r.title, summary: r.summary, output: r.output, inputs: r.inputs, traits: null }) as unknown as RecipeInfo);
// what each operation's recipes are called, written out here (not read from OPS): a family whose recipe OPS does not know is a miss
const OWN: Record<string, string[]> = { u: [".sharper"], f: [".fix-face"], i: [".paint-over"], e: [".edit", ".redraw"], r: [".outpaint", ".change-shape"] };
const imageFamilies = families.filter((f) => all.some((r) => r.family === f.id && r.output === "image") && f.id !== "tools");

describe("the viewer's operations (U, F, I, E, R)", () => {
  it("find the picture's own family's recipe for every image family that has one", () => {
    const missed: string[] = [];
    for (const f of imageFamilies) {
      const made = all.find((r) => r.family === f.id && r.output === "image")!;
      for (const key of ["u", "f", "i", "e", "r"]) {
        const own = all.find((r) => r.family === f.id && r.output === "image" && OWN[key]!.some((e) => r.id.endsWith(e)));
        if (!own) continue;
        // nothing is ready: the model the picture was made with decides alone
        const tool = toolOf(key, all, families, made.id, () => false);
        if (tool?.family !== f.id) missed.push(`${f.id} ${key} -> ${tool?.id ?? "nothing"}`);
      }
    }
    expect(missed).toEqual([]);
  });

  it("gives SDXL, Flux and Qwen pictures their own Outpaint, not Klein's", () => {
    for (const fam of ["sdxl", "flux", "qwen"]) {
      const made = all.find((r) => r.family === fam && r.output === "image")!;
      expect(toolOf("r", all, families, made.id, () => true)?.id).toBe(`${fam}.outpaint`);
    }
    expect(toolOf("r", all, families, "klein.picture", () => true)?.id).toBe("klein.change-shape");
  });

  it("still finds an Outpaint when Klein is turned off", () => {
    const withoutKlein = all.filter((r) => r.family !== "klein");
    expect(toolOf("r", withoutKlein, families, "sdxl.text-to-picture", () => false)?.id).toBe("sdxl.outpaint");
  });
});
