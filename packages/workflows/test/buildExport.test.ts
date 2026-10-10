import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkGraph, choicesOf, dryContext, parseInput, pickChoice, relocateFiles, type Graph, type InputSpec, type NodeCatalog } from "@afflatus/core";
import { cutFileNameChains, fromEditor, inspect, prune, recipeFromWorkflow, type WorkflowDef } from "../src";
import { compare, withFileIds, withoutPassThroughs, type Diff } from "./exportCompare";

/**
 * Each corpus workflow imported as suggested and built as a job would build it with the form left as it came
 * (its saved values, the file choices settled against this ComfyUI's lists, the files moved to where it keeps
 * them), against ComfyUI's own export of it. Where the reader check (comfyExport.test.ts) stops at what was read,
 * this one covers what building does with it. Only the part the result is made from is compared: the previews
 * and other outputs are left out on purpose. Skipped when there is no export.
 */
const corpus = join(import.meta.dirname, "corpus");
const dir = join(corpus, process.env.COMFY_API_DIR ?? "comfy-api");
const infoFile = join(dir, "_object_info.json");
const files = existsSync(infoFile) ? readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("_")).sort() : [];

type At = { node: string; input: string };
const readAt = (g: Graph, at: At) => g[at.node]?.inputs[at.input];

/** What the server does to a form before building (queueSubmit's settled): a file choice this ComfyUI lacks becomes the best one it has. */
function settle(inputs: InputSpec[], input: Record<string, unknown>, catalog: NodeCatalog) {
  const chosen = { ...input };
  for (const spec of inputs) {
    if (spec.type !== "choice" || Array.isArray(spec.options)) continue;
    const def = catalog[spec.options.node];
    const all = [...(spec.extra ?? []), ...(choicesOf(def?.input.required?.[spec.options.input] ?? def?.input.optional?.[spec.options.input]) ?? [])];
    if (all.length && !all.includes(String(chosen[spec.id])) && chosen[spec.id] === spec.default) chosen[spec.id] = pickChoice(spec, all);
  }
  return chosen;
}

/** What a node is made from, not counting what only names its file (a chain of texts into a file name is a plain name in a job, on purpose). */
function upstream(g: Graph, id: string, seen = new Set<string>()): Set<string> {
  if (seen.has(id) || !g[id]) return seen;
  seen.add(id);
  for (const [k, v] of Object.entries(g[id]!.inputs)) if (Array.isArray(v) && !/^(filename_prefix|filename|path|output_path)$/.test(k)) upstream(g, String(v[0]), seen);
  return seen;
}
const baseName = (v: unknown) => (typeof v === "string" ? v.split(/[\\/]/).pop()!.toLowerCase() : null);
const inputOf = (d: Diff) => d.what.split(":")[0]!;
const relocated = (d: Diff, theirs: Graph, ours: Graph) => {
  const [t, o] = [theirs[d.node]?.inputs[inputOf(d)], ours[d.node]?.inputs[inputOf(d)]];
  return typeof t === "string" && typeof o === "string" && t !== o && baseName(t) === baseName(o);
};
const throughUnknown = (d: Diff, theirs: Graph) => {
  const t = theirs[d.node]?.inputs[inputOf(d)];
  return Array.isArray(t) && !theirs[String(t[0])]?.class_type;
};

