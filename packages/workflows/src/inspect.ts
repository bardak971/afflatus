import { choicesOf, isRef, sameFile, type Graph, type NodeCatalog, type Ref } from "@afflatus/core";
import { optsOf, specOf, typeOf } from "./catalog";
import { scaleAfterModel } from "./recipe";
import { splitCaptions, type Bindings, type Control, type ImageBinding, type Target, type Toggle, type Wiring } from "./types";
import { ancestors, prune, settle } from "./wiring";

/**
 * Reads a ComfyUI workflow and works out what its parts are: where the prompt goes, the seed, the
 * size, the pictures it loads, what it saves, and which of its settings could be shown as controls.
 * Everything here is a suggestion: the import screen shows it and the user corrects what is wrong. It
 * needs the node catalog of the ComfyUI the workflow will run on (types, ranges and choices come from
 * there) and reads nothing else.
 *
 * Three kinds of evidence are used. The wiring: a text that ends up in a sampler's "positive" is the
 * prompt. The names people give their nodes: large workflows keep their controls in renamed primitive
 * nodes ("Seed", "Seconds", "First-Frame-Image"), and those names say what they are. And, when the
 * workflow came from the editor's own file, what only that file has: the author's control panel, the
 * names given to single settings, and the switches that turn parts on and off.
 */

export interface Inspection {
  nodeCount: number;
  /** Node types the workflow uses that this ComfyUI does not have. */
  missingNodes: string[];
  /** Node types this ComfyUI does not have, used only by parts that are switched off. */
  missingWhenOn: string[];
  /** Files the workflow names that this ComfyUI does not list, with the files it does have for that input, and where to download it when the workflow says. */
  missingFiles: Array<Target & { classType: string; file: string; label: string; options: string[]; url?: string }>;
  /**
   * Choices the workflow makes that this ComfyUI does not offer: a sampler or a scheduler that a node
   * pack adds on its author's machine. With the choices there are, and the one whose name is closest.
   */
  missingChoices: Array<Target & { classType: string; title: string; value: string; options: string[]; nearest?: string }>;
  /** Files the workflow names that this ComfyUI keeps in another sub-folder: they are used from there. */
  relocated: Array<Target & { file: string; found: string }>;
  /** For the kinds of node that are missing: the pack each comes from, when the workflow says. */
  packs: Record<string, string>;
  /** The links the workflow's author wrote in its notes (where to get models, mostly). */
  links: Array<{ label: string; url: string }>;
  /** Every node that saves or shows something: one of them is the result. */
  outputs: Array<{ node: string; title: string; kind: "image" | "video" | "audio"; sound: boolean }>;
  /** Every text that is turned into conditioning, with what it seems to be. */
  texts: Array<{ target: Target; title: string; text: string; role: "positive" | "negative" | "unknown" }>;
  /** Every picture the workflow loads, with what it seems to be for and how it would be bound. */
  images: Array<{ node: string; title: string; role: "start" | "end" | "mask" | null; binding: ImageBinding }>;
  /** Places LoRAs can go: after a model loader, or a node that is itself a list of LoRAs. */
  loraPoints: Array<{ node: string; output: number; title: string; label: string; power?: boolean }>;
  /** The on/off switches of the workflow (only an editor file has them). */
  toggles: Toggle[];
  /** The mapping Afflatus would use if the user changed nothing. Null when the workflow has no output node. */
  suggested: Bindings | null;
  /** Every other setting that could be a control; `suggested` ones are ticked to begin with. `off`: its node is switched off as saved. */
  candidates: Array<Control & { classType: string; title: string; suggested: boolean; off?: boolean; /** What ComfyUI offers for a choice, for showing it before it is saved. */ offers?: string[] }>;
  /** The places the workflow can stop at, when it shows its picture at several points on the way (see Bindings.stages). */
  stages: Array<{ node: string; label: string }>;
  /** What could not be read with certainty, for the person importing. */
  notes: string[];
  /** What each kind of node the workflow uses does, in its author's words, for the kinds that have one. */
  about: Record<string, string>;
}

type NodeMeta = { _meta?: { title?: string } };
const FILE = /\.(safetensors|ckpt|pt|pth|bin|gguf|sft|onnx|engine)$/i;
const RESIZERS = /scale|resize|crop|pad|upscale/i;
const POWER_LORAS = "Power Lora Loader (rgthree)";
const stem = (file: string) => (file.split(/[\\/]/).pop() ?? file).replace(FILE, "");

