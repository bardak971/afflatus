import { choicesOf, folderOfFileInput, isRef, sameFile, type Graph, type NodeCatalog, type Ref } from "@afflatus/core";
import { optsOf, specOf, typeOf } from "./catalog";
import { scaleAfterModel } from "./recipe";
import { splitCaptions, type Bindings, type Control, type ImageBinding, type MediaBinding, type Mode, type Target, type Toggle, type Wiring } from "./types";
import { ancestors, prune, settle, cutFileNameChains, standInLoaders, standInPrimitives, standInSavers } from "./wiring";
import { chapterName, frameNodes, PASS_WORK } from "./suggest";

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

/** Where a missing file can be had, found before anyone searches: the server adds it from the author's notes, the author's other models, or Manager's list of standard files. */
export interface FileSource {
  how: "notes" | "creator" | "known";
  /** The model and its version, as the site names them. */
  title: string;
  /** The file a download fetches. */
  file: string;
  /** That file has exactly the name asked for. */
  exact: boolean;
  page?: string;
  /** A plain address to fetch from. */
  url?: string;
  /** Or a Civitai version, fetched with `file` picked. */
  civitai?: number;
}

export interface Inspection {
  nodeCount: number;
  /** Node types the workflow uses that this ComfyUI does not have, among the nodes the result is made from. */
  missingNodes: string[];
  /** Node types this ComfyUI does not have in nodes the result does not need (a preview, a sound when done): left out at render, not asked for. */
  missingUnneeded: string[];
  /** Save nodes of a kind this ComfyUI lacks, replaced in the workflow by ComfyUI's own (Afflatus saves and names what it keeps itself). */
  replaced: Array<{ node: string; from: string; to: string }>;
  /** Node types this ComfyUI does not have, used only by parts that are switched off. */
  missingWhenOn: string[];
  /** Files the workflow names that this ComfyUI does not list, with the files it does have for that input, and where to download it when the workflow says. */
  missingFiles: Array<Target & { classType: string; file: string; label: string; options: string[]; url?: string; source?: FileSource }>;
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
  /** Every video the workflow loads (a clip to carry on from, or to arrive at), and every sound. */
  videos: Array<{ node: string; title: string; role: "previous" | "next"; binding: MediaBinding }>;
  sounds: Array<{ node: string; title: string; binding: MediaBinding }>;
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

/**
 * The nodes that load a video or a sound from a file, by type: the input that names the file, and whether
 * that input is a path on disk (ComfyUI's own loaders and the Video Helper Suite's upload ones take a file
 * of the input or temp folder; its "path" ones take a path).
 */
export const MEDIA_LOADERS: Record<string, { kind: "video" | "audio"; input: string; path?: true }> = {
  LoadVideo: { kind: "video", input: "file" },
  VHS_LoadVideo: { kind: "video", input: "video" },
  VHS_LoadVideoFFmpeg: { kind: "video", input: "video" },
  VHS_LoadVideoPath: { kind: "video", input: "video", path: true },
  VHS_LoadVideoFFmpegPath: { kind: "video", input: "video", path: true },
  LoadAudio: { kind: "audio", input: "audio" },
  VHS_LoadAudioUpload: { kind: "audio", input: "audio" },
  VHS_LoadAudio: { kind: "audio", input: "audio_file", path: true },
};
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

/**
 * Follow an output downstream until an input name says what it is used as. An output already followed as far
 * as this is not followed again: a wide graph re-reaches the same node through every consumer and the search
 * would grow by six to the depth without that (a revisit with more depth left may see further, so it goes on).
 */
function usedAs(graph: Graph, uses: Map<string, Target[]>, from: Ref, names: Array<[RegExp, string]>, depth = 6, seen = new Map<string, number>()): string | null {
  const key = `${from[0]}:${from[1]}`;
  if ((seen.get(key) ?? -1) >= depth) return null;
  seen.set(key, depth);
  for (const use of uses.get(key) ?? []) {
    for (const [re, role] of names) if (re.test(use.input)) return role;
    if (depth <= 0) continue;
    // not telling: keep following through that node's outputs (few nodes have more than a handful)
    for (let o = 0; o < 6; o++) {
      const role = usedAs(graph, uses, [use.node, o], names, depth - 1, seen);
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

/** How the workflow's parts are named, and what one of its typed-in settings would be as a control. */
interface Names {
  titleOf(id: string): string;
  /** The name someone gave the node, when it is not just what ComfyUI calls that kind of node. */
  givenName(id: string): string | null;
  /** The name the author gave one setting (in the editor, the label on its socket). */
  givenLabel(node: string, input: string): string | null;
  control(node: string, input: string): Control | null;
}

function namesOf(source: Graph, catalog: NodeCatalog, editor?: Wiring): Names {
  const titleOf = (id: string) => (source[id] as NodeMeta | undefined)?._meta?.title?.trim() || source[id]?.class_type || id;
  const givenName = (id: string): string | null => {
    const title = (source[id] as NodeMeta | undefined)?._meta?.title?.trim();
    const cls = source[id]!.class_type;
    return title && title !== cls && title !== catalog[cls]?.display_name ? title : null;
  };
  const givenLabel = (node: string, input: string) => editor?.labels[`${node}.${input}`]?.replace(/^[\s↳]+/, "").trim() || null;

  function control(node: string, input: string): Control | null {
    const n = source[node]!;
    const value = n.inputs[input];
    if (isRef(value) || value === undefined || value === null) return null;
    const spec = specOf(catalog, n.class_type, input);
    // a node of a kind this ComfyUI lacks says nothing of its inputs: the file's own socket types do (no ranges, no choices)
    const known = Boolean(catalog[n.class_type]);
    const type = known ? typeOf(spec) : (editor?.slots[node]?.in.find(([k]) => k === input)?.[1] ?? "*");
    const o = known ? optsOf(spec) : {};
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
    if (type === "STRING" && typeof value === "string" && (o.multiline || (!known && (value.includes("\n") || value.length > 24)))) return { ...base, kind: "text", default: value };
    return null;
  }
  return { titleOf, givenName, givenLabel, control };
}

/** What every step of the inspection reads. */
interface Reading {
  /** The workflow as saved: every node, switched on or off. */
  source: Graph;
  /** What runs with the switches as they were saved: the parts are looked for in there. */
  graph: Graph;
  /** The ids of `graph`. */
  ids: string[];
  catalog: NodeCatalog;
  /** What only the editor's file knows, when the workflow came from one. */
  editor?: Wiring;
  /** Who reads each output of `graph`. */
  uses: Map<string, Target[]>;
  names: Names;
}

/** Where a setting sits on the author's own panel (the settings they meant to be changed, in their order), or -1 when it is not there. */
const onPanel = (editor: Wiring | undefined, t: Target) => editor?.panel.findIndex((p) => p.node === t.node && p.input === t.input) ?? -1;

type Output = Inspection["outputs"][number];

// ---- what it saves
function findOutputs(r: Reading): { outputs: Inspection["outputs"]; result: Output | undefined; reach: Set<string> } {
  const { graph, ids, catalog, names } = r;
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
    outputs.push({ node: id, title: names.titleOf(id), kind, sound: Boolean(sound) });
  }
  // previews are for the person watching ComfyUI: a save node, and a video over a picture, is the result
  const rank = (o: Output) => (o.kind === "video" ? 4 : o.kind === "audio" ? 2 : 1) + (/preview/i.test(graph[o.node]!.class_type) ? 0 : 0.5);
  // between two of a kind: the one added last when ids are plain numbers, otherwise the first in the file
  const result = [...outputs].sort((a, b) => rank(b) - rank(a) || (Number(b.node) - Number(a.node) || 0))[0];
  // what the result is made from: a workflow can hold several ways of making it, of which one is in use
  const reach = result ? ancestors(graph, result.node) : new Set<string>();
  return { outputs, result, reach };
}

// ---- the texts: by wiring first, by the names given to text nodes when the wiring does not tell
function findTexts(r: Reading): { texts: Inspection["texts"]; prompt: Inspection["texts"][number] | undefined; negative: Inspection["texts"][number] | undefined } {
  const { graph, ids, catalog, uses, names } = r;
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
      texts.push({ target: at, title: names.givenName(at.node) ?? names.titleOf(id), text: String(graph[at.node]!.inputs[at.input] ?? ""), role: (wired as "positive" | "negative" | null) ?? "unknown" });
    }
  }
  for (const id of ids) {
    // a renamed multi-line text node that is not wired straight into an encoder (it goes through other nodes first)
    const name = names.givenName(id);
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
        // a node of a kind this ComfyUI lacks says nothing of its inputs: one named like a prompt, holding text, is taken as one
        const textual = catalog[graph[id]!.class_type] ? Boolean(optsOf(specOf(catalog, graph[id]!.class_type, input)).multiline) : /prompt|text|caption/i.test(input);
        if (typeof value !== "string" || seen({ node: id, input }) || !textual) continue;
        const role = /negative/i.test(input) ? "negative" : /^(prompt|positive(_prompt)?|text|caption)$/i.test(input) ? "positive" : null;
        if (role) texts.push({ target: { node: id, input }, title: names.titleOf(id), text: value, role });
      }
    }
  }
  const prompt = texts.find((t) => t.role === "positive") ?? texts.find((t) => t.role === "unknown");
  const negative = texts.find((t) => t.role === "negative" && t !== prompt);
  return { texts, prompt, negative };
}

