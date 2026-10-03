import { isRef, type Graph, type NodeCatalog, type NodeInfo, type Ref } from "@afflatus/core";

/**
 * A graph as ComfyUI's editor saves it, made from the graph Afflatus runs (the "API" form), so that the
 * editor can open it: its Workflows sidebar only takes the editor's own files. The editor's file names
 * widgets by position, so the order comes from ComfyUI's node list, with the rules its front end
 * applies: a seed gets a "control after generate" value after it; an image or video to upload gets
 * the upload button after it; VHS nodes keep their values by name. Nodes are laid out in columns by
 * how far they are from the inputs, which is roughly what the editor's own "Arrange" does.
 */

export interface EditorNode {
  id: number;
  type: string;
  pos: [number, number];
  size: [number, number];
  flags: Record<string, never>;
  order: number;
  mode: number;
  inputs: Array<{ name: string; type: string; link: number | null; widget?: { name: string } }>;
  outputs: Array<{ name: string; type: string; links: number[]; slot_index: number }>;
  title?: string;
  properties: { "Node name for S&R": string };
  widgets_values?: unknown[] | Record<string, unknown>;
}

export interface EditorFile {
  id?: string;
  last_node_id: number;
  last_link_id: number;
  nodes: EditorNode[];
  /** [id, from node, from slot, to node, to slot, type] */
  links: Array<[number, number, number, number, number, string]>;
  groups: never[];
  config: Record<string, never>;
  extra: Record<string, unknown>;
  version: 0.4;
}

type Spec = [unknown, Record<string, unknown>?];

/** The inputs of a node type in the order the editor shows them: required first, then optional; hidden ones never. */
function specsOf(info: NodeInfo | undefined): Array<[string, Spec]> {
  const out: Array<[string, Spec]> = [];
  for (const group of [info?.input.required, info?.input.optional]) {
    for (const [name, raw] of Object.entries(group ?? {})) out.push([name, (Array.isArray(raw) ? raw : [raw]) as Spec]);
  }
  return out;
}

const WIDGET_TYPES = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"]);
/** The input is typed in on the node (a widget), not fed by a link. */
function isWidget([type, opts]: Spec): boolean {
  if (opts?.forceInput === true) return false;
  return Array.isArray(type) || (typeof type === "string" && WIDGET_TYPES.has(type));
}
/** The type of an input, as the editor writes it on a slot. */
const slotType = ([type]: Spec): string => (Array.isArray(type) ? "COMBO" : typeof type === "string" ? type : "*");
/** What a widget starts on when the graph does not say. */
function defaultOf([type, opts]: Spec): unknown {
  if (opts && "default" in opts) return opts.default;
  if (Array.isArray(type)) return type[0] ?? "";
  if (type === "COMBO") return (opts?.options as unknown[] | undefined)?.[0] ?? "";
  if (type === "INT" || type === "FLOAT") return 0;
  if (type === "BOOLEAN") return false;
  return "";
}
/** A seed, as the front end sees one: flagged, or named so. */
const hasControl = (name: string, [type, opts]: Spec): boolean => (type === "INT" || type === "COMBO" || Array.isArray(type)) && Boolean(opts?.control_after_generate ?? (type === "INT" && (name === "seed" || name === "noise_seed")));
/** A file to upload: the front end adds an upload button after the widget, serialised as its kind. */
function uploadAfter([, opts]: Spec): string | null {
  if (!opts) return null;
  if (opts.image_upload === true || opts.animated_image_upload === true) return "image";
  if (opts.video_upload === true) return "video";
  return null;
}

const TEXT_WIDTH = 400;
const NODE_WIDTH = 315;
const ROW = 24;

/**
 * The editor's file for `graph`. `titles` names nodes the way the user saw them (an imported workflow's
 * own titles), by node id.
 */