/** Who reads each output: "node:output" → the inputs it is linked to. */
function consumers(graph: Graph): Map<string, Target[]> {
  const map = new Map<string, Target[]>();
  for (const [node, n] of Object.entries(graph)) {
    for (const [input, value] of Object.entries(n.inputs)) {
      if (!isRef(value)) continue;
      const key = `${value[0]}:${value[1]}`;
      map.set(key, [...(map.get(key) ?? []), { node, input }]);
    }
  }
  return map;
}

const VALUE_TYPES = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "*"]);

/** A node that only holds one typed-in value for others to read: one input, typed in, and one plain value out. */
const isPrimitive = (graph: Graph, catalog: NodeCatalog, id: string) => {
  const inputs = Object.values(graph[id]?.inputs ?? {});
  const out = catalog[graph[id]?.class_type ?? ""]?.output;
  return inputs.length === 1 && !isRef(inputs[0]) && (!out || (out.length === 1 && VALUE_TYPES.has(String(out[0]))));
};

/**
 * The place a value is really typed in. A literal input is itself; an input linked to a primitive
 * node (a number or text node people use to share one value) is that node's own value input.
 */
function literal(graph: Graph, catalog: NodeCatalog, node: string, input: string): Target | null {
  const value = graph[node]?.inputs[input];
  if (value === undefined) return null;
  if (!isRef(value)) return { node, input };
  return isPrimitive(graph, catalog, value[0]) ? { node: value[0], input: Object.keys(graph[value[0]]!.inputs)[0]! } : null;
}

/** Follow an output downstream until an input name says what it is used as. */
function usedAs(graph: Graph, uses: Map<string, Target[]>, from: Ref, names: Array<[RegExp, string]>, depth = 6): string | null {
  for (const use of uses.get(`${from[0]}:${from[1]}`) ?? []) {
    for (const [re, role] of names) if (re.test(use.input)) return role;
    if (depth <= 0) continue;
    // not telling: keep following through that node's outputs (few nodes have more than a handful)
    for (let o = 0; o < 6; o++) {
      const role = usedAs(graph, uses, [use.node, o], names, depth - 1);
      if (role) return role;
    }
  }
  return null;
}

/**
 * Ranges a person would actually use, where ComfyUI allows anything up to thousands. What the number
 * is comes from the input's name, or from the name its author gave a number node.
 */
function tame(c: Control, given = ""): Control {
  if (c.kind !== "number") return c;
  const v = Number(c.default);
  const name = given ? given.toLowerCase().trim() : c.target.input;
  if (/^(seconds?|duration|length)$/.test(name)) return { ...c, min: 1, max: Math.max(30, v) };
  if (/^steps(_total)?$/.test(name)) return { ...c, min: 1, max: Math.max(60, v) };
  if (/^(cfg|guidance)$/.test(name)) return { ...c, min: 0, max: Math.max(15, v), step: 0.5 };
  if (/^(denoise|strength.*)$/.test(name)) return { ...c, min: 0, max: Math.max(1, v), step: 0.05 };
  if (/^shift$/.test(name)) return { ...c, min: 0, max: Math.max(15, v), step: 0.5 };
  if (/frame_rate|fps/.test(name)) return { ...c, min: 1, max: Math.max(60, v), step: 1 };
  // anything else: around the value it was exported with
  const max = c.max !== undefined && c.max <= 1000 ? c.max : Math.max(10, v * 4);
  return { ...c, min: c.min !== undefined && c.min >= -1000 ? c.min : 0, max };
}

/**
 * @param source the workflow: as exported, or every node of an editor file (see `fromEditor`)
 * @param editor what only the editor's file knows, when the workflow came from one
 * @param notes what the reader of that file could not read with certainty
 */
