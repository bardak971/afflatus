import { isRef, type Graph, type Ref } from "@afflatus/core";
import type { Mode, Toggle, Wiring } from "./types";

/**
 * Turning a workflow with switched-off nodes into the graph ComfyUI runs. This follows what ComfyUI's
 * own front end does when it exports (graphToPrompt and ExecutableNodeDTO, front end 1.53): a muted
 * node gives nothing, a bypassed node hands on the input whose type matches the output asked for, and
 * neither is sent.
 */

/** LiteGraph's rule for whether two socket types connect: equal, a wildcard, or sharing one of several types. */
function connects(a: string, b: string): boolean {
  if (!a || a === "*" || !b || b === "*" || a === b) return true;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (!x.includes(",") && !y.includes(",")) return x === y;
  return x.split(",").some((p) => y.split(",").some((q) => connects(p, q)));
}

/** Which input of a bypassed node stands in for one of its outputs, for a reader that wants `type`. */
function bypassIndex(slots: Wiring["slots"][string], output: number, type: string): number {
  const ins = slots.in;
  const outType = slots.out[output] ?? "*";
  // a reader that takes anything (a switch, a reroute) is handed what the output carries: that type decides
  if (type === "*" || type === "") type = outType;
  if (type === "*" || type === "") return ins.length > output ? output : 0;
  const opposite = ins[output];
  if (opposite && connects(opposite[1], outType) && connects(opposite[1], type)) return output;
  const exact = ins.findIndex(([, t]) => t === type);
  return exact !== -1 ? exact : ins.findIndex(([, t]) => connects(t, outType) && connects(t, type));
}

/** The on/off state of every node, given how the switches are set. */
/** The parts switched off as a whole ("skip"), each its nodes: a reader of one takes the part's one incoming link of its type. */
export function skipsFor(toggles: Toggle[], values: Record<string, unknown>): string[][] {
  const sets: string[][] = [];
  for (const t of toggles) {
    const on = typeof values[t.id] === "boolean" ? (values[t.id] as boolean) : t.default;
    for (const e of t.effects) if (e.mode === "skip" && on !== e.activeWhen) sets.push(e.nodes);
  }
  return sets;
}

export function modesFor(wiring: Wiring | undefined, toggles: Toggle[], values: Record<string, unknown>): Record<string, Mode> {
  const modes: Record<string, Mode> = { ...wiring?.modes };
  for (const t of toggles) {
    const on = typeof values[t.id] === "boolean" ? (values[t.id] as boolean) : t.default;
    for (const e of t.effects) {
      for (const node of e.nodes) {
        if (on === e.activeWhen) delete modes[node];
        else modes[node] = e.mode;
      }
    }
  }
  return modes;
}

/** A graph being made ready to run, with the nodes that lost an input they had on the way. */
export interface Pruned {
  graph: Graph;
  broken: Set<string>;
}

/**
 * A copy of the graph with the switched-off nodes taken out and every link led to where it really
 * comes from. A link that leads nowhere falls back to the value typed into that input, or is dropped
 * (the node is then listed as broken). Without wiring (an exported workflow) it is a plain copy.
 */
