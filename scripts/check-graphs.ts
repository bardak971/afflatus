/**
 * Builds every variant of every recipe and checks the graph against a ComfyUI node catalog. No GPU.
 *   pnpm check:graphs                              the saved dump in reference/
 *   pnpm check:graphs http://127.0.0.1:8188        a running ComfyUI (reads /object_info only)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkGraph, dryContext, parseInput, type NodeCatalog } from "@studai/core";
import { recipes } from "@studai/recipes";

const saved = fileURLToPath(new URL("../reference/comfy-object-info.json", import.meta.url));
const arg = process.argv[2] ?? saved;
const raw = /^https?:/.test(arg)
  ? await (await fetch(`${arg.replace(/\/+$/, "")}/object_info`)).text()
  : readFileSync(arg, "utf-8");
const catalog = JSON.parse(raw) as NodeCatalog;

let bad = 0;
let count = 0;
for (const recipe of recipes) {
  for (const v of recipe.variants) {
    count++;
    const label = `${recipe.id} · ${v.name}`;
    try {
      const input = parseInput(recipe, v.input);
      const built = recipe.build(input, dryContext({ slots: v.slots ?? {}, uploads: v.uploads ?? {}, media: v.media ?? {}, canvas: v.canvas }));
      const problems = checkGraph(built, catalog);
      const missing = recipe.nodes(input).filter((n) => !Object.values(built.graph).some((node) => node.class_type === n));
      for (const n of missing) problems.push(`nodes() lists ${n}, which the graph does not use`);
      const unlisted = [...new Set(Object.values(built.graph).map((node) => node.class_type))].filter((c) => !recipe.nodes(input).includes(c) && !recipe.optionalNodes?.includes(c));
      for (const n of unlisted) problems.push(`the graph uses ${n}, which nodes() does not list`);
      bad += problems.length;
      console.log(`${problems.length ? "FAIL" : "ok  "} ${label} (${Object.keys(built.graph).length} nodes)${problems.map((p) => `\n     ${p}`).join("")}`);
    } catch (err) {
      bad++;
      console.log(`FAIL ${label}\n     ${(err as Error).message}`);
    }
  }
}
console.log(`\n${count} variants, ${bad} problem${bad === 1 ? "" : "s"}`);
process.exit(bad ? 1 : 0);