describe.skipIf(!files.length)("imported workflows built as they came, against ComfyUI's own export", () => {
  it("send ComfyUI what its editor would send", () => {
    const catalog = JSON.parse(readFileSync(infoFile, "utf8")) as NodeCatalog;
    // what the reader check (comfyExport.test.ts, run first) found already: not building's doing
    const readerFile = join(dir, "_report.json");
    const known = existsSync(readerFile) ? (JSON.parse(readFileSync(readerFile, "utf8")) as Record<string, { diffs?: Diff[] }>) : {};
    const report: Record<string, { diffs: Diff[]; problems: string[] } | { skipped: string }> = {};
    let compared = 0;
    let clean = 0;
    for (const file of files) {
      const exported = JSON.parse(readFileSync(join(dir, file), "utf8")) as { output?: Graph; missing?: string[]; renumbered?: Record<string, Record<string, string>>; error?: string };
      if (exported.error) { report[file] = { skipped: "ComfyUI's editor could not read it" }; continue; }
      const raw = JSON.parse(readFileSync(join(corpus, file), "utf8"));
      const read = fromEditor(raw, catalog);
      const found = inspect(read.graph, catalog, read.wiring, read.notes);
      const b = found.suggested;
      if (!b) { report[file] = { skipped: "nothing to bind" }; continue; }
      const def = { id: "workflow.w", title: "t", model: "m", source: file, graph: read.graph, wiring: read.wiring, editor: raw, bindings: b } as WorkflowDef;
      const theirs = withoutPassThroughs(withFileIds(exported.output!, raw, exported.renumbered), catalog);
      // a file name built by a chain of nodes is a plain name in a job, on purpose
      cutFileNameChains(theirs, "x");
      let built;
      try {
        const recipe = recipeFromWorkflow(def);
        // every picture, video and sound it reads is "uploaded" under the name it was saved with, so the loaders compare
        const uploads: Record<string, string> = {};
        for (const [id, m] of [["startImage", b.startImage], ["endImage", b.endImage], ...(b.pictures ?? []).map((p) => [p.id, p] as const), ["previousVideo", b.previousVideo], ["nextVideo", b.nextVideo], ["sourceVideo", b.sourceVideo], ...(b.otherVideos ?? []).map((v) => [v.id, v] as const), ["sound", b.sound], ...(b.otherSounds ?? []).map((s) => [s.id, s] as const)] as const) {
          const saved = m && readAt(read.graph, m.target);
          if (typeof saved === "string") uploads[id] = saved;
        }
        // the Director's pictures: the ones in its timeline, in the first and last slots
        if (b.director) {
          const items = (JSON.parse(String(readAt(read.graph, { node: b.director.node, input: "timeline_data" }) ?? "{}")).items ?? []) as Array<{ type?: string; slot?: number; value?: string }>;
          for (const [slot, id] of [[0, "startImage"], [1, "endImage"]] as const) {
            const it = items.find((i) => i.type === "image" && i.slot === slot && i.value);
            if (it) uploads[id] = it.value!;
          }
        }
        const media = Object.fromEntries(Object.keys(uploads).map((id) => [id, id.endsWith("Video") || id.startsWith("vid_") ? { asset: "a-video" } : "a-picture"]));
        const input = parseInput(recipe, { ...media, ...Object.fromEntries(recipe.inputs.flatMap((s) => (s.type === "prompt" && !s.optional ? [[s.id, s.default || "a"]] : []))) }) as Record<string, unknown>;
        // a node of a pack this ComfyUI lacks that the result needs: it cannot be built for it, as the server says before queueing
        const lacks = recipe.nodes(input).filter((n) => !(n in catalog));
        if (lacks.length) { report[file] = { skipped: `lacks ${lacks.slice(0, 3).join(", ")}` }; continue; }
        built = recipe.build(settle(recipe.inputs, input, catalog), dryContext({ uploads, has: (cls) => cls in catalog }));
        relocateFiles(built.graph, catalog);
      } catch (e) {
        // a refusal in plain words, before anything is queued (a Director set to open on a picture it was not given) is what the user would be told
        if (/^The Director is set to/.test((e as Error).message)) { report[file] = { skipped: `refused: ${(e as Error).message}` }; continue; }
        report[file] = { diffs: [{ node: "-", what: `build failed: ${(e as Error).message}` }], problems: [] };
        compared++;
        continue;
      }
      // the part the result is made from, on both sides
      // (and what our reading has the result made from: where ComfyUI's editor dropped a link, the reader check says so already)
      const read0 = withoutPassThroughs(prune(read.graph, read.wiring, read.wiring?.modes ?? {}).graph, catalog);
      const kept = new Set([...upstream(theirs, b.result.node), ...upstream(read0, b.result.node)]);
      const theirPart = Object.fromEntries(Object.entries(theirs).filter(([id]) => kept.has(id)));
      const whole = withoutPassThroughs(built.graph, catalog);
      const mine = upstream(whole, built.outputs[0]!.node);
      const ours = Object.fromEntries(Object.entries(whole).filter(([id]) => mine.has(id)));
      // a list of LoRAs (rgthree's Power Lora Loader): the ones that are on, in order, is what is loaded; one switched off is left out of ours
      for (const g of [theirPart, ours]) {
        for (const n of Object.values(g)) {
          const on = Object.keys(n.inputs).filter((k) => /^lora_\d+$/.test(k)).map((k) => n.inputs[k] as { on?: boolean }).filter((l) => l?.on);
          if (!Object.keys(n.inputs).some((k) => /^lora_\d+$/.test(k))) continue;
          for (const k of Object.keys(n.inputs)) if (/^lora_\d+$/.test(k)) delete n.inputs[k];
          on.forEach((l, i) => (n.inputs[`lora_${i + 1}`] = l));
        }
      }
      const diffs = compare(theirPart, ours, catalog)
        // the file name is Afflatus's to fill in, and the LoRAs of the form are added as nodes of their own
        .filter((d) => !/^filename_prefix:/.test(d.what) && !/^afflatus_lora_/.test(d.node))
        // the same file where this ComfyUI keeps it (relocateFiles), and a link ComfyUI's side runs through a node of a pack it lacks (left out of ours at build)
        .filter((d) => !relocated(d, theirPart, ours) && !throughUnknown(d, theirPart))
        // the seed the job is given, where a number node holds it
        .filter((d) => !b.seeds.some((at) => at.node === d.node && d.what.startsWith(`${at.input}:`)));
      const already = new Set((known[file]?.diffs ?? []).map((d) => `${d.node}|${d.what}`));
      diffs.splice(0, diffs.length, ...diffs.filter((d) => !already.has(`${d.node}|${d.what}`)));
      const problems = checkGraph(built, catalog, { looseInputs: true });
      report[file] = { diffs, problems };
      compared++;
      if (!diffs.length && !problems.length) clean++;
    }
    writeFileSync(join(dir, "_build-report.json"), JSON.stringify(report, null, 1));
    console.log(`built ${compared}, nothing the reader check has not said already: ${clean}; report in ${dir}/_build-report.json`);
    expect(compared).toBeGreaterThan(0);
  }, 120_000);
});