// ---- seeds, size, length
function findSizeAndLength(r: Reading, reach: Set<string>): { seeds: Target[]; size: Bindings["size"]; length: Bindings["length"]; resolution: Target | undefined; duration: Target | undefined } {
  const { graph, ids, catalog, names } = r;
  const seeds: Target[] = [];
  const addSeed = (at: Target | null) => {
    if (at && typeof graph[at.node]!.inputs[at.input] === "number" && !seeds.some((s) => s.node === at.node && s.input === at.input)) seeds.push(at);
  };
  for (const id of ids) for (const input of Object.keys(graph[id]!.inputs)) if (/^(noise_)?seed(_value)?$/.test(input)) addSeed(literal(graph, catalog, id, input));
  // a number node named "Seed" that reaches the samplers through something else
  if (!seeds.length) for (const id of ids) if (isPrimitive(graph, catalog, id) && /^seed$/i.test(names.givenName(id) ?? "")) addSeed({ node: id, input: Object.keys(graph[id]!.inputs)[0]! });

  let size: Bindings["size"];
  let length: Bindings["length"];
  /** When the size is worked out by other nodes: the setting among them that says how large ("480p", "720p"). */
  let resolution: Target | undefined;
  /** A length the workflow takes in seconds rather than in frames: a control for it, not a conversion. */
  let duration: Target | undefined;
  const sized = ids.filter((id) => "width" in graph[id]!.inputs && "height" in graph[id]!.inputs && !RESIZERS.test(graph[id]!.class_type));
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
          const cls = graph[id]!.class_type;
          const input = Object.keys(graph[id]!.inputs).find((k) => (/resolution|megapixel|aspect|preset|dimension/i.test(k) || (/resolution|dimension|aspect|size.?picker/i.test(cls) && !/^(width|height)$/i.test(k))) && typeof graph[id]!.inputs[k] === "string");
          if (input) resolution ??= { node: id, input };
        }
        frontier = frontier.flatMap((id) => Object.values(graph[id]!.inputs).filter(isRef).map((r) => r[0]));
      }
    }
    /** The nodes behind an input, nearest first, a few steps back. */
    const behind = (from: unknown, depth = 6): string[] => {
      const seen: string[] = [];
      let frontier = [from].filter(isRef).map((r) => r[0]);
      for (let d = 0; d < depth && frontier.length; d++) {
        frontier = frontier.filter((id) => !seen.includes(id) && graph[id]);
        seen.push(...frontier);
        frontier = frontier.flatMap((id) => Object.values(graph[id]!.inputs).filter(isRef).map((r) => r[0]));
      }
      return seen;
    };
    /** A number node named so, feeding the input through other nodes (a calculation, a rounding). */
    const primitiveNamed = (from: unknown, re: RegExp): Target | undefined => {
      const id = behind(from).find((x) => isPrimitive(graph, catalog, x) && re.test(names.givenName(x) ?? "") && typeof Object.values(graph[x]!.inputs)[0] === "number");
      return id ? { node: id, input: Object.keys(graph[id]!.inputs)[0]! } : undefined;
    };
    if (!size && !resolution) {
      // the size worked out from a width and a height someone typed into named number nodes: those are the size
      const w = primitiveNamed(graph[generator]!.inputs.width, /width/i);
      const h = primitiveNamed(graph[generator]!.inputs.height, /height/i);
      if (w && h && w.node !== h.node) size = { width: w, height: h, step: Number(o.step) || 8, min: Math.max(64, Number(o.min) || 64), max: Math.min(4096, Number(o.max) || 4096) };
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
  if (generator && !length && !duration) {
    const lengthInput = ["length", "frames", "num_frames", "video_length"].find((k) => isRef(graph[generator]!.inputs[k]));
    if (lengthInput) {
      // "Seconds" typed into a number node, turned into a frame count by other nodes: a length control in seconds
      const seen: string[] = [];
      let frontier = [graph[generator]!.inputs[lengthInput]].filter(isRef).map((r) => r[0]);
      for (let d = 0; d < 6 && frontier.length; d++) {
        frontier = frontier.filter((id) => !seen.includes(id) && graph[id]);
        seen.push(...frontier);
        frontier = frontier.flatMap((id) => Object.values(graph[id]!.inputs).filter(isRef).map((r) => r[0]));
      }
      const named = (re: RegExp) => seen.find((x) => isPrimitive(graph, catalog, x) && re.test(names.givenName(x) ?? "") && typeof Object.values(graph[x]!.inputs)[0] === "number");
      const id = named(/second|duration/i);
      if (id) duration = { node: id, input: Object.keys(graph[id]!.inputs)[0]! };
      else {
        // or a frame count typed into a node named so: a length in frames, shown in seconds at the video's rate
        const frames = named(/frames?$|^length|num_frames/i);
        if (frames) {
          const lo = optsOf(specOf(catalog, graph[generator]!.class_type, lengthInput));
          const step = Number(lo.step) || 1;
          const count = Number(Object.values(graph[frames]!.inputs)[0]);
          const rate = ids.map((x) => graph[x]!.inputs.frame_rate ?? graph[x]!.inputs.fps).find((v) => typeof v === "number");
          length = { target: { node: frames, input: Object.keys(graph[frames]!.inputs)[0]! }, fps: Number(rate) || 16, step, offset: ((count % step) + step) % step, min: 1, max: 30 };
        }
      }
    }
  }
  return { seeds, size, length, resolution, duration };
}

