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
  if (type === "*" || type === "") return ins.length > output ? output : 0;
  const outType = slots.out[output] ?? "*";
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