export function toEditor(graph: Graph, catalog: NodeCatalog, opts: { titles?: Record<string, string>; id?: string } = {}): EditorFile {
  const ids = Object.keys(graph);
  // the editor numbers nodes: Afflatus's ids are kept when they are numbers, else given in order
  const numbered = new Map<string, number>();
  let next = 1;
  for (const id of ids) if (/^\d+$/.test(id)) numbered.set(id, Number(id));
  for (const id of ids) {
    if (numbered.has(id)) continue;
    while ([...numbered.values()].includes(next)) next++;
    numbered.set(id, next++);
  }
  const links: EditorFile["links"] = [];
  const nodes = new Map<string, EditorNode>();
  let linkId = 1;

  for (const id of ids) {
    const node = graph[id]!;
    const info = catalog[node.class_type];
    const specs = specsOf(info);
    const known = new Set(specs.map(([n]) => n));
    const inputs: EditorNode["inputs"] = [];
    const values: unknown[] = [];
    const byName: Record<string, unknown> = {};
    let height = 36;
    let wide = false;
    for (const [name, spec] of specs) {
      const given = node.inputs[name];
      const widget = isWidget(spec);
      if (isRef(given)) {
        // fed by a link: a slot; a widget fed by a link keeps its place among the widgets with its default
        inputs.push({ name, type: slotType(spec), link: null, ...(widget ? { widget: { name } } : {}) });
        if (widget) {
          values.push(defaultOf(spec));
          byName[name] = defaultOf(spec);
        }
      } else if (widget) {
        const v = given === undefined ? defaultOf(spec) : given;
        values.push(v);
        byName[name] = v;
        if (typeof v === "string" && (spec[1]?.multiline === true || v.length > 60)) wide = true;
      } else {
        inputs.push({ name, type: slotType(spec), link: null });
      }
      if (widget) {
        if (hasControl(name, spec)) {
          values.push("fixed");
          byName[`control_after_generate`] = "fixed";
        }
        const up = uploadAfter(spec);
        if (up) {
          values.push(up);
          byName.upload = up;
        }
      }
      height += ROW;
    }
    // inputs the node list does not know (a removed option, a custom field): linked ones still need a slot
    for (const [name, given] of Object.entries(node.inputs)) {
      if (!known.has(name) && isRef(given)) {
        inputs.push({ name, type: "*", link: null });
        height += ROW;
      }
    }
    // an output typed as a list of choices (rgthree's sampler names) is a COMBO: the editor wants a string there
    const outs = (info?.output ?? []).map((raw, i) => {
      const type = typeof raw === "string" ? raw : "COMBO";
      return { name: info?.output_name?.[i] ?? type, type, links: [] as number[], slot_index: i };
    });
    height = Math.max(height, 36 + outs.length * ROW);
    // rgthree's Power Lora Loader keeps its LoRA rows as inputs ComfyUI's node list does not describe
    // ("lora_1": {on, lora, strength}); it reads back any value that has a "lora" in it
    const loraRows = Object.values(node.inputs).filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v) && typeof (v as { lora?: unknown }).lora === "string");
    const widgetValues = node.class_type.startsWith("VHS_") ? byName : loraRows.length ? loraRows.map((r) => ({ ...r })) : values;
    nodes.set(id, {
      id: numbered.get(id)!,
      type: node.class_type,
      pos: [0, 0],
      size: [wide ? TEXT_WIDTH : NODE_WIDTH, height],
      flags: {},
      order: 0,
      mode: 0,
      inputs,
      outputs: outs,
      ...(opts.titles?.[id] ? { title: opts.titles[id] } : {}),
      properties: { "Node name for S&R": node.class_type },
      // VHS nodes read their values by name (their own serialisation); the editor reads the others by position
      ...(Array.isArray(widgetValues) && !widgetValues.length ? {} : { widgets_values: widgetValues }),
    });
  }

  // the links: each ref input, from the source's output slot to the target's slot
  for (const id of ids) {
    const target = nodes.get(id)!;
    for (const [name, given] of Object.entries(graph[id]!.inputs)) {
      if (!isRef(given)) continue;
      const [fromId, slot] = given as Ref;
      const source = nodes.get(String(fromId));
      const to = target.inputs.findIndex((i) => i.name === name);
      if (!source || to < 0) continue;
      const out = source.outputs[slot];
      const type = out?.type ?? target.inputs[to]!.type;
      const link = linkId++;
      links.push([link, source.id, slot, target.id, to, type]);
      target.inputs[to]!.link = link;
      if (out) out.links.push(link);
      else source.outputs[slot] = { name: type, type, links: [link], slot_index: slot };
    }
  }

  // columns by depth: a node sits one column right of the furthest node that feeds it
  const depth = new Map<string, number>();
  const depthOf = (id: string, seen: Set<string>): number => {
    const d = depth.get(id);
    if (d !== undefined) return d;
    if (seen.has(id)) return 0;
    seen.add(id);
    let best = 0;
    for (const given of Object.values(graph[id]!.inputs)) {
      if (!isRef(given) || !graph[String((given as Ref)[0])]) continue;
      best = Math.max(best, depthOf(String((given as Ref)[0]), seen) + 1);
    }
    depth.set(id, best);
    return best;
  };
  for (const id of ids) depthOf(id, new Set());
  const columns = new Map<number, string[]>();
  for (const id of ids) columns.set(depth.get(id)!, [...(columns.get(depth.get(id)!) ?? []), id]);
  let x = 0;
  let order = 0;
  for (const col of [...columns.keys()].sort((a, b) => a - b)) {
    let y = 0;
    let widest = NODE_WIDTH;
    for (const id of columns.get(col)!) {
      const n = nodes.get(id)!;
      n.pos = [x, y];
      n.order = order++;
      y += n.size[1] + 60;
      widest = Math.max(widest, n.size[0]);
    }
    x += widest + 80;
  }

  const list = [...nodes.values()];
  return {
    ...(opts.id ? { id: opts.id } : {}),
    last_node_id: Math.max(0, ...list.map((n) => n.id)),
    last_link_id: linkId - 1,
    nodes: list,
    links,
    groups: [],
    config: {},
    extra: {},
    version: 0.4,
  };
}