// ---- pictures it loads: what they are named, then what they are wired to
function findImages(r: Reading, reach: Set<string>): { images: Inspection["images"]; loaded: string[]; start: ImageBinding | undefined; end: ImageBinding | undefined; pictures: Bindings["pictures"] } {
  const { graph, ids, catalog, uses, names } = r;
  const loaded = ids.filter((id) => /^LoadImage/.test(graph[id]!.class_type) && typeof graph[id]!.inputs.image === "string");
  const imageRole = (id: string) => {
    const name = names.givenName(id) ?? "";
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
  const images: Inspection["images"] = loaded.map((id) => ({ node: id, title: names.titleOf(id), role: imageRole(id) as Inspection["images"][number]["role"], binding: binding(id) }));
  const endId = loaded.find((id) => imageRole(id) === "end");
  const startId = loaded.find((id) => id !== endId && imageRole(id) === "start") ?? loaded.find((id) => id !== endId && imageRole(id) !== "mask");
  // the other pictures it loads (references, more pictures to work from): a slot each, named after their loader
  const others = loaded.filter((id) => id !== startId && id !== endId && imageRole(id) !== "mask");
  const pictures = others.map((id, i) => ({ ...binding(id), id: `pic_${id}`.replace(/[^a-zA-Z0-9_]/g, "_"), label: names.givenName(id) ?? `Image ${i + 2}` }));
  return { images, loaded, start: startId ? binding(startId) : undefined, end: endId ? binding(endId) : undefined, pictures };
}

// ---- videos and sounds it loads: the clip before (its last frames carry on), the clip after, a sound
function findMedia(r: Reading, reach: Set<string>): { videos: Inspection["videos"]; sounds: Inspection["sounds"]; previous: MediaBinding | undefined; next: MediaBinding | undefined; sound: MediaBinding | undefined; keys: string[] } {
  const { graph, ids, catalog, uses, names } = r;
  const loaders = ids.flatMap((id) => {
    const l = MEDIA_LOADERS[graph[id]!.class_type];
    // the file is typed in, not wired from elsewhere
    return l && typeof graph[id]!.inputs[l.input] === "string" ? [{ id, ...l }] : [];
  });
  const binding = (id: string, input: string): MediaBinding => {
    const direct = [0, 1, 2].flatMap((out) => uses.get(`${id}:${out}`) ?? []);
    const optional = direct.length > 0 && direct.every((u) => u.input in (catalog[graph[u.node]!.class_type]?.input.optional ?? {}));
    return { target: { node: id, input }, detach: optional ? direct : [], required: !optional && reach.has(id) };
  };
  // the clip after, by the name the loader was given; otherwise a video is the one to carry on from
  const roleOf = (id: string): "previous" | "next" => (/next|last|end|after|arriv|target/i.test(names.givenName(id) ?? "") ? "next" : "previous");
  const videos: Inspection["videos"] = loaders.filter((l) => l.kind === "video").map((l) => ({ node: l.id, title: names.titleOf(l.id), role: roleOf(l.id), binding: binding(l.id, l.input) }));
  const sounds: Inspection["sounds"] = loaders.filter((l) => l.kind === "audio").map((l) => ({ node: l.id, title: names.titleOf(l.id), binding: binding(l.id, l.input) }));
  // of several of a role, the one the result is made from as things are saved
  const pick = <T extends { node: string; binding: MediaBinding }>(list: T[]) => list.find((v) => reach.has(v.node)) ?? list[0];
  const previous = pick(videos.filter((v) => v.role === "previous"))?.binding;
  const next = pick(videos.filter((v) => v.role === "next"))?.binding;
  const sound = pick(sounds)?.binding;
  return { videos, sounds, previous, next, sound, keys: loaders.map((l) => `${l.id}.${l.input}`) };
}

// ---- where LoRAs can go
function findLoraPoints(r: Reading): { loraPoints: Inspection["loraPoints"]; chosen: Inspection["loraPoints"] } {
  const { graph, ids, catalog, editor, names } = r;
  const loraPoints: Inspection["loraPoints"] = [];
  for (const id of ids) {
    const n = graph[id]!;
    // a loader of a kind this ComfyUI lacks: the file's own socket types say what it gives out (a WANVIDEOMODEL is a model)
    const out = catalog[n.class_type]?.output ?? (editor?.slots[id]?.out ?? []).map((t) => (/MODEL/i.test(String(t)) ? "MODEL" : String(t)));
    if (n.class_type === POWER_LORAS) {
      // a node that is a list of LoRAs already: Afflatus's list takes its place
      loraPoints.push({ node: id, output: 0, title: names.titleOf(id), label: names.givenName(id) ?? "", power: true });
      continue;
    }
    const takesModel = Object.entries(n.inputs).some(([k, v]) => k === "model" && isRef(v));
    if (!out.includes("MODEL") || takesModel || !/load/i.test(n.class_type) || /lora/i.test(n.class_type)) continue;
    const file = Object.values(n.inputs).find((v): v is string => typeof v === "string" && FILE.test(v));
    loraPoints.push({ node: id, output: out.indexOf("MODEL"), title: names.titleOf(id), label: names.givenName(id) ?? (file ? stem(file) : n.class_type) });
  }
  // the workflow's own LoRA lists when it has them; else one loader, or a pair (a high and a low model, each
  // with its own LoRAs); with more the user says which
  const lists = loraPoints.filter((p) => p.power);
  const chosen = lists.length ? lists.slice(0, 4) : loraPoints.length <= 2 ? loraPoints : [];
  return { loraPoints, chosen };
}

// ---- what each kind of node does, and the switches explained by it
function findAbout(r: Reading): { about: Record<string, string>; toggles: Toggle[] } {
  const { source, catalog, editor, names } = r;
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
      lines.push(`${names.titleOf(id)}: ${d}`);
    }
    return lines.length ? { ...t, help: lines.slice(0, 3).join(" ") } : t;
  });
  return { about, toggles };
}

