/**
 * Builds every variant of every recipe and checks the graph against a ComfyUI node catalog. No GPU.
 *   pnpm check:graphs                              the saved dump in reference/
 *   pnpm check:graphs http://127.0.0.1:8188        a running ComfyUI (reads /object_info only)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { baseModels, checkGraph, dryContext, parseInput, plural, warmGraph, type NodeCatalog } from "@afflatus/core";
import { recipes } from "@afflatus/recipes";

const saved = fileURLToPath(new URL("../reference/comfy-object-info.json", import.meta.url));
const arg = process.argv[2] ?? saved;
const raw = /^https?:/.test(arg)
  ? await (await fetch(`${arg.replace(/\/+$/, "")}/object_info`)).text()
  : readFileSync(arg, "utf-8");
const catalog = JSON.parse(raw) as NodeCatalog;

/**
 * LTX guides of several frames (a clip's, from LoadVideo) put anywhere but frame 0 off ComfyUI's grid: LTXVAddGuide moves one
 * to the 8k + 1 at or before it (v0.37 to v0.41's nodes_lt.py, get_latent_index), so it lands up to 7 frames early.
 */
function offGrid(graph: Record<string, { class_type: string; inputs: Record<string, unknown> }>): string[] {
  const isRef = (v: unknown): v is [string, number] => Array.isArray(v) && typeof v[0] === "string";
  const fromVideo = (id: string, seen = new Set<string>()): boolean => {
    if (seen.has(id) || !graph[id]) return false;
    seen.add(id);
    return graph[id]!.class_type === "LoadVideo" || Object.values(graph[id]!.inputs).some((v) => isRef(v) && fromVideo(v[0], seen));
  };
  return Object.entries(graph)
    .filter(([, n]) => n.class_type === "LTXVAddGuide" && typeof n.inputs.frame_idx === "number" && n.inputs.frame_idx > 0 && (n.inputs.frame_idx - 1) % 8 !== 0)
    .filter(([, n]) => isRef(n.inputs.image) && fromVideo(n.inputs.image[0]))
    .map(([id, n]) => `${id} LTXVAddGuide: frames of a clip at frame ${n.inputs.frame_idx as number}, which ComfyUI moves to ${Math.floor(((n.inputs.frame_idx as number) - 1) / 8) * 8 + 1}`);
}

let bad = 0;
let count = 0;
for (const recipe of recipes) {
  for (const v of recipe.variants) {
    count++;
    const label = `${recipe.id} · ${v.name}`;
    try {
      const input = parseInput(recipe, v.input);
      const built = recipe.build(input, dryContext({ slots: v.slots ?? {}, uploads: v.uploads ?? {}, media: v.media ?? {}, canvas: v.canvas, ...(v.has ? { has: v.has } : {}) }));
      const problems = checkGraph(built, catalog);
      problems.push(...offGrid(built.graph));
      // a file the build loads without its name: a slot the variant's machine has no file for (Klein 9B read with the 4B's encoder)
      for (const l of built.loads ?? []) if (/\/(undefined|null)?$/.test(l)) problems.push(`loads ${l}: no file`);
      const missing = recipe.nodes(input).filter((n) => !Object.values(built.graph).some((node) => node.class_type === n));
      for (const n of missing) problems.push(`nodes() lists ${n}, which the graph does not use`);
      const unlisted = [...new Set(Object.values(built.graph).map((node) => node.class_type))].filter((c) => !recipe.nodes(input).includes(c) && !recipe.optionalNodes?.includes(c));
      for (const n of unlisted) problems.push(`the graph uses ${n}, which nodes() does not list`);
      // the graph that loads its models ahead of the render: the same graph cut after one step of its first pass
      const warm = warmGraph(built);
      if (warm) for (const p of checkGraph({ ...built, graph: warm.graph, phases: warm.phases, outputs: [] }, catalog)) problems.push(`loading ahead: ${p}`);
      const ahead = warm ? `${Object.keys(warm.graph).length} nodes, ${warm.pass ? "one step" : "loaders only"}` : "nothing to load";
      bad += problems.length;
      console.log(`${problems.length ? "FAIL" : "ok  "} ${label} (${Object.keys(built.graph).length} nodes; ${baseModels(built).length} base models; loading ahead: ${ahead})${problems.map((p) => `\n     ${p}`).join("")}`);
    } catch (err) {
      bad++;
      console.log(`FAIL ${label}\n     ${(err as Error).message}`);
    }
  }
}
console.log(`\n${count} variants, ${plural(bad, "problem")}`);
process.exit(bad ? 1 : 0);
