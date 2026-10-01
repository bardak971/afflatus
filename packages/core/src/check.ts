import { isRef, type BuiltGraph } from "./graph";

/**
 * ComfyUI's node catalog (GET /object_info). An input is [type, options?]; a list of choices is either
 * an array in the type position (older nodes) or the type "COMBO" with options.options (newer ones).
 */
export type NodeCatalog = Record<string, NodeInfo>;
export interface NodeInfo {
  input: { required?: Record<string, unknown>; optional?: Record<string, unknown> };
  /** The type of each output ("MODEL", "IMAGE", …). */
  output: string[];
  /** The node saves or shows something: a graph is run for its output nodes. */
  output_node?: boolean;
  /** The name ComfyUI shows for it: what a node is titled until someone renames it. */
  display_name?: string;
}

/** The choices a node offers for one input, or null when the input isn't a list of choices. */
export function choicesOf(spec: unknown): string[] | null {
  if (!Array.isArray(spec)) return null;
  if (Array.isArray(spec[0])) return spec[0].map(String);
  const opts = (spec[1] as { options?: unknown } | undefined)?.options;
  return spec[0] === "COMBO" && Array.isArray(opts) ? opts.map(String) : null;
}

/**
 * Choices that are files on someone's disk differ per install: never check a graph against them.
 * An empty list is one of those too: the saved reference catalog has its file lists emptied.
 */
const looksLikeFiles = (choices: string[]) =>
  !choices.length || choices.some((c) => /\.(safetensors|ckpt|pt|pth|bin|gguf|sft|onnx|png|jpe?g|webp|mp4|wav|mp3)$/i.test(c));

/**
 * Nodes that take inputs their catalog entry does not list: VideoHelperSuite's per-format settings,
 * rgthree's nodes with as many inputs as are plugged in (one per LoRA, one per thing to switch between).
 */
export const takesAnyInput = (classType: string) => /^VHS_/.test(classType) || /\(rgthree\)$/.test(classType);

/**
 * Structural check of a built graph against a node catalog: every node exists, has its required
 * inputs, takes no unknown ones, links point at real outputs, and fixed choices are valid.
 * Catches renamed nodes and inputs after a ComfyUI update without spending GPU time.
 */
export function checkGraph(built: BuiltGraph, catalog: NodeCatalog, opts: { files?: boolean; uploaded?: string[] } = {}): string[] {
  const problems: string[] = [];
  // what the outputs are made from. A graph can hold more (an imported workflow with a second way of
  // saving, or a side branch): ComfyUI skips an output it cannot validate and runs the rest, so a
  // problem there does not stop the result.
  const needed = new Set<string>();
  const need = (id: string) => {
    if (needed.has(id) || !built.graph[id]) return;
    needed.add(id);
    for (const v of Object.values(built.graph[id]!.inputs)) if (isRef(v)) need(v[0]);
  };
  for (const out of built.outputs) need(out.node);
  for (const [id, node] of Object.entries(built.graph)) {
    const def = catalog[node.class_type];
    // a node ComfyUI does not have stops the whole graph, wherever it is
    if (!def) {
      problems.push(`${id} ${node.class_type}: unknown node`);
      continue;
    }
    if (built.outputs.length && !needed.has(id)) continue;
    const required = def.input.required ?? {};
    const all: Record<string, unknown> = { ...required, ...(def.input.optional ?? {}) };
    const kindOf = (name: string) => (all[name] as [unknown] | undefined)?.[0];
    for (const name of Object.keys(required)) {
      if (name in node.inputs) continue;
      // a group that grows is never sent under its own name, only as "<group>.<member>"
      if (kindOf(name) === "COMFY_AUTOGROW_V3" && Object.keys(node.inputs).some((k) => k.startsWith(`${name}.`))) continue;
      problems.push(`${id} ${node.class_type}: missing required "${name}"`);
    }
    // Inputs that belong to a group are sent as "<group>.<member>"
    const grows = (key: string) => {
      const dot = key.indexOf(".");
      if (dot < 0) return false;
      const [group, name] = [key.slice(0, dot), key.slice(dot + 1)];
      const spec = all[group] as [string, Record<string, unknown>] | undefined;
      if (spec?.[0] === "COMFY_AUTOGROW_V3") {
        // members are named ("a", "b", …) or numbered after a prefix ("image0", "image1", …)
        const t = spec[1].template as { prefix?: string; max?: number; names?: string[] } | undefined;
        if (t?.names?.includes(name)) return true;
        const n = t?.prefix && name.startsWith(t.prefix) ? Number(name.slice(t.prefix.length)) : NaN;
        return Number.isInteger(n) && n >= 0 && n < (t?.max ?? 0);
      }
      if (spec?.[0] === "COMFY_DYNAMICCOMBO_V3") {
        // a choice that brings its own inputs: the ones of the option that was picked
        type Option = { key: string; inputs?: { required?: object; optional?: object } };
        const picked = (spec[1].options as Option[] | undefined)?.find((o) => o.key === node.inputs[group]);
        return name.split(".")[0]! in { ...picked?.inputs?.required, ...picked?.inputs?.optional };
      }
      return false;
    };
    for (const [name, value] of Object.entries(node.inputs)) {
      if (!(name in all) && !grows(name) && !takesAnyInput(node.class_type)) {
        problems.push(`${id} ${node.class_type}: unknown input "${name}"`);
      }
      if (isRef(value)) {
        const src = built.graph[value[0]];
        if (!src) problems.push(`${id}.${name}: links to missing node ${value[0]}`);
        else if (value[1] >= (catalog[src.class_type]?.output.length ?? 0)) {
          problems.push(`${id}.${name}: ${src.class_type} has no output ${value[1]}`);
        }
      } else if (typeof value === "string") {
        const choices = choicesOf(all[name]);
        if (!choices || choices.includes(value)) continue;
        if (!looksLikeFiles(choices)) problems.push(`${id} ${node.class_type}: "${value}" is not a choice of "${name}"`);
        // against the live catalog of the ComfyUI about to run it, a file that isn't there is a problem too
        // a file that was just uploaded for this graph is there, though the list was read before it arrived
        else if (opts.files && choices.length && !opts.uploaded?.includes(value)) problems.push(`${id} ${node.class_type}: ComfyUI has no file "${value}" for "${name}"`);
      }
    }
  }
  for (const out of built.outputs) {
    if (!built.graph[out.node]) problems.push(`output ${out.role}: node ${out.node} is not in the graph`);
  }
  return problems;
}
