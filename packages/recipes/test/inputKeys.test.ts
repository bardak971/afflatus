import { describe, expect, it } from "vitest";
import { dryContext, parseInput } from "@afflatus/core";
import { recipes } from "../src";

/**
 * parseInput hands build() what the form's schema gave, cast to the recipe's own input type: nothing ties the two
 * together but this. A field build() reads that the form has no input for is always undefined (a renamed input,
 * a typo), and the cast hides it; an input whose default the schema did not fill reaches build() as nothing.
 */
describe("every built-in recipe's input", () => {
  for (const recipe of recipes) {
    it(`${recipe.id}: is its form's inputs, and build() reads no other field`, () => {
      const ids = new Set(recipe.inputs.map((i) => i.id));
      for (const v of recipe.variants) {
        const parsed = parseInput(recipe, v.input) as Record<string, unknown>;
        for (const k of Object.keys(parsed)) expect(ids.has(k), `${v.name}: ${k}`).toBe(true);
        for (const i of recipe.inputs) if ("default" in i && i.default !== undefined) expect(Object.hasOwn(parsed, i.id), `${v.name}: ${i.id}`).toBe(true);
        const read = new Set<string>();
        const watched = new Proxy(parsed, { get: (t, k) => (typeof k === "string" && read.add(k), Reflect.get(t, k)), has: (t, k) => (typeof k === "string" && read.add(k), Reflect.has(t, k)) });
        recipe.build(watched as never, dryContext({ slots: v.slots ?? {}, uploads: v.uploads ?? {}, media: v.media ?? {}, ...(v.canvas ? { canvas: v.canvas } : {}), ...(v.has ? { has: v.has } : {}) }));
        recipe.nodes(watched as never);
        const strays = [...read].filter((k) => !ids.has(k) && !Object.hasOwn(Object.prototype, k) && k !== "then" && k !== "toJSON");
        expect(strays, v.name).toEqual([]);
      }
    });
  }
});