// ---- everything else that could be a control
function collectCandidates(
  r: Reading,
  found: { result: Output | undefined; prompt: Inspection["texts"][number] | undefined; negative: Inspection["texts"][number] | undefined; seeds: Target[]; size: Bindings["size"]; length: Bindings["length"]; toggles: Toggle[]; loaded: string[]; mediaKeys: string[]; model: Bindings["model"]; loaders: Array<{ node: string; label: string }>; resolution: Target | undefined; duration: Target | undefined },
): { candidates: Inspection["candidates"]; missingFiles: Inspection["missingFiles"]; relocated: Inspection["relocated"] } {
  const { source, graph, catalog, editor, names } = r;
  const { result, prompt, negative, seeds, size, length, toggles, loaded, mediaKeys, model, loaders, resolution, duration } = found;
  const bound = new Set<string>();
  const mark = (t?: Target) => t && bound.add(`${t.node}.${t.input}`);
  [prompt?.target, negative?.target, ...seeds, size?.width, size?.height, length?.target, ...toggles.flatMap((t) => t.writes)].forEach(mark);
  for (const id of loaded) bound.add(`${id}.image`);
  for (const key of mediaKeys) bound.add(key);
  // an input that only repeats a setting held elsewhere is not a setting of its own
  for (const others of Object.values(editor?.shared ?? {})) others.forEach(mark);
  const candidates: Inspection["candidates"] = [];
  const missingFiles: Inspection["missingFiles"] = [];
  const relocated: Inspection["relocated"] = [];
  for (const id of Object.keys(source)) {
    const n = source[id]!;
    // a kind this ComfyUI lacks is read by the file's socket types, when the file is the editor's
    if ((!catalog[n.class_type] && !editor?.slots[id]) || id === result?.node || n.class_type === POWER_LORAS) continue;
    const primitive = isPrimitive(source, catalog, id);
    for (const input of Object.keys(n.inputs)) {
      const isModel = model?.target.node === id && model.target.input === input;
      if (bound.has(`${id}.${input}`) && !isModel) continue;
      const c = names.control(id, input);
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
      // the model file is the form's Model picker, not a widget besides
      if (isModel) continue;
      const isResolution = resolution?.node === id && resolution.input === input;
      const isDuration = duration?.node === id && duration.input === input;
      // ticked to begin with: the author's panel when there is one; otherwise what people change most on a
      // sampler and the controls the author named. And the size preset, when the size is not typed in.
      // … and, panel or not, what every pass of sampling and every enlarging is tuned with
      const tuned = c.kind === "number" && (/^(steps(_total)?|scale_by|upscale_by)$/.test(input) || (input === "denoise" && Number(c.default) < 1));
      const upscaler = c.kind === "choice" && input === "model_name" && /upscale/i.test(n.class_type);
      // another model loader's file (a low-noise model beside the high, a refiner): what people swap, so ticked
      // (not when the author made a panel: what they put on it is what they meant to be changed)
      const other = loaders.find((l) => l.node === id);
      const otherModel = Boolean(c.file) && Boolean(other) && folderOfFileInput(n.class_type, input) !== null && !editor?.panel.length;
      if (otherModel) c.label = `Model · ${other!.label}`;
      // the mode of the node that holds the prompt (an all-in-one "director": text to video, picture to video…): what people switch first
      const promptMode = c.kind === "choice" && input === "mode" && prompt?.target.node === id;
      const suggested = isResolution || isDuration || tuned || upscaler || otherModel || promptMode || (editor?.panel.length
        ? onPanel(editor, c.target) >= 0
        : (c.kind === "number" && /^(steps(_total)?|cfg|guidance|shift)$/.test(input)) || (primitive && names.givenName(id) !== null && c.kind !== "text"));
      const named = isResolution ? { ...c, front: true, label: names.givenLabel(id, input) ?? "Resolution" }
        : isDuration ? { ...c, front: true, label: names.givenLabel(id, input) ?? "Seconds" }
        : c;
      const offers = c.kind === "choice" ? choicesOf(specOf(catalog, n.class_type, input)) ?? undefined : undefined;
      candidates.push({ ...tame(named, isDuration ? "seconds" : primitive ? (names.givenName(id) ?? "") : ""), classType: n.class_type, title: names.titleOf(id), suggested, ...(graph[id] ? {} : { off: true }), ...(offers?.length ? { offers } : {}) });
    }
  }
  return { candidates, missingFiles, relocated };
}