export function inspect(source: Graph, catalog: NodeCatalog, editor?: Wiring, notes: string[] = []): Inspection {
  // what runs with the switches as they were saved: the parts are looked for in there
  const pruned = prune(source, editor, editor?.modes ?? {});
  settle(pruned);
  const { graph } = pruned;
  const ids = Object.keys(graph);
  const uses = consumers(graph);
  const missingNodes = [...new Set(ids.filter((id) => !catalog[graph[id]!.class_type]).map((id) => graph[id]!.class_type))];
  const missingWhenOn = [...new Set(Object.keys(source).filter((id) => !graph[id] && !catalog[source[id]!.class_type]).map((id) => source[id]!.class_type))].filter((c) => !missingNodes.includes(c));

  const titleOf = (id: string) => (source[id] as NodeMeta | undefined)?._meta?.title?.trim() || source[id]?.class_type || id;
  /** The name someone gave the node, when it is not just what ComfyUI calls that kind of node. */
  const givenName = (id: string): string | null => {
    const title = (source[id] as NodeMeta | undefined)?._meta?.title?.trim();
    const cls = source[id]!.class_type;
    return title && title !== cls && title !== catalog[cls]?.display_name ? title : null;
  };
  /** The name the author gave one setting (in the editor, the label on its socket). */
  const givenLabel = (node: string, input: string) => editor?.labels[`${node}.${input}`]?.replace(/^[\s↳]+/, "").trim() || null;

  function control(node: string, input: string): Control | null {
    const n = source[node]!;
    const value = n.inputs[input];
    if (isRef(value) || value === undefined || value === null) return null;
    const spec = specOf(catalog, n.class_type, input);
    const type = typeOf(spec);
    const o = optsOf(spec);
    // a renamed primitive is a control its author made on purpose: it keeps that name
    const name = givenName(node);
    const own = isPrimitive(source, catalog, node) && (name !== null || givenLabel(node, input) !== null);
    const plain = input.replace(/_/g, " ");
    const label = givenLabel(node, input) ?? (name ? (isPrimitive(source, catalog, node) ? name : `${name} · ${plain}`) : plain);
    const also = editor?.shared[`${node}.${input}`];
    // the node author's word on the input: shown as the control's "?"
    const help = typeof o.tooltip === "string" && o.tooltip.trim() ? o.tooltip.trim() : undefined;
    const base = { id: `ctl_${node}_${input}`.replace(/[^a-zA-Z0-9_]/g, "_"), label, target: { node, input }, ...(own ? { front: true } : {}), ...(also?.length ? { also } : {}), ...(help ? { help } : {}) };
    if ((type === "INT" || type === "FLOAT") && typeof value === "number") {
      const step = typeof o.step === "number" ? o.step : type === "INT" ? 1 : 0.01;
      return { ...base, kind: "number", default: value, min: typeof o.min === "number" ? o.min : 0, max: typeof o.max === "number" ? o.max : Math.max(100, value), step };
    }
    if (type === "BOOLEAN" && typeof value === "boolean") return { ...base, ...splitCaptions(label), kind: "toggle", default: value };
    if (choicesOf(spec) && typeof value === "string") {
      const choices = choicesOf(spec)!;
      const file = FILE.test(value) || choices.some((c) => FILE.test(c));
      return { ...base, kind: "choice", default: value, choices: { node: n.class_type, input }, ...(file ? { file: true } : {}) };
    }
    if (type === "STRING" && typeof value === "string" && o.multiline) return { ...base, kind: "text", default: value };
    return null;
  }

  // ---- what it saves
  const MEDIA = ["images", "image", "video", "audio"];
  const outputs: Inspection["outputs"] = [];
  for (const id of ids) {
    const n = graph[id]!;
    const info = catalog[n.class_type];
    if (!info?.output_node) continue;
    // only what shows or saves media that reaches it: utility output nodes (pruning files, printing values)
    // and savers at the end of a part that is switched off are not results
    const fed = MEDIA.filter((k) => isRef(n.inputs[k]));
    if (!fed.length) continue;
    const video = fed.includes("video") || /video|animat|webm|gif/i.test(n.class_type);
    const kind = video ? "video" : fed.includes("images") || fed.includes("image") ? "image" : "audio";
    // a video whose frames come from a node that was given sound, or that takes sound itself
    const sound = kind === "video" && (isRef(n.inputs.audio) || (isRef(n.inputs.video) && isRef(graph[(n.inputs.video as Ref)[0]]?.inputs.audio)));
    outputs.push({ node: id, title: titleOf(id), kind, sound: Boolean(sound) });
  }
  // previews are for the person watching ComfyUI: a save node, and a video over a picture, is the result
  const rank = (o: Inspection["outputs"][number]) => (o.kind === "video" ? 4 : o.kind === "audio" ? 2 : 1) + (/preview/i.test(graph[o.node]!.class_type) ? 0 : 0.5);
  // between two of a kind: the one added last when ids are plain numbers, otherwise the first in the file
  const result = [...outputs].sort((a, b) => rank(b) - rank(a) || (Number(b.node) - Number(a.node) || 0))[0];

  // ---- the texts: by wiring first, by the names given to text nodes when the wiring does not tell
  const texts: Inspection["texts"] = [];
  const seen = (t: Target) => texts.some((x) => x.target.node === t.node && x.target.input === t.input);
  for (const id of ids) {
    const n = graph[id]!;
    const info = catalog[n.class_type];
    if (!info?.output.includes("CONDITIONING")) continue;
    for (const input of Object.keys(n.inputs)) {
      if (typeOf(specOf(catalog, n.class_type, input)) !== "STRING") continue;
      const at = literal(graph, catalog, id, input);
      if (!at || seen(at)) continue;
      const wired = usedAs(graph, uses, [id, info.output.indexOf("CONDITIONING")], [[/^negative/i, "negative"], [/^(positive|conditioning|cond$)/i, "positive"]]);
      texts.push({ target: at, title: givenName(at.node) ?? titleOf(id), text: String(graph[at.node]!.inputs[at.input] ?? ""), role: (wired as "positive" | "negative" | null) ?? "unknown" });
    }
  }
  for (const id of ids) {
    // a renamed multi-line text node that is not wired straight into an encoder (it goes through other nodes first)
    const name = givenName(id);
    const input = Object.keys(graph[id]!.inputs)[0];
    if (!name || !input || !isPrimitive(graph, catalog, id) || typeof graph[id]!.inputs[input] !== "string" || seen({ node: id, input })) continue;
    if (!optsOf(specOf(catalog, graph[id]!.class_type, input)).multiline) continue;
    const role = /negative|avoid/i.test(name) ? "negative" : /positive|prompt/i.test(name) ? "positive" : null;
    if (role) texts.push({ target: { node: id, input }, title: name, text: String(graph[id]!.inputs[input]), role });
  }
  if (!texts.some((t) => t.role === "positive")) {
    // no text was found by its wiring or by a node's name: some nodes take the prompt themselves and build the
    // conditioning inside (an all-in-one "director" node). Their own input says what it is.
    for (const id of ids) {
      for (const [input, value] of Object.entries(graph[id]!.inputs)) {
        if (typeof value !== "string" || seen({ node: id, input }) || !optsOf(specOf(catalog, graph[id]!.class_type, input)).multiline) continue;
        const role = /negative/i.test(input) ? "negative" : /^(prompt|positive(_prompt)?|text|caption)$/i.test(input) ? "positive" : null;
        if (role) texts.push({ target: { node: id, input }, title: titleOf(id), text: value, role });
      }
    }
  }
  const prompt = texts.find((t) => t.role === "positive") ?? texts.find((t) => t.role === "unknown");
  const negative = texts.find((t) => t.role === "negative" && t !== prompt);

  // ---- seeds, size, length
  const seeds: Target[] = [];
  const addSeed = (at: Target | null) => {
    if (at && typeof graph[at.node]!.inputs[at.input] === "number" && !seeds.some((s) => s.node === at.node && s.input === at.input)) seeds.push(at);
  };
  for (const id of ids) for (const input of Object.keys(graph[id]!.inputs)) if (/^(noise_)?seed(_value)?$/.test(input)) addSeed(literal(graph, catalog, id, input));
  // a number node named "Seed" that reaches the samplers through something else
  if (!seeds.length) for (const id of ids) if (isPrimitive(graph, catalog, id) && /^seed$/i.test(givenName(id) ?? "")) addSeed({ node: id, input: Object.keys(graph[id]!.inputs)[0]! });

  let size: Bindings["size"];
  let length: Bindings["length"];
  /** When the size is worked out by other nodes: the setting among them that says how large ("480p", "720p"). */
  let resolution: Target | undefined;
  /** A length the workflow takes in seconds rather than in frames: a control for it, not a conversion. */
  let duration: Target | undefined;
  const sized = ids.filter((id) => "width" in graph[id]!.inputs && "height" in graph[id]!.inputs && !RESIZERS.test(graph[id]!.class_type));
  // what the result is made from: a workflow can hold several ways of making it, of which one is in use
  const reach = result ? ancestors(graph, result.node) : new Set<string>();
  const makesLatent = (id: string) => catalog[graph[id]!.class_type]?.output.includes("LATENT");
  // the node that makes the latent decides the size; a "length" beside it makes it a video
  const generator = sized.find((id) => reach.has(id) && makesLatent(id)) ?? sized.find(makesLatent) ?? sized[0];
  if (generator) {
    const width = literal(graph, catalog, generator, "width");
    const height = literal(graph, catalog, generator, "height");
    const o = optsOf(specOf(catalog, graph[generator]!.class_type, "width"));
    if (width && height) size = { width, height, step: Number(o.step) || 8, min: Math.max(64, Number(o.min) || 64), max: Math.min(4096, Number(o.max) || 4096) };
    else {
      // a size worked out by other nodes (a preset, a calculation) is left to those nodes: look back along what
      // feeds the width for the preset, nearest first (it can sit behind a resize, a measure and some arithmetic)
      const visited = new Set<string>();
      let frontier = [graph[generator]!.inputs.width].filter(isRef).map((r) => r[0]);
      for (let depth = 0; depth < 10 && frontier.length && !resolution; depth++) {
        frontier = frontier.filter((id) => !visited.has(id) && graph[id]);
        for (const id of frontier) {
          visited.add(id);
          const input = Object.keys(graph[id]!.inputs).find((k) => /resolution|megapixel/i.test(k) && typeof graph[id]!.inputs[k] === "string");
          if (input) resolution ??= { node: id, input };
        }
        frontier = frontier.flatMap((id) => Object.values(graph[id]!.inputs).filter(isRef).map((r) => r[0]));
      }
    }
    const seconds = ["duration", "seconds", "duration_seconds"].find((k) => typeof graph[generator]!.inputs[k] === "number");
    if (seconds) duration = { node: generator, input: seconds };
    const lengthInput = ["length", "frames", "num_frames", "video_length"].find((k) => k in graph[generator]!.inputs);
    const at = lengthInput ? literal(graph, catalog, generator, lengthInput) : null;
    if (at && lengthInput) {
      const lo = optsOf(specOf(catalog, graph[generator]!.class_type, lengthInput));
      const frames = Number(graph[at.node]!.inputs[at.input]);
      const step = Number(lo.step) || 1;
      // frames per second: what the node that assembles the video says
      const rate = ids.map((id) => graph[id]!.inputs.frame_rate ?? graph[id]!.inputs.fps).find((v) => typeof v === "number");
      length = { target: at, fps: Number(rate) || 16, step, offset: ((frames % step) + step) % step, min: 1, max: 30 };
    }
  }

  // ---- pictures it loads: what they are named, then what they are wired to
  const loaded = ids.filter((id) => /^LoadImage/.test(graph[id]!.class_type) && typeof graph[id]!.inputs.image === "string");
  const imageRole = (id: string) => {
    const name = givenName(id) ?? "";
    if (/last|end|final/i.test(name)) return "end";
    if (/first|start|open/i.test(name)) return "start";
    return usedAs(graph, uses, [id, 0], [[/end|last/i, "end"], [/start|first/i, "start"], [/mask/i, "mask"]]);
  };
  const binding = (id: string): ImageBinding => {
    const direct = uses.get(`${id}:0`) ?? [];
    const optional = direct.length > 0 && direct.every((u) => u.input in (catalog[graph[u.node]!.class_type]?.input.optional ?? {}));
    // a picture the result is not made from as things are set (the other side of a choice) can be left out too
    return { target: { node: id, input: "image" }, detach: optional ? direct : [], required: !optional && reach.has(id) };
  };
  const images: Inspection["images"] = loaded.map((id) => ({ node: id, title: titleOf(id), role: imageRole(id) as Inspection["images"][number]["role"], binding: binding(id) }));
  const endId = loaded.find((id) => imageRole(id) === "end");
  const startId = loaded.find((id) => id !== endId && imageRole(id) === "start") ?? loaded.find((id) => id !== endId && imageRole(id) !== "mask");
  // the other pictures it loads (references, more pictures to work from): a slot each, named after their loader
  const others = loaded.filter((id) => id !== startId && id !== endId && imageRole(id) !== "mask");
  const pictures = others.map((id, i) => ({ ...binding(id), id: `pic_${id}`.replace(/[^a-zA-Z0-9_]/g, "_"), label: givenName(id) ?? `Image ${i + 2}` }));

  // ---- where LoRAs can go
  const loraPoints: Inspection["loraPoints"] = [];
  for (const id of ids) {
    const n = graph[id]!;
    const out = catalog[n.class_type]?.output ?? [];
    if (n.class_type === POWER_LORAS) {
      // a node that is a list of LoRAs already: Afflatus's list takes its place
      loraPoints.push({ node: id, output: 0, title: titleOf(id), label: givenName(id) ?? "", power: true });
      continue;
    }
    const takesModel = Object.entries(n.inputs).some(([k, v]) => k === "model" && isRef(v));
    if (!out.includes("MODEL") || takesModel || !/load/i.test(n.class_type) || /lora/i.test(n.class_type)) continue;
    const file = Object.values(n.inputs).find((v): v is string => typeof v === "string" && FILE.test(v));
    loraPoints.push({ node: id, output: out.indexOf("MODEL"), title: titleOf(id), label: givenName(id) ?? (file ? stem(file) : n.class_type) });
  }
  // the workflow's own LoRA lists when it has them; else one loader, or a pair (a high and a low model, each
  // with its own LoRAs); with more the user says which
  const lists = loraPoints.filter((p) => p.power);
  const chosen = lists.length ? lists.slice(0, 4) : loraPoints.length <= 2 ? loraPoints : [];

  // ---- everything else that could be a control
  /** What a kind of node does, when its author said. */
  const aboutOf = (classType: string | undefined) => {
    const d = classType ? catalog[classType]?.description : undefined;
    return typeof d === "string" && d.trim() ? d.trim() : undefined;
  };
  const about: Record<string, string> = {};
  for (const n of Object.values(source)) {
    const d = aboutOf(n.class_type);
    if (d) about[n.class_type] = d;
  }
  // a switch is explained by what the nodes it switches do, each kind once
  const toggles: Toggle[] = (editor?.toggles ?? []).map((t) => {
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const e of t.effects) for (const id of e.nodes) {
      const type = source[id]?.class_type;
      const d = aboutOf(type);
      if (!type || !d || seen.has(type)) continue;
      seen.add(type);
      lines.push(`${titleOf(id)}: ${d}`);
    }
    return lines.length ? { ...t, help: lines.slice(0, 3).join(" ") } : t;
  });
  const bound = new Set<string>();
  const mark = (t?: Target) => t && bound.add(`${t.node}.${t.input}`);
  [prompt?.target, negative?.target, ...seeds, size?.width, size?.height, length?.target, ...toggles.flatMap((t) => t.writes)].forEach(mark);
  for (const id of loaded) bound.add(`${id}.image`);
  // an input that only repeats a setting held elsewhere is not a setting of its own
  for (const others of Object.values(editor?.shared ?? {})) others.forEach(mark);
  // on the author's own panel: the settings they meant to be changed, in their order
  const onPanel = (t: Target) => editor?.panel.findIndex((p) => p.node === t.node && p.input === t.input) ?? -1;
  const candidates: Inspection["candidates"] = [];
  const missingFiles: Inspection["missingFiles"] = [];
  const relocated: Inspection["relocated"] = [];
  for (const id of Object.keys(source)) {
    const n = source[id]!;
    if (!catalog[n.class_type] || id === result?.node || n.class_type === POWER_LORAS) continue;
    const primitive = isPrimitive(source, catalog, id);
    for (const input of Object.keys(n.inputs)) {
      if (bound.has(`${id}.${input}`)) continue;
      const c = control(id, input);
      if (!c) continue;
      if (c.file && graph[id]) {
        const choices = choicesOf(specOf(catalog, n.class_type, input)) ?? [];
        // an empty list is a catalog saved without file names: nothing can be said
        const elsewhere = choices.length && !choices.includes(String(c.default)) ? sameFile(choices, String(c.default)) : undefined;
        if (elsewhere) relocated.push({ node: id, input, file: String(c.default), found: elsewhere });
        else if (choices.length && !choices.includes(String(c.default))) {
          const url = editor?.downloads[String(c.default).split(/[\\/]/).pop() ?? ""];
          missingFiles.push({ node: id, input, classType: n.class_type, file: String(c.default), label: c.label, options: choices, ...(url ? { url } : {}) });
        }
      }
      const isResolution = resolution?.node === id && resolution.input === input;
      const isDuration = duration?.node === id && duration.input === input;
      // ticked to begin with: the author's panel when there is one; otherwise what people change most on a
      // sampler and the controls the author named. And the size preset, when the size is not typed in.
      // … and, panel or not, what every pass of sampling and every enlarging is tuned with
      const tuned = c.kind === "number" && (/^(steps(_total)?|scale_by|upscale_by)$/.test(input) || (input === "denoise" && Number(c.default) < 1));
      const upscaler = c.kind === "choice" && input === "model_name" && /upscale/i.test(n.class_type);
      const suggested = isResolution || isDuration || tuned || upscaler || (editor?.panel.length
        ? onPanel(c.target) >= 0
        : (c.kind === "number" && /^(steps(_total)?|cfg|guidance|shift)$/.test(input)) || (primitive && givenName(id) !== null && c.kind !== "text"));
      const named = isResolution ? { ...c, front: true, label: givenLabel(id, input) ?? "Resolution" }
        : isDuration ? { ...c, front: true, label: givenLabel(id, input) ?? "Seconds" }
        : c;
      const offers = c.kind === "choice" ? choicesOf(specOf(catalog, n.class_type, input)) ?? undefined : undefined;
      candidates.push({ ...tame(named, isDuration ? "seconds" : primitive ? (givenName(id) ?? "") : ""), classType: n.class_type, title: titleOf(id), suggested, ...(graph[id] ? {} : { off: true }), ...(offers?.length ? { offers } : {}) });
    }
  }
  // ---- settings of the same name on several nodes are told apart: by the pass of sampling they belong to, else by their node
  const samplerIds = ids.filter((id) => /KSampler|SamplerCustom/.test(graph[id]!.class_type)).sort((a, z) => ancestors(graph, a).size - ancestors(graph, z).size);
  const ORDINAL = ["first", "second", "third", "fourth", "fifth"];
  const passOf = (node: string): string | null => {
    // the pass a node works for: the first sampler that is made from it (or is it)
    const at = samplerIds.findIndex((s) => s === node || ancestors(graph, s).has(node));
    const own = samplerIds.filter((s) => s === node || ancestors(graph, s).has(node)).length;
    // what every pass reads (the text, the model) belongs to none of them
    return samplerIds.length > 1 && at >= 0 && (own === 1 || samplerIds[at] === node) ? `${ORDINAL[at] ?? `${at + 1}th`} pass` : null;
  };
  const sameLabel = new Map<string, number>();
  for (const c of candidates) if (!c.front) sameLabel.set(c.label, (sameLabel.get(c.label) ?? 0) + 1);
  for (const c of candidates) {
    if (c.front || (sameLabel.get(c.label) ?? 0) < 2) continue;
    c.label = `${c.label} · ${passOf(c.target.node) ?? `${c.title} #${c.target.node}`}`;
  }

  // ---- the places it can stop at: outputs of the result's kind that lie on the way to the result
  const stages: Inspection["stages"] = [];
  if (result) {
    const whole = ancestors(graph, result.node);
    const isOutput = (id: string) => outputs.some((o) => o.node === id);
    /** What an output is made from, leaving out the nodes that only show or save. */
    const madeFrom = (id: string) => [...ancestors(graph, id)].filter((x) => !isOutput(x)).sort().join(",");
    const count = (id: string, what: RegExp) => [...ancestors(graph, id)].filter((x) => what.test(graph[x]!.class_type)).length;
    const onTheWay = outputs.filter((o) => o.kind === result.kind && (o.node === result.node || whole.has(o.node)));
    // several outputs can show the same picture (a preview, then a save): one stage, the result when it is among them
    const byMake = new Map<string, string>();
    for (const o of onTheWay) if (!byMake.has(madeFrom(o.node)) || o.node === result.node) byMake.set(madeFrom(o.node), o.node);
    byMake.set(madeFrom(result.node), result.node);
    const nodes = [...byMake.values()].sort((a, z) => ancestors(graph, a).size - ancestors(graph, z).size);
    if (nodes.length > 1) {
      let passes = 0;
      let enlargings = 0;
      const SAMPLER = /KSampler|SamplerCustom/;
      const ENLARGE = /Upscale|ImageScale/;
      // one pass, then an enlarging, then another pass over the larger picture: what A1111 calls hires fix.
      // Stopping after the first pass is that switched off, and the stages are named so.
      const hires = count(nodes[0]!, SAMPLER) === 1 && count(nodes[0]!, ENLARGE) === 0 && count(nodes.at(-1)!, SAMPLER) > 1 && count(nodes.at(-1)!, ENLARGE) > 0;
      nodes.forEach((node, i) => {
        const p = count(node, SAMPLER);
        const e = count(node, ENLARGE);
        const label = i === nodes.length - 1 ? "Full workflow"
          : i === 0 ? "Base pass only"
            : p > passes ? `Through pass ${p}` : e > enlargings ? "Base + upscale, no second pass" : `Up to ${titleOf(node)} #${node}`;
        passes = p;
        enlargings = e;
        stages.push({ node, label });
      });
      // a switch has two ends: off is the base pass, on is the whole workflow. The point between them is left out.
      if (hires) {
        stages.splice(1, stages.length - 2);
        stages[0]!.label = "Hires fix off";
        stages[1]!.label = "Hires fix on";
        // and what the second half is tuned with gets the names it has in A1111
        const second = samplerIds.at(-1)!;
        const rename = (node: string, input: string, label: string) => {
          const c = candidates.find((x) => x.target.node === node && x.target.input === input && !x.front);
          if (c) c.label = label;
        };
        // with the second half named for what it is, the first needs no "first pass" after its settings
        for (const c of candidates) if (!c.front) c.label = c.label.replace(/ · first pass$/, "");
        rename(second, "steps", "Hires steps");
        rename(second, "denoise", "Denoising strength (hires)");
        for (const c of candidates) {
          if (c.front || !ancestors(graph, second).has(c.target.node) || ancestors(graph, stages[0]!.node).has(c.target.node)) continue;
          if (c.target.input === "scale_by" || c.target.input === "upscale_by") c.label = "Upscale by";
          // after an upscale model whose factor is not known, it is not the whole factor: it must not be named as if it were
          const afterModel = scaleAfterModel(graph, c.target);
          if (afterModel && !(afterModel.factor && size && ancestors(graph, afterModel.upscale).has(size.width.node))) c.label = "Scale after the upscaler";
          if (c.target.input === "model_name" && /upscale/i.test(c.classType)) c.label = "Upscaler";
        }
      }
    }
  }

  // every fixed choice of what runs, whether or not it is a control: one ComfyUI refuses stops the render
  const missingChoices: Inspection["missingChoices"] = [];
  for (const id of ids) {
    const n = graph[id]!;
    if (!catalog[n.class_type]) continue;
    for (const [input, value] of Object.entries(n.inputs)) {
      if (typeof value !== "string" || FILE.test(value)) continue;
      const options = choicesOf(specOf(catalog, n.class_type, input));
      if (!options?.length || options.includes(value) || options.some((o) => FILE.test(o))) continue;
      // the closest name: the longest common start ("beta57" → "beta")
      const shared = (o: string) => {
        let i = 0;
        while (i < o.length && i < value.length && o[i]!.toLowerCase() === value[i]!.toLowerCase()) i++;
        return i;
      };
      const best = [...options].sort((x, y) => shared(y) - shared(x) || x.length - y.length)[0];
      missingChoices.push({ node: id, input, classType: n.class_type, title: titleOf(id), value, options, ...(best && shared(best) >= 3 ? { nearest: best } : {}) });
    }
  }

  const ticked = candidates.filter((c) => c.suggested).map(({ classType: _c, title: _t, suggested: _s, off: _o, offers: _f, ...c }) => c);
  const place = (c: Control) => (onPanel(c.target) < 0 ? Number.MAX_SAFE_INTEGER : onPanel(c.target));
  ticked.sort((a, b) => place(a) - place(b));

  const suggested: Bindings | null = result
    ? {
        ...(prompt ? { prompt: prompt.target } : {}),
        ...(negative ? { negative: negative.target } : {}),
        seeds,
        ...(size ? { size } : {}),
        ...(length && result.kind === "video" ? { length } : {}),
        ...(startId ? { startImage: binding(startId) } : {}),
        ...(endId ? { endImage: binding(endId) } : {}),
        pictures,
        loras: chosen.map((p) => ({ node: p.node, output: p.output, label: chosen.length > 1 ? p.label : "", ...(p.power ? { power: true } : {}) })),
        toggles,
        result: { node: result.node, kind: result.kind, sound: result.sound },
        controls: ticked,
        stages,
      }
    : null;

  const packs = Object.fromEntries([...missingNodes, ...missingWhenOn].flatMap((c) => (editor?.packs[c] ? [[c, editor.packs[c]!]] : [])));
  return { nodeCount: Object.keys(source).length, missingNodes, missingWhenOn, missingFiles, missingChoices, relocated, stages, packs, links: editor?.links ?? [], outputs, texts, images, loraPoints, toggles, suggested, candidates, notes, about };
}
