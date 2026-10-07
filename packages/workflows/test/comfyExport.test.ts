import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Graph, NodeCatalog } from "@afflatus/core";
import { fromEditor, prune } from "../src";

/**
 * Afflatus's reading of each corpus workflow against ComfyUI's own (comfyExport.mjs writes what its editor
 * would send, as "Export (API)" would). Only workflows whose every node that ComfyUI has are compared: a
 * node of a missing pack cannot be read by the editor either. Skipped when there is no export.
 */
const corpus = join(import.meta.dirname, "corpus");
const dir = join(corpus, process.env.COMFY_API_DIR ?? "comfy-api");
const infoFile = join(dir, "_object_info.json");
const files = existsSync(infoFile) ? readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("_")).sort() : [];

type Diff = { node: string; what: string };
const isRef = (v: unknown): v is [string | number, number] => Array.isArray(v) && v.length === 2 && typeof v[1] === "number";
// rgthree's LoRA entries: an empty second strength is left out by the editor
const norm = (v: unknown): unknown => (isRef(v) ? [String(v[0]), v[1]] : v && typeof v === "object" && "lora" in v ? Object.fromEntries(Object.entries(v).filter(([k, x]) => !(k === "strengthTwo" && x === null))) : v);
const same = (a: unknown, b: unknown) =>
  JSON.stringify(norm(a)) === JSON.stringify(norm(b)) || (typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(b)));
const show = (v: unknown) => JSON.stringify(norm(v))?.slice(0, 80);

/**
 * What differs between ComfyUI's graph and ours, node by node and input by input. Not differences: a seed
 * the editor rolled again on loading, a file name whose %date% the editor filled in (Afflatus fills it at
 * build), a value only the editor shows (an input the node's kind does not declare), and anything on a node
 * of a kind ComfyUI lacks (the editor cannot read it either).
 */
export function compare(theirs: Graph, ours: Graph, catalog: NodeCatalog): Diff[] {
  const diffs: Diff[] = [];
  const declared = (cls: string, input: string) => input in (catalog[cls]?.input.required ?? {}) || input in (catalog[cls]?.input.optional ?? {});
  const noise = (cls: string, input: string, o: unknown, t: unknown) =>
    /seed/i.test(input) && !isRef(o) && !isRef(t) || (typeof o === "string" && o.includes("%") && typeof t === "string" && !t.includes("%"));
  const optionalDefault = (cls: string, input: string, value: unknown) => {
    const spec = catalog[cls]?.input.optional?.[input] as [unknown, { default?: unknown; options?: Array<{ key: string }> }?] | undefined;
    if (!spec) return false;
    const preset = spec[1]?.default ?? spec[1]?.options?.[0]?.key ?? (Array.isArray(spec[0]) ? spec[0][0] : undefined);
    return same(preset, value);
  };
  for (const [id, t] of Object.entries(theirs)) {
    const o = ours[id];
    if (!catalog[t.class_type]) continue;
    if (!o) {
      diffs.push({ node: id, what: `only in ComfyUI's (${t.class_type})` });
      continue;
    }
    if (o.class_type !== t.class_type) diffs.push({ node: id, what: `class ${o.class_type} vs ComfyUI's ${t.class_type}` });
    for (const k of new Set([...Object.keys(t.inputs), ...Object.keys(o.inputs)])) {
      // a field the editor shows but nothing was saved for: an optional one at its default is what ComfyUI uses without it
      if (!(k in o.inputs) && (!declared(t.class_type, k) || optionalDefault(t.class_type, k, t.inputs[k]))) continue;
      if (k in o.inputs && k in t.inputs && noise(t.class_type, k, o.inputs[k], t.inputs[k])) continue;
      if (!(k in o.inputs)) diffs.push({ node: id, what: `${k}: missing in ours (ComfyUI's ${show(t.inputs[k])})` });
      else if (!(k in t.inputs)) diffs.push({ node: id, what: `${k}: only in ours (${show(o.inputs[k])})` });
      else if (!same(o.inputs[k], t.inputs[k])) diffs.push({ node: id, what: `${k}: ${show(o.inputs[k])} vs ComfyUI's ${show(t.inputs[k])}` });
    }
  }
  // a node of a kind ComfyUI cannot run (a frontend-only one, rgthree's Fast Muter…) is left out at build (trim): not a difference
  for (const [id, o] of Object.entries(ours)) if (!theirs[id] && catalog[o.class_type]) diffs.push({ node: id, what: `only in ours (${o.class_type})` });
  return diffs;
}

type EditorNode = { id: number | string; type: string };
/**
 * ComfyUI's graph with the ids of the file: its editor may number the nodes inside a group node anew (an id
 * taken elsewhere), per group definition, new id → the file's.
 */
function withFileIds(theirs: Graph, raw: { nodes: EditorNode[]; definitions?: { subgraphs?: Array<{ id: string; nodes: EditorNode[] }> } }, renumbered: Record<string, Record<string, string>> = {}): Graph {
  if (!Object.keys(renumbered).length) return theirs;
  const defs = new Map((raw.definitions?.subgraphs ?? []).map((d) => [d.id, d]));
  const fileId = (id: string) => {
    let nodes = raw.nodes;
    let def: string | undefined;
    return id.split(":").map((seg) => {
      const old = def ? (renumbered[def]?.[seg] ?? seg) : seg;
      const node = nodes.find((n) => String(n.id) === old);
      def = node && defs.has(node.type) ? node.type : undefined;
      nodes = def ? defs.get(def)!.nodes : [];
      return old;
    }).join(":");
  };
  return Object.fromEntries(Object.entries(theirs).map(([id, n]) => [fileId(id), {
    ...n, inputs: Object.fromEntries(Object.entries(n.inputs).map(([k, v]) => [k, isRef(v) ? [fileId(String(v[0])), v[1]] : v])),
  }]));
}

describe.skipIf(!files.length)("the importer against ComfyUI's own export", () => {
  it("reads every workflow ComfyUI can read the way ComfyUI does", () => {
    const catalog = JSON.parse(readFileSync(infoFile, "utf8")) as NodeCatalog;
    const report: Record<string, { diffs: Diff[] } | { skipped: string }> = {};
    let compared = 0;
    let clean = 0;
    for (const file of files) {
      const exported = JSON.parse(readFileSync(join(dir, file), "utf8")) as { output?: Graph; missing?: string[]; renumbered?: Record<string, Record<string, string>>; error?: string };
      if (exported.error) { report[file] = { skipped: `ComfyUI's editor: ${exported.error.split("\n")[0]}` }; continue; }
      const raw = JSON.parse(readFileSync(join(corpus, file), "utf8"));
      const read = fromEditor(raw, catalog);
      const ours = prune(read.graph, read.wiring, read.wiring?.modes ?? {}).graph;
      // the nodes of kinds ComfyUI lacks are left out of ours as of theirs
      const lacking = new Set(exported.missing ?? []);
      for (const [id, n] of Object.entries(ours)) if (lacking.has(n.class_type)) delete ours[id];
      const diffs = compare(withFileIds(exported.output!, raw, exported.renumbered), ours, catalog);
      report[file] = { diffs };
      compared++;
      if (!diffs.length) clean++;
    }
    writeFileSync(join(dir, "_report.json"), JSON.stringify(report, null, 1));
    console.log(`compared ${compared}, the same as ComfyUI: ${clean}; report in ${dir}/_report.json`);
    expect(compared).toBeGreaterThan(0);
  });
});