/** The passes of sampling, the first pass first (the one the fewest nodes feed). */
function samplerPasses(r: Reading): string[] {
  const { graph, ids } = r;
  return ids.filter((id) => /KSampler|SamplerCustom/.test(graph[id]!.class_type)).sort((a, z) => ancestors(graph, a).size - ancestors(graph, z).size);
}

// ---- settings of the same name on several nodes are told apart: by the pass of sampling they belong to, else by their node
function tellApart(r: Reading, candidates: Inspection["candidates"], samplerIds: string[]): void {
  const { graph } = r;
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
}

// ---- the places it can stop at: outputs of the result's kind that lie on the way to the result
// (a hires-fix workflow also gets its second half's candidates renamed in place, as A1111 names them)
function findStages(r: Reading, made: { result: Output | undefined; outputs: Inspection["outputs"]; candidates: Inspection["candidates"]; samplerIds: string[]; size: Bindings["size"] }): Inspection["stages"] {
  const { graph, names } = r;
  const { result, outputs, candidates, samplerIds, size } = made;
  const stages: Inspection["stages"] = [];
  if (result) {
    const whole = ancestors(graph, result.node);
    const isOutput = (id: string) => outputs.some((o) => o.node === id);
    /** What an output is made from, leaving out the nodes that only show or save. */
    const madeFrom = (id: string) => [...ancestors(graph, id)].filter((x) => !isOutput(x)).sort().join(",");
    const count = (id: string, what: RegExp) => [...ancestors(graph, id)].filter((x) => what.test(graph[x]!.class_type)).length;
    /** The node whose picture an output shows. */
    const shows = (id: string): string | undefined => (["images", "image", "video", "audio"].map((k) => graph[id]!.inputs[k]).find(isRef) as Ref | undefined)?.[0];
    const SAMPLER = /KSampler|SamplerCustom/;
    const DISPLAY = /Decode|Preview|Save|Compar/i;
    // an output beside the way: it shows a picture of a pass the result goes through (everything behind it but its own decoding is needed by the result)
    const beside = (o: Output) => o.node !== result.node && !whole.has(o.node) && count(o.node, SAMPLER) > 0
      && [...ancestors(graph, o.node)].every((x) => whole.has(x) || isOutput(x) || DISPLAY.test(graph[x]!.class_type));
    const onTheWay = outputs.filter((o) => o.kind === result.kind && (o.node === result.node || whole.has(o.node) || beside(o)));
    // several outputs can show the same picture (a preview, then a save): one stage, the result when it is among them
    const byMake = new Map<string, string>();
    for (const o of onTheWay) if (!byMake.has(madeFrom(o.node)) || o.node === result.node) byMake.set(madeFrom(o.node), o.node);
    byMake.set(madeFrom(result.node), result.node);
    const nodes = [...byMake.values()].sort((a, z) => ancestors(graph, a).size - ancestors(graph, z).size);
    if (nodes.length > 1) {
      let passes = 0;
      let enlargings = 0;
      const ENLARGE = /Upscale|ImageScale/;
      // one pass, then an enlarging, then another pass over the larger picture: what A1111 calls hires fix.
      // Stopping after the first pass is that switched off, and the stages are named so.
      const hires = count(nodes[0]!, SAMPLER) === 1 && count(nodes[0]!, ENLARGE) === 0 && count(nodes.at(-1)!, SAMPLER) > 1 && count(nodes.at(-1)!, ENLARGE) > 0;
      nodes.forEach((node, i) => {
        const p = count(node, SAMPLER);
        const e = count(node, ENLARGE);
        const label = i === nodes.length - 1 ? "Full workflow"
          : i === 0 ? "Base pass only"
            : p > passes ? `Through pass ${p}` : e > enlargings ? "Base + upscale, no second pass" : `Up to ${names.titleOf(shows(node) ?? node)} #${shows(node) ?? node}`;
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
  return stages;
}

// ---- every fixed choice of what runs, whether or not it is a control: one ComfyUI refuses stops the render
function findMissingChoices(r: Reading): Inspection["missingChoices"] {
  const { graph, ids, catalog, names } = r;
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
      missingChoices.push({ node: id, input, classType: n.class_type, title: names.titleOf(id), value, options, ...(best && shared(best) >= 3 ? { nearest: best } : {}) });
    }
  }
  return missingChoices;
}

/**
 * @param source the workflow: as exported, or every node of an editor file (see `fromEditor`)
 * @param editor what only the editor's file knows, when the workflow came from one
 * @param notes what the reader of that file could not read with certainty
 */
export function inspect(source: Graph, catalog: NodeCatalog, editor?: Wiring, notes: string[] = []): Inspection {
  // a saver of a pack this ComfyUI lacks: ComfyUI's own stands in, in the workflow itself (what is saved is this graph)
  const has = (c: string) => c in catalog;
  const replaced = [
    ...standInSavers(source, has, editor?.slots),
    ...standInLoaders(source, has, editor?.slots),
    ...standInPrimitives(source, has, editor?.slots, (cls, input) => Boolean(choicesOf(specOf(catalog, cls, input)))),
  ];
  // what runs with the switches as they were saved: the parts are looked for in there
  // a node of a kind this ComfyUI lacks that only patches what passes through it (a model in, the same model out,
  // nothing else read from it): bypassed, with a switch to turn it on once its pack is installed
  const bridged: Toggle[] = [];
  const bridgedModes: Record<string, Mode> = {};
  if (editor) {
    const readers = consumers(source);
    const early = namesOf(source, catalog, editor);
    for (const [id, n] of Object.entries(source)) {
      // (a list of LoRAs is not a patch to pass by: Afflatus's own list takes its place)
      if (catalog[n.class_type] || n.class_type === POWER_LORAS || editor.modes[id] || editor.toggles.some((t) => t.effects.some((e) => e.nodes.includes(id)))) continue;
      const slots = editor.slots[id];
      if (!slots?.out.length) continue;
      // every output that is read has exactly one linked input of its type to hand on (a model, a model and a clip);
      // nothing else is wired in, so the node only patches what passes through it
      const linked = slots.in.filter(([name]) => isRef(n.inputs[name]));
      const readOuts = slots.out.map((t, i) => (readers.has(`${id}:${i}`) ? t : null)).filter((t): t is string => t !== null);
      if (!readOuts.length || !linked.length) continue;
      const types = new Set(readOuts);
      if (![...types].every((t) => linked.filter(([, lt]) => lt === t).length === 1) || !linked.every(([, lt]) => types.has(lt))) continue;
      bridgedModes[id] = "bypass";
      const pack = editor.packs[n.class_type];
      bridged.push({
        id: `sw_${id}`.replace(/[^a-zA-Z0-9_]/g, "_"), label: early.titleOf(id), default: false, writes: [],
        effects: [{ nodes: [id], activeWhen: true, mode: "bypass" }],
        help: `${n.class_type}${pack ? ` (pack ${pack})` : ""} is not in this ComfyUI. Off, what it would change passes it by; install the pack to turn it on.`,
      });
    }
  }
  // a group bypasser (rgthree's) in the workflow: the author's frames are the switches, each on or off as saved
  const bypasser = editor ? Object.values(source).find((n) => /^Fast Groups (Bypasser|Muter)/.test(n.class_type)) : undefined;
  const framed: Toggle[] = [];
  if (editor && bypasser) {
    const mode: Mode = /Muter/.test(bypasser.class_type) ? "mute" : "bypass";
    const covered = new Set([...editor.toggles, ...bridged].flatMap((t) => t.effects.flatMap((e) => e.nodes)));
    const ids = new Set<string>();
    for (const fr of editor.frames) {
      const nodes = fr.nodes.filter((id) => source[id] && !/^Fast Groups|^Note$|^MarkdownNote$/.test(source[id]!.class_type));
      // a frame partly switched by another switch, or with some nodes on and some off, is not one switch
      if (!nodes.length || nodes.some((id) => covered.has(id))) continue;
      const off = nodes.filter((id) => editor.modes[id]);
      if (off.length && off.length !== nodes.length) continue;
      let id = `sw_frame_${fr.title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "frame"}`;
      for (let n = 2; ids.has(id); n++) id = `${id.replace(/_\d+$/, "")}_${n}`;
      ids.add(id);
      framed.push({ id, label: fr.title, default: off.length === 0, writes: [], effects: [{ nodes, activeWhen: true, mode }], help: `The frame "${fr.title}", switched as a whole with ${bypasser.class_type}.` });
    }
  }
  const pruned = prune(source, editor, { ...editor?.modes, ...bridgedModes });
  settle(pruned);
  const { graph } = pruned;
  // a file name built by a chain of nodes: the name is Afflatus's to give, the chain is not read
  cutFileNameChains(graph, "afflatus");
  const ids = Object.keys(graph);
  const r: Reading = { source, graph, ids, catalog, editor, uses: consumers(graph), names: namesOf(source, catalog, editor) };

  const { outputs, result, reach } = findOutputs(r);
  // a frame the author saved switched off, with no switch over it, that is a pass of work feeding the output once on
  // (a detailer, an upscale, a second sampling left for when it is wanted): a switch, off as saved
  const savedOff: Toggle[] = [];
  if (editor && result && !bypasser) {
    const covered = new Set([...editor.toggles, ...bridged].flatMap((t) => t.effects.flatMap((e) => e.nodes)));
    const taken = new Set<string>();
    editor.frames.forEach((fr, i) => {
      const nodes = frameNodes(editor.frames, i).filter((id) => source[id] && !taken.has(id));
      if (!nodes.length || nodes.some((id) => covered.has(id) || !editor.modes[id])) return;
      if (!nodes.some((id) => "steps" in source[id]!.inputs || PASS_WORK.test(source[id]!.class_type))) return;
      // a frame that only holds other frames is not a part of its own: those inside are switched one by one
      if (!fr.nodes.some((id) => source[id])) return;
      // a frame inside one that holds nodes of its own and is saved off as a whole is that one's part
      const up = fr.parent !== undefined ? editor.frames[fr.parent] : undefined;
      if (up && up.nodes.some((id) => source[id]) && frameNodes(editor.frames, fr.parent!).every((id) => !source[id] || editor.modes[id])) return;
      const on = { ...editor.modes, ...bridgedModes };
      for (const id of nodes) delete on[id];
      const lit = prune(source, editor, on);
      const behind = ancestors(lit.graph, result.node);
      if (!nodes.some((id) => behind.has(id)) || [...behind].some((id) => lit.broken.has(id)) || lit.broken.has(result.node)) return;
      for (const id of nodes) taken.add(id);
      const label = chapterName(fr.title);
      let id = `sw_off_${label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "frame"}`;
      for (let n = 2; savedOff.some((t) => t.id === id); n++) id = `${id.replace(/_\d+$/, "")}_${n}`;
      savedOff.push({ id, label, default: false, writes: [], effects: [{ nodes, activeWhen: true, mode: editor.modes[nodes[0]!] === "mute" ? "mute" : "bypass" }], help: fr.note ?? `The frame "${fr.title}", saved switched off.` });
    });
  }
  // what this ComfyUI lacks: among the nodes the result is made from it blocks a render; elsewhere it is left out
  const missingIn = (which: string[]) => [...new Set(which.filter((id) => !catalog[graph[id]!.class_type]).map((id) => graph[id]!.class_type))];
  const needed = result ? ids.filter((id) => id === result.node || reach.has(id)) : ids;
  const missingNodes = missingIn(needed);
  const missingUnneeded = missingIn(ids.filter((id) => !needed.includes(id))).filter((c) => !missingNodes.includes(c));
  const missingWhenOn = [...new Set(Object.keys(source).filter((id) => !graph[id] && !catalog[source[id]!.class_type]).map((id) => source[id]!.class_type))].filter((c) => !missingNodes.includes(c) && !missingUnneeded.includes(c));
  const { texts, prompt, negative } = findTexts(r);
  const { seeds, size, length, resolution, duration } = findSizeAndLength(r, reach);
  const { images, loaded, start, end, pictures } = findImages(r, reach);
  const { videos, sounds, previous, next, sound, keys: mediaKeys } = findMedia(r, reach);
  const { loraPoints, chosen } = findLoraPoints(r);
  // the model file: the loader the LoRAs chain after, the first in use, as the form's Model picker
  const passes = samplerPasses(r);
  const behindBase = passes[0] ? ancestors(graph, passes[0]) : new Set<string>();
  const modelLoader = loraPoints.find((p) => !p.power && behindBase.has(p.node)) ?? chosen.find((p) => !p.power && reach.has(p.node)) ?? chosen.find((p) => !p.power) ?? loraPoints.find((p) => !p.power);
  // ComfyUI's folder for the file: known for its own loaders; for a loader of a kind this ComfyUI lacks, the diffusion models' when the input is named as a model
  const folderFor = (cls: string, input: string) => folderOfFileInput(cls, input) ?? (!catalog[cls] && /model|unet|ckpt|checkpoint|gguf/i.test(input) ? "diffusion_models" : null);
  const modelFile = modelLoader ? Object.entries(graph[modelLoader.node]?.inputs ?? {}).find(([k, v]) => typeof v === "string" && FILE.test(v) && folderFor(graph[modelLoader.node]!.class_type, k)) : undefined;
  const model: Bindings["model"] = modelLoader && modelFile ? { target: { node: modelLoader.node, input: modelFile[0] }, folder: folderFor(graph[modelLoader.node]!.class_type, modelFile[0])! } : undefined;
  const { about, toggles: fileToggles } = findAbout(r);
  const toggles = [...fileToggles, ...bridged, ...framed, ...savedOff];
  const { candidates, missingFiles, relocated } = collectCandidates(r, { result, prompt, negative, seeds, size, length, toggles, loaded, mediaKeys, model, loaders: loraPoints.filter((p) => !p.power && p.node !== modelLoader?.node).map((p) => ({ node: p.node, label: p.label || p.title })), resolution, duration });
  const samplerIds = samplerPasses(r);
  tellApart(r, candidates, samplerIds);
  const stages = findStages(r, { result, outputs, candidates, samplerIds, size });
  const missingChoices = findMissingChoices(r);

  const ticked = candidates.filter((c) => c.suggested).map(({ classType: _c, title: _t, suggested: _s, off: _o, offers: _f, ...c }) => c);
  const place = (c: Control) => (onPanel(editor, c.target) < 0 ? Number.MAX_SAFE_INTEGER : onPanel(editor, c.target));
  ticked.sort((a, b) => place(a) - place(b));

  const suggested: Bindings | null = result
    ? {
        ...(prompt ? { prompt: prompt.target } : {}),
        ...(negative ? { negative: negative.target } : {}),
        seeds,
        ...(size ? { size } : {}),
        ...(length && result.kind === "video" ? { length } : {}),
        ...(model ? { model } : {}),
        ...(start ? { startImage: start } : {}),
        ...(end ? { endImage: end } : {}),
        pictures,
        ...(previous ? { previousVideo: previous } : {}),
        ...(next ? { nextVideo: next } : {}),
        ...(sound ? { sound } : {}),
        loras: chosen.map((p) => ({ node: p.node, output: p.output, label: chosen.length > 1 ? p.label : "", ...(p.power ? { power: true } : {}) })),
        toggles,
        sections: [],
        skip: [],
        result: { node: result.node, kind: result.kind, sound: result.sound },
        controls: ticked,
        stages,
      }
    : null;

  const packs = Object.fromEntries([...missingNodes, ...missingUnneeded, ...missingWhenOn].flatMap((c) => (editor?.packs[c] ? [[c, editor.packs[c]!]] : [])));
  return { nodeCount: Object.keys(source).length, missingNodes, missingUnneeded, replaced, missingWhenOn, missingFiles, missingChoices, relocated, stages, packs, links: editor?.links ?? [], outputs, texts, images, videos, sounds, loraPoints, toggles, suggested, candidates, notes, about };
}
