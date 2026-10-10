import type { Graph, NodeCatalog } from "@afflatus/core";
import { pickedBy, selectorOf, valueAt } from "../src";

/** Comparing a graph of Afflatus's with ComfyUI's own "Export (API)" of the same workflow (comfyExport.mjs). */

export type Diff = { node: string; what: string };
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
  for (const [id, t0] of Object.entries(theirs)) {
    const o = ours[id];
    if (!catalog[t0.class_type]) continue;
    // an input the editor sends under the old bare name of a member of a group that grows ("a"), ours under the group's ("variables.a")
    const t = { ...t0, inputs: { ...t0.inputs } };
    for (const k of Object.keys(t.inputs)) {
      const grown = Object.keys(o?.inputs ?? {}).find((name) => name.endsWith(`.${k}`) && !(k in o!.inputs));
      if (grown) { t.inputs[grown] = t.inputs[k]; delete t.inputs[k]; }
    }
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
export function withFileIds(theirs: Graph, raw: { nodes: EditorNode[]; definitions?: { subgraphs?: Array<{ id: string; nodes: EditorNode[] }> } }, renumbered: Record<string, Record<string, string>> = {}): Graph {
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

/**
 * ComfyUI's graph with what only passes things on taken out, as a job's build takes them out: an rgthree Context
 * (each output is the input of the same name, or the context it extends) and a selector whose value is saved
 * (wiring.ts's table: a yes/no or a number, typed in or read from a value node). What read them reads their source instead.
 */
export function withoutPassThroughs(theirs: Graph, catalog: NodeCatalog): Graph {
  const g = structuredClone(theirs);
  const through = (ref: [string | number, number], seen = 0): [string | number, number] | null => {
    const n = g[String(ref[0])];
    if (!n || seen > 50) return ref;
    if (/^Context( Big)? \(rgthree\)$/.test(n.class_type)) {
      const name = catalog[n.class_type]?.output_name?.[ref[1]]?.toLowerCase();
      if (!name || ref[1] === 0) return ref;
      const own = n.inputs[name];
      if (isRef(own)) return through(own, seen + 1);
      const base = n.inputs.base_ctx;
      if (!isRef(base)) return null;
      const from = g[String(base[0])];
      const at = catalog[from?.class_type ?? ""]?.output_name?.findIndex((o) => o.toLowerCase() === name) ?? -1;
      return at < 0 ? null : through([base[0], at], seen + 1);
    }
    const sel = selectorOf(n.class_type);
    if (sel && ref[1] === 0) {
      const input = pickedBy(sel, n, valueAt(g, n.inputs[sel.by]));
      if (!input) return ref;
      const picked = n.inputs[input];
      return isRef(picked) ? through(picked, seen + 1) : sel.strict ? null : ref;
    }
    return ref;
  };
  for (const n of Object.values(g)) {
    for (const [k, v] of Object.entries(n.inputs)) {
      if (!isRef(v)) continue;
      const to = through(v);
      if (to === null) delete n.inputs[k];
      else n.inputs[k] = to;
    }
  }
  return g;
}
