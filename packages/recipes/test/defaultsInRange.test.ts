import { describe, expect, it } from "vitest";
import { recipes } from "../src";

/** Every number a form opens with is one its own field takes: a default past its limit starts the form out of range. */
describe("defaults", () => {
  it("every number input's default is within its min and max", () => {
    const out: string[] = [];
    for (const r of recipes) {
      for (const i of r.inputs) {
        if (i.type !== "number" || typeof i.default !== "number") continue;
        if ((i.min !== undefined && i.default < i.min) || (i.max !== undefined && i.default > i.max)) out.push(`${r.id} ${i.id}: ${i.default} not in ${i.min}–${i.max}`);
      }
    }
    expect(out).toEqual([]);
  });
});