export function prune(graph: Graph, wiring: Wiring | undefined, modes: Record<string, Mode>, skips: string[][] = []): Pruned {
  const typeOf = (node: string, input: string) => wiring?.slots[node]?.in.find(([n]) => n === input)?.[1] ?? "*";
  /** The links into a skipped part from outside it that carry `type`, each once. */
  const entries = (set: string[], type: string): Ref[] => {
    const inside = new Set(set);
    const seen = new Set<string>();
    const out: Ref[] = [];
    for (const id of set) {
      for (const [name, value] of Object.entries(graph[id]?.inputs ?? {})) {
        if (!isRef(value) || inside.has(value[0]) || !connects(typeOf(id, name), type)) continue;
        const key = `${value[0]}:${value[1]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(value);
      }
    }
    return out;
  };

  const source = (ref: Ref, type: string, seen: Set<string>): Ref | undefined => {
    const [id, slot] = ref;
    const key = `${id}:${slot}`;
    if (!graph[id] || seen.has(key)) return undefined;
    seen.add(key);
    if (modes[id] === "mute") return undefined;
    if (modes[id] !== "bypass" && modes[id] !== "skip") return ref;
    const slots = wiring?.slots[id];
    const through = slots?.in[bypassIndex(slots, slot, type)];
    const value = through && graph[id]!.inputs[through[0]];
    // from here on the type asked for is that input's own
    if (through && isRef(value)) return source(value, through[1], seen);
    if (modes[id] === "skip") {
      // the node alone cannot hand the type on: the part it is in may, by its one incoming link of that type
      const set = skips.find((s) => s.includes(id));
      const from = set ? entries(set, type) : [];
      if (from.length === 1) return source(from[0]!, type, seen);
    }
    return undefined;
  };

  const out: Graph = {};
  const broken = new Set<string>();
  for (const [id, node] of Object.entries(graph)) {
    if (modes[id]) continue;
    const inputs: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(node.inputs)) {
      if (!isRef(value)) {
        inputs[name] = value;
        continue;
      }
      const from = source(value, typeOf(id, name), new Set());
      const typed = wiring?.fallback[id];
      if (from) inputs[name] = from;
      else if (typed && name in typed) inputs[name] = typed[name];
      // an optional input whose link leads nowhere is simply not given (rgthree's Any Switch then takes its other input)
      else if (wiring?.optional?.[id]?.includes(name)) continue;
      else broken.add(id);
    }
    out[id] = { ...node, inputs };
  }
  return { graph: out, broken };
}

/** Nodes that pass on one of two inputs depending on a yes/no value. */
const CHOOSERS: Record<string, { by: string; yes: string; no: string }> = {
  ComfySwitchNode: { by: "switch", yes: "on_true", no: "on_false" },
};

/** A yes/no value that is known before anything runs: typed in, or read from a node that only holds one. */
function booleanAt(graph: Graph, value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (!isRef(value)) return null;
  const held = Object.values(graph[value[0]]?.inputs ?? {});
  return held.length === 1 && typeof held[0] === "boolean" ? held[0] : null;
}

/**
 * Where a node chooses between two inputs by a yes/no value that is already known, connect its readers
 * straight to the chosen one and take the node out. ComfyUI would only run the chosen side anyway, but
 * it checks both before starting: the side that is not used would still need its picture and its files.
 */
export function settle({ graph, broken }: Pruned): void {
  for (const [id, node] of Object.entries(graph)) {
    const chooser = CHOOSERS[node.class_type];
    const by = chooser ? booleanAt(graph, node.inputs[chooser.by]) : null;
    if (!chooser || by === null) continue;
    const chosen = node.inputs[by ? chooser.yes : chooser.no];
    for (const [reader, other] of Object.entries(graph)) {
      for (const [name, value] of Object.entries(other.inputs)) {
        if (!isRef(value) || value[0] !== id) continue;
        if (chosen === undefined) {
          delete other.inputs[name];
          broken.add(reader);
        } else other.inputs[name] = chosen;
      }
    }
    delete graph[id];
  }
}

/** Every node that `id` needs, itself included. */
export function ancestors(graph: Graph, id: string): Set<string> {
  const needed = new Set<string>();
  const visit = (node: string) => {
    if (needed.has(node) || !graph[node]) return;
    needed.add(node);
    for (const v of Object.values(graph[node]!.inputs)) if (isRef(v)) visit(v[0]);
  };
  visit(id);
  return needed;
}

/** Take a node out with every link that read it; the readers are then broken. */
export function remove({ graph, broken }: Pruned, id: string): void {
  delete graph[id];
  for (const [reader, node] of Object.entries(graph)) {
    for (const [name, v] of Object.entries(node.inputs)) {
      if (!isRef(v) || v[0] !== id) continue;
      delete node.inputs[name];
      broken.add(reader);
    }
  }
}

/**
 * Take out the broken nodes that the result does not depend on (a second save node fed by a part that
 * is off), and what only they fed. ComfyUI itself skips an output it cannot validate; leaving them in
 * would only make the check before a render fail. A broken node the result does depend on stays: the
 * check then says what is missing.
 */
/**
 * Output nodes whose file name is built by a chain of nodes (a date, the seed, the size, joined into a
 * string): the name becomes `name` (Afflatus names what it keeps anyway), and the nodes that served
 * only that chain go, so that their packs are not asked for. What also feeds something else stays.
 * Gives the ids taken out.
 */
export function cutFileNameChains(graph: Graph, name: string): string[] {
  const wired = Object.keys(graph).filter((id) => isRef(graph[id]!.inputs.filename_prefix));
  if (!wired.length) return [];
  // the nodes nothing reads (the outputs, the chains' own ends aside): what they need, once the names are plain, is what stays
  const read = new Set<string>();
  for (const node of Object.values(graph)) for (const v of Object.values(node.inputs)) if (isRef(v)) read.add(v[0]);
  const sinks = Object.keys(graph).filter((id) => !read.has(id));
  for (const id of wired) graph[id]!.inputs.filename_prefix = name;
  const kept = new Set<string>(sinks);
  for (const id of sinks) for (const a of ancestors(graph, id)) kept.add(a);
  const gone = Object.keys(graph).filter((id) => !kept.has(id));
  for (const id of gone) delete graph[id];
  return gone;
}

/**
 * Save nodes of a kind this ComfyUI lacks (a pack's "Image Saver" that writes metadata, mostly): Afflatus saves and
 * names what it keeps itself, so ComfyUI's own saver stands in, fed the same picture or video. The extra inputs such
 * a node took (the steps, the model's name, for its metadata) are dropped. Gives what was replaced. `slots` (an
 * editor file's socket types) says which input carries the picture; without it, the input's name does.
 */
export function standInSavers(graph: Graph, has: (classType: string) => boolean, slots?: Wiring["slots"]): Array<{ node: string; from: string; to: string }> {
  const read = new Set<string>();
  for (const node of Object.values(graph)) for (const v of Object.values(node.inputs)) if (isRef(v)) read.add(v[0]);
  const out: Array<{ node: string; from: string; to: string }> = [];
  for (const [id, n] of Object.entries(graph)) {
    if (has(n.class_type) || read.has(id) || !/save|saver|output|export|writer/i.test(n.class_type)) continue;
    const types = new Map((slots?.[id]?.in ?? []).map(([name, type]) => [name, type] as const));
    const linked = Object.entries(n.inputs).filter((e): e is [string, Ref] => isRef(e[1]));
    const carrying = (type: RegExp, names: RegExp) => linked.find(([k]) => (types.has(k) ? type.test(types.get(k)!) : names.test(k)));
    const video = carrying(/^VIDEO$/, /^video$/);
    const image = carrying(/^IMAGE$/, /^images?$/);
    if (video && has("SaveVideo")) {
      graph[id] = { class_type: "SaveVideo", inputs: { video: video[1], filename_prefix: "afflatus", format: "auto", codec: "auto" } };
      out.push({ node: id, from: n.class_type, to: "SaveVideo" });
    } else if (image && !/video|combine|animat/i.test(n.class_type) && has("SaveImage")) {
      graph[id] = { class_type: "SaveImage", inputs: { images: image[1], filename_prefix: "afflatus" } };
      out.push({ node: id, from: n.class_type, to: "SaveImage" });
    }
  }
  return out;
}

/**
 * Value nodes of a pack this ComfyUI lacks (a slider, an integer, a text box from a small utility pack): one
 * typed-in value, nothing wired in, one output. ComfyUI's own primitive of that kind stands in, with the value,
 * so the pack is not asked for. Gives what was replaced.
 */
export function standInPrimitives(graph: Graph, has: (classType: string) => boolean, slots?: Wiring["slots"], isChoice: (classType: string, input: string) => boolean = () => false): Array<{ node: string; from: string; to: string }> {
  const out: Array<{ node: string; from: string; to: string }> = [];
  for (const [id, n] of Object.entries(graph)) {
    if (has(n.class_type)) continue;
    // a value that says its own type (rgthree's Power Primitive: type "INT", value 81) is one value of that type
    const typed = Object.keys(n.inputs).sort().join() === "type,value" && typeof n.inputs.type === "string" ? (n.inputs.type as string).replace(/\s*\(.*\)$/, "").toUpperCase() : null;
    const entries = typed ? [["value", n.inputs.value] as [string, unknown]] : Object.entries(n.inputs);
    if (entries.length !== 1 || isRef(entries[0]![1])) continue;
    const outs = typed ? [typed === "NUMBER" ? "FLOAT" : typed] : slots?.[id]?.out;
    // a selector with a second output (its name as text) still holds one value
    if (outs && outs.length !== 1 && !(outs[0] === "COMBO" && outs.length === 2)) continue;
    // a value for a list of choices (a sampler's name): a primitive's link would not be taken there, so the value itself goes in
    const readers = Object.entries(graph).flatMap(([rid, r]) => Object.entries(r.inputs).filter(([, v]) => isRef(v) && v[0] === id).map(([input]) => ({ node: rid, input })));
    if (readers.length && (outs?.[0] === "COMBO" || readers.some((r) => isChoice(graph[r.node]!.class_type, r.input)))) {
      for (const r of readers) graph[r.node]!.inputs[r.input] = entries[0]![1];
      delete graph[id];
      out.push({ node: id, from: n.class_type, to: "its value" });
      continue;
    }
    const numeric = outs && /^(INT|FLOAT)$/.test(outs[0] ?? "") && typeof entries[0]![1] === "string" && /^-?\d+(\.\d+)?$/.test(entries[0]![1] as string);
    const value = numeric ? Number(entries[0]![1]) : entries[0]![1];
    const to = typeof value === "boolean" ? "PrimitiveBoolean"
      : typeof value === "number" ? (Number.isInteger(value) && !/float/i.test(n.class_type + (outs?.[0] ?? "")) ? "PrimitiveInt" : "PrimitiveFloat")
        : typeof value === "string" ? (value.includes("\n") || value.length > 60 ? "PrimitiveStringMultiline" : "PrimitiveString") : null;
    if (!to || !has(to)) continue;
    graph[id] = { class_type: to, inputs: { value }, ...((n as { _meta?: unknown })._meta ? { _meta: (n as { _meta?: unknown })._meta } : {}) } as Graph[string];
    out.push({ node: id, from: n.class_type, to });
  }
  return out;
}

/** rgthree's contexts: what each output hands on, by the input of the same name (output 0 is the context itself). */
const SMALL_CONTEXT = ["base_ctx", "model", "clip", "vae", "positive", "negative", "latent", "images", "seed"];
const CONTEXTS: Record<string, string[]> = {
  "Context (rgthree)": SMALL_CONTEXT,
  "Context Big (rgthree)": [...SMALL_CONTEXT, "steps", "step_refiner", "cfg", "ckpt_name", "sampler", "scheduler", "clip_width", "clip_height", "text_pos_g", "text_pos_l", "text_neg_g", "text_neg_l", "mask", "control_net"],
};

/**
 * A link that takes one value out of an rgthree context (a bundle of model, size, prompts… handed from part to
 * part) is led to where that value was put in: the context's own input of that name, or else the same value of
 * the context it was built on. What runs is the same; what the workflow is made of can then be read through
 * the bundles (the size, the prompt, the picture). Contexts that are off, and switches and merges of contexts
 * (which one they hand on is decided while running), are not looked through. Gives how many links were led.
 */
export function unbundleContexts(graph: Graph, modes: Record<string, Mode> = {}): number {
  const fieldOf = (ref: Ref, seen = new Set<string>()): Ref | undefined => {
    const [id, slot] = ref;
    const node = graph[id];
    const fields = node && !modes[id] ? CONTEXTS[node.class_type] : undefined;
    if (!fields || slot === 0 || slot >= fields.length || seen.has(id)) return undefined;
    seen.add(id);
    const own = node!.inputs[fields[slot]!];
    if (isRef(own)) return fieldOf(own, seen) ?? own;
    const base = node!.inputs.base_ctx;
    return isRef(base) && base[1] === 0 ? fieldOf([base[0], slot], seen) : undefined;
  };
  let led = 0;
  for (const node of Object.values(graph)) {
    for (const [name, value] of Object.entries(node.inputs)) {
      if (!isRef(value)) continue;
      const from = fieldOf(value);
      if (from) {
        node.inputs[name] = from;
        led++;
      }
    }
  }
  return led;
}

/**
 * Model loaders of a kind this ComfyUI lacks that only add to ComfyUI's own (a checkpoint loader that also gives
 * its file's name, for metadata): ComfyUI's own loader stands in, with the file. Readers of the extra outputs lose
 * their link (what they fed was metadata). Gives what was replaced.
 */
export function standInLoaders(graph: Graph, has: (classType: string) => boolean, slots?: Wiring["slots"]): Array<{ node: string; from: string; to: string }> {
  const out: Array<{ node: string; from: string; to: string }> = [];
  const FILE = /\.(safetensors|sft|gguf|ckpt|pt|pth|bin)$/i;
  for (const [id, n] of Object.entries(graph)) {
    if (has(n.class_type)) continue;
    const outs = slots?.[id]?.out ?? [];
    const starts = (types: string[]) => types.every((t, i) => outs[i] === t);
    const file = (input: string) => (typeof n.inputs[input] === "string" && FILE.test(n.inputs[input] as string) ? (n.inputs[input] as string) : null);
    if (starts(["MODEL", "CLIP", "VAE"]) && file("ckpt_name") && has("CheckpointLoaderSimple")) {
      graph[id] = { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: file("ckpt_name") } };
      out.push({ node: id, from: n.class_type, to: "CheckpointLoaderSimple" });
    } else if (outs.length === 1 && outs[0] === "MODEL" && file("unet_name") && has("UNETLoader")) {
      graph[id] = { class_type: "UNETLoader", inputs: { unet_name: file("unet_name"), weight_dtype: "default" } };
      out.push({ node: id, from: n.class_type, to: "UNETLoader" });
    }
  }
  return out;
}

export function trim({ graph, broken }: Pruned, keep: string, has: (classType: string) => boolean = () => true): void {
  const needed = ancestors(graph, keep);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [id, node] of Object.entries(graph)) {
      if (needed.has(id)) continue;
      // a kind of node this ComfyUI does not have would make it refuse everything, the result included
      if (broken.has(id) || !has(node.class_type) || Object.values(node.inputs).some((v) => isRef(v) && !graph[v[0]])) {
        delete graph[id];
        changed = true;
      }
    }
  }
}
