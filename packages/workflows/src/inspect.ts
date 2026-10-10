import { choicesOf, folderOfFileInput, isRef, sameFile, type Graph, type NodeCatalog, type Ref } from "@afflatus/core";
import { hasKind, infoOf, isSamplingPass, MODEL_FILE, optsOf, own, specOf, typeOf } from "./catalog";
import { scaleAfterModel } from "./recipe";
import { splitCaptions } from "./text";
import type { Bindings, Control, ImageBinding, MediaBinding, Mode, Target, Toggle, Wiring } from "./types";
import { isDirector } from "./director";
import { ancestors, prune, readersOf, selectorOf, settle, cutFileNameChains, soleValue, standInLoaders, standInPrimitives, standInSavers, unbundleContexts, valueAt } from "./wiring";
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
  videos: Array<{ node: string; title: string; role: "source" | "previous" | "next"; binding: MediaBinding }>;
  sounds: Array<{ node: string; title: string; binding: MediaBinding }>;
  /** Places LoRAs can go: after a model loader, or a node that is itself a list of LoRAs. */
  loraPoints: Array<{ node: string; output: number; title: string; label: string; power?: boolean }>;
  /** The on/off switches of the workflow (only an editor file has them). */
  toggles: Toggle[];
  /** The mapping Afflatus would use if the user changed nothing. Null when the workflow has no output node. */
  suggested: Bindings | null;
  /** Every other setting that could be a control; `suggested` ones are ticked to begin with. `off`: its node is switched off as saved. */
  candidates: Array<Control & {
    classType: string;
    title: string;
    suggested: boolean;
    /** Put forward by the workflow's author: on the front of a group node, named by them, or a value node they renamed. */
    byAuthor?: boolean;
    off?: boolean;
    /** What ComfyUI offers for a choice, for showing it before it is saved. */
    offers?: string[];
  }>;
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
 * of the input or temp folder; its "path" ones take a path). A path one names its upload twin, which takes the
 * same settings (`renamed`: under other names), for when the file is one Afflatus uploads.
 */
export const MEDIA_LOADERS: Record<string, { kind: "video" | "audio"; input: string; path?: true; upload?: { classType: string; renamed?: Record<string, string> } }> = {
  LoadVideo: { kind: "video", input: "file" },
  VHS_LoadVideo: { kind: "video", input: "video" },
  VHS_LoadVideoFFmpeg: { kind: "video", input: "video" },
  VHS_LoadVideoPath: { kind: "video", input: "video", path: true, upload: { classType: "VHS_LoadVideo" } },
  VHS_LoadVideoFFmpegPath: { kind: "video", input: "video", path: true, upload: { classType: "VHS_LoadVideoFFmpeg" } },
  LoadAudio: { kind: "audio", input: "audio" },
  VHS_LoadAudioUpload: { kind: "audio", input: "audio" },
  VHS_LoadAudio: { kind: "audio", input: "audio_file", path: true, upload: { classType: "VHS_LoadAudioUpload", renamed: { audio_file: "audio", seek_seconds: "start_time" } } },
};
const RESIZERS = /scale|resize|crop|pad|upscale/i;
const POWER_LORAS = "Power Lora Loader (rgthree)";
const stem = (file: string) => (file.split(/[\\/]/).pop() ?? file).replace(MODEL_FILE, "");

const VALUE_TYPES = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "*"]);

/** Nodes that hand a text on unchanged (as things are usually set): the input each output gives, by output. */
const PASSES_TEXT: Record<string, string[]> = {
  "SDXL Prompt Handling (JPS)": ["pos_g", "pos_l"],
};

/** rgthree's nodes that live in the editor only (no pack to install makes them run): never a part to switch on later. */
const EDITOR_ONLY = /^(Node Collector|Mute \/ Bypass (Repeater|Relay)|Fast (Muter|Bypasser|Groups (Muter|Bypasser)|Actions Button)|Bookmark|Label) \(rgthree\)$/;

/** A node that only holds one typed-in value for others to read: one input, typed in, and one plain value out. */
const isPrimitive = (graph: Graph, catalog: NodeCatalog, id: string) => {
  const out = infoOf(catalog, graph[id]?.class_type ?? "")?.output;
  return Boolean(soleValue(graph[id])) && (!out || (out.length === 1 && VALUE_TYPES.has(String(out[0]))));
};

/**
 * The place a value is really typed in. A literal input is itself; an input linked to a primitive
 * node (a number or text node people use to share one value) is that node's own value input.
 */
function literal(graph: Graph, catalog: NodeCatalog, node: string, input: string, depth = 4): Target | null {
  const value = graph[node]?.inputs[input];
  if (value === undefined) return null;
  if (!isRef(value)) return { node, input };
  if (isPrimitive(graph, catalog, value[0])) return { node: value[0], input: Object.keys(graph[value[0]]!.inputs)[0]! };
  // a text handed on by a node that only passes it (JPS's prompt handling): the text it was given
  const from = graph[value[0]];
  const through = PASSES_TEXT[from?.class_type ?? ""]?.[value[1]];
  if (depth > 0 && through && from && through in from.inputs) return literal(graph, catalog, value[0], through, depth - 1);
  // a size handed back out by the node it was given to (a resize that gives its width and height on): that input's value
  const out = String(infoOf(catalog, from?.class_type ?? "")?.output_name?.[value[1]] ?? "").toLowerCase();
  return depth > 0 && /^(width|height)$/.test(out) && from && out in from.inputs ? literal(graph, catalog, value[0], out, depth - 1) : null;
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
    return title && title !== cls && title !== infoOf(catalog, cls)?.display_name ? title : null;
  };
  const givenLabel = (node: string, input: string) => own(editor?.labels, `${node}.${input}`)?.replace(/^[\s↳]+/, "").trim() || null;

  function control(node: string, input: string): Control | null {
    const n = source[node]!;
    const value = n.inputs[input];
    if (isRef(value) || value === undefined || value === null) return null;
    const spec = specOf(catalog, n.class_type, input);
    // a node of a kind this ComfyUI lacks says nothing of its inputs: the file's own socket types do (no ranges, no choices)
    const known = hasKind(catalog, n.class_type);
    const type = known ? typeOf(spec) : (editor?.slots[node]?.in.find(([k]) => k === input)?.[1] ?? "*");
    const o = known ? optsOf(spec) : {};
    // a renamed primitive is a control its author made on purpose: it keeps that name
    const name = givenName(node);
    const authored = isPrimitive(source, catalog, node) && (name !== null || givenLabel(node, input) !== null);
    const plain = input.replace(/_/g, " ");
    const label = givenLabel(node, input) ?? (name ? (isPrimitive(source, catalog, node) ? name : `${name} · ${plain}`) : plain);
    const also = own(editor?.shared, `${node}.${input}`);
    // the node author's word on the input: shown as the control's "?"
    const help = typeof o.tooltip === "string" && o.tooltip.trim() ? o.tooltip.trim() : undefined;
    const base = { id: `ctl_${node}_${input}`.replace(/[^a-zA-Z0-9_]/g, "_"), label, target: { node, input }, ...(authored ? { front: true } : {}), ...(also?.length ? { also } : {}), ...(help ? { help } : {}) };
    if ((type === "INT" || type === "FLOAT") && typeof value === "number") {
      const step = typeof o.step === "number" ? o.step : type === "INT" ? 1 : 0.01;
      return { ...base, kind: "number", default: value, min: typeof o.min === "number" ? o.min : 0, max: typeof o.max === "number" ? o.max : Math.max(100, value), step };
    }
    if (type === "BOOLEAN" && typeof value === "boolean") return { ...base, ...splitCaptions(label), kind: "toggle", default: value };
    if (choicesOf(spec) && typeof value === "string") {
      const choices = choicesOf(spec)!;
      const file = MODEL_FILE.test(value) || choices.some((c) => MODEL_FILE.test(c));
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
  /** What a node of `graph` is made from (its ancestors), worked out once per node. */
  behind(id: string): Set<string>;
}

/** `ancestors` in `graph`, each node's once: sorts and passes ask for the same ones many times. */
function behindOf(graph: Graph): (id: string) => Set<string> {
  const known = new Map<string, Set<string>>();
  return (id) => {
    let set = known.get(id);
    if (!set) known.set(id, (set = ancestors(graph, id)));
    return set;
  };
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
    const info = infoOf(catalog, n.class_type);
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
  const reach = result ? r.behind(result.node) : new Set<string>();
  return { outputs, result, reach };
}

// ---- the texts: by wiring first, by the names given to text nodes when the wiring does not tell
function findTexts(r: Reading): { texts: Inspection["texts"]; prompt: Inspection["texts"][number] | undefined; negative: Inspection["texts"][number] | undefined } {
  const { graph, ids, catalog, uses, names } = r;
  const texts: Inspection["texts"] = [];
  const seen = (t: Target) => texts.some((x) => x.target.node === t.node && x.target.input === t.input);
  for (const id of ids) {
    const n = graph[id]!;
    const info = infoOf(catalog, n.class_type);
    if (!info?.output.includes("CONDITIONING")) continue;
    for (const input of Object.keys(n.inputs)) {
      if (typeOf(specOf(catalog, n.class_type, input)) !== "STRING") continue;
      const at = literal(graph, catalog, id, input);
      if (!at || seen(at)) continue;
      const wired = usedAs(graph, uses, [id, info.output.indexOf("CONDITIONING")], [[/^negative/i, "negative"], [/^(positive|conditioning|cond$)/i, "positive"]]);
      // the wiring says nothing (the text goes through other nodes first): the name its author gave the text node
      const given = names.givenName(at.node) ?? "";
      const named = /negative|avoid/i.test(given) ? "negative" : /positive|prompt/i.test(given) ? "positive" : null;
      texts.push({ target: at, title: given || names.titleOf(id), text: String(graph[at.node]!.inputs[at.input] ?? ""), role: (wired as "positive" | "negative" | null) ?? named ?? "unknown" });
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
        const textual = hasKind(catalog, graph[id]!.class_type) ? Boolean(optsOf(specOf(catalog, graph[id]!.class_type, input)).multiline) : /prompt|text|caption/i.test(input);
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
const LENGTH_INPUTS = ["length", "frames", "num_frames", "video_length"];
/** What a node's step and range options say a size is typed in steps of. */
const sizeOf = (width: Target, height: Target, o: Record<string, unknown>): NonNullable<Bindings["size"]> => ({ width, height, step: Number(o.step) || 8, min: Math.max(64, Number(o.min) || 64), max: Math.min(4096, Number(o.max) || 4096) });
/** The nodes behind an input, nearest first, a few steps back. */
function nodesBehind(graph: Graph, from: unknown, depth = 6): string[] {
  const seen: string[] = [];
  let frontier = [from].filter(isRef).map((x) => x[0]);
  for (let d = 0; d < depth && frontier.length; d++) {
    frontier = frontier.filter((id) => !seen.includes(id) && graph[id]);
    seen.push(...frontier);
    frontier = frontier.flatMap((id) => Object.values(graph[id]!.inputs).filter(isRef).map((x) => x[0]));
  }
  return seen;
}
/** A number node named so among some nodes: the place its value is typed in. */
function primitiveNamed(r: Reading, among: string[], re: RegExp): Target | undefined {
  const { graph, catalog, names } = r;
  const id = among.find((x) => isPrimitive(graph, catalog, x) && re.test(names.givenName(x) ?? "") && typeof soleValue(graph[x])?.value === "number");
  return id ? { node: id, input: soleValue(graph[id])!.input } : undefined;
}
/** Nodes that make frames between the frames they are given (RIFE, FILM and the like): the video plays more frames at its rate. */
const INTERPOLATES = /VFI|interpolat/i;
const rateIn = (node: Graph[string]) => node.inputs.frame_rate ?? node.inputs.fps;
/** A number known before anything runs: typed in, read from a number node, or through nodes that only turn it into another type (an int to a float). */
function numberAt(graph: Graph, value: unknown, depth = 3): number {
  const known = valueAt(graph, value);
  if (known !== undefined || !isRef(value)) return Number(known);
  const linked = Object.values(graph[value[0]]?.inputs ?? {});
  return depth > 0 && linked.length === 1 ? numberAt(graph, linked[0], depth - 1) : NaN;
}
/**
 * The frames per second of the frames the latent is decoded into, which the length is counted in. The output the
 * result is made from says the rate it plays at (typed in, or read from a number node), or the nearest node behind
 * it that assembles the video does. Frame interpolation between the decode and that output plays "multiplier"
 * frames for each one made at that rate, so the rate of the frames made is the output's divided by it: Wan with
 * RIFE ×2 into a combine at 32 fps makes 16 frames a second. What cannot be read is told in the notes.
 */
function rateOf(r: Reading, result: Output | undefined, generator: string | undefined, notes: string[]): number {
  const { graph } = r;
  let rate: number | undefined;
  let unread: string | undefined;
  // nearest first from the output: the rate the result is played at, not that of a preview on another branch
  for (const id of result ? nodesBehind(graph, [result.node, 0], 12) : []) {
    const given = rateIn(graph[id]!);
    if (given === undefined) continue;
    const value = numberAt(graph, given);
    if (Number.isFinite(value) && value > 0) rate = value;
    else unread = r.names.titleOf(id);
    break;
  }
  if (rate === undefined) {
    // no output says it: the first rate typed in anywhere, as before, else Wan's usual 16
    rate = Number(r.ids.map((id) => rateIn(graph[id]!)).find((v) => typeof v === "number")) || 16;
    notes.push(unread ? `The frame rate of ${unread} is worked out by other nodes: Length is counted at ${rate} fps.` : `No frame rate was found on the output: Length is counted at ${rate} fps.`);
  }
  if (!result) return rate;
  for (const id of r.behind(result.node)) {
    const n = graph[id]!;
    // only what stands between the frames made and the output: an interpolation the latent's frames go through
    if (!INTERPOLATES.test(n.class_type) || (generator && !r.behind(id).has(generator))) continue;
    const multiplier = numberAt(graph, n.inputs.multiplier);
    if (Number.isFinite(multiplier) && multiplier >= 1) rate /= multiplier;
    else notes.push(`The frame interpolation multiplier of ${r.names.titleOf(id)} could not be read: Length is counted at ${rate} fps.`);
  }
  return Math.round(rate * 1000) / 1000;
}

function findSeeds(r: Reading): Target[] {
  const { graph, ids, catalog, names } = r;
  const seeds: Target[] = [];
  const addSeed = (at: Target | null) => {
    if (at && typeof graph[at.node]!.inputs[at.input] === "number" && !seeds.some((s) => s.node === at.node && s.input === at.input)) seeds.push(at);
  };
  for (const id of ids) for (const input of Object.keys(graph[id]!.inputs)) if (/^(noise_)?seed(_value)?$/.test(input)) addSeed(literal(graph, catalog, id, input));
  // a number node named "Seed" that reaches the samplers through something else
  if (!seeds.length) for (const id of ids) if (isPrimitive(graph, catalog, id) && /^seed$/i.test(names.givenName(id) ?? "")) addSeed({ node: id, input: soleValue(graph[id])!.input });
  return seeds;
}

/** The size: typed into the node that makes the latent, or into number nodes named so; else the preset it is worked out from. */
function findSize(r: Reading, reach: Set<string>): { generator: string | undefined; size: Bindings["size"]; resolution: Target | undefined } {
  const { graph, ids, catalog } = r;
  const sized = ids.filter((id) => "width" in graph[id]!.inputs && "height" in graph[id]!.inputs && !RESIZERS.test(graph[id]!.class_type));
  const makesLatent = (id: string) => infoOf(catalog, graph[id]!.class_type)?.output.includes("LATENT");
  // the node that makes the latent decides the size; a "length" beside it makes it a video
  const generator = sized.find((id) => reach.has(id) && makesLatent(id)) ?? sized.find(makesLatent) ?? sized[0];
  if (!generator) return { generator, size: undefined, resolution: undefined };
  const width = literal(graph, catalog, generator, "width");
  const height = literal(graph, catalog, generator, "height");
  const o = optsOf(specOf(catalog, graph[generator]!.class_type, "width"));
  if (width && height) return { generator, size: sizeOf(width, height, o), resolution: undefined };
  // a size worked out by other nodes (a preset, a calculation) is left to those nodes: look back along what
  // feeds the width for the preset, nearest first (it can sit behind a resize, a measure and some arithmetic)
  let resolution: Target | undefined;
  const visited = new Set<string>();
  let frontier = [graph[generator]!.inputs.width].filter(isRef).map((x) => x[0]);
  for (let depth = 0; depth < 10 && frontier.length && !resolution; depth++) {
    frontier = frontier.filter((id) => !visited.has(id) && graph[id]);
    for (const id of frontier) {
      visited.add(id);
      const cls = graph[id]!.class_type;
      const input = Object.keys(graph[id]!.inputs).find((k) => (/resolution|megapixel|aspect|preset|dimension/i.test(k) || (/resolution|dimension|aspect|size.?picker/i.test(cls) && !/^(width|height)$/i.test(k))) && typeof graph[id]!.inputs[k] === "string");
      if (input) resolution ??= { node: id, input };
    }
    frontier = frontier.flatMap((id) => Object.values(graph[id]!.inputs).filter(isRef).map((x) => x[0]));
  }
  if (resolution) return { generator, size: undefined, resolution };
  // the size worked out from a width and a height someone typed into named number nodes: those are the size
  const w = primitiveNamed(r, nodesBehind(graph, graph[generator]!.inputs.width), /width/i);
  const h = primitiveNamed(r, nodesBehind(graph, graph[generator]!.inputs.height), /height/i);
  return { generator, size: w && h && w.node !== h.node ? sizeOf(w, h, o) : undefined, resolution: undefined };
}

/** The length of a video: a frame count on the node that makes the latent, seconds typed there, or a number node named so. */
function findLength(r: Reading, generator: string | undefined, result: Output | undefined, notes: string[]): { length: Bindings["length"]; duration: Target | undefined } {
  const { graph, catalog } = r;
  if (!generator) return { length: undefined, duration: undefined };
  const inputs = graph[generator]!.inputs;
  const stepOf = (input: string) => Number(optsOf(specOf(catalog, graph[generator]!.class_type, input)).step) || 1;
  const lengthOf = (target: Target, input: string, frames: number): Bindings["length"] => {
    const step = stepOf(input);
    return { target, fps: rateOf(r, result, generator, notes), step, offset: ((frames % step) + step) % step, min: 1, max: 30 };
  };
  const seconds = ["duration", "seconds", "duration_seconds"].find((k) => typeof inputs[k] === "number");
  const duration: Target | undefined = seconds ? { node: generator, input: seconds } : undefined;
  const lengthInput = LENGTH_INPUTS.find((k) => k in inputs);
  const at = lengthInput ? literal(graph, catalog, generator, lengthInput) : null;
  if (at && lengthInput) return { length: lengthOf(at, lengthInput, Number(graph[at.node]!.inputs[at.input])), duration };
  if (duration) return { length: undefined, duration };
  const linked = LENGTH_INPUTS.find((k) => isRef(inputs[k]));
  if (!linked) return { length: undefined, duration: undefined };
  // "Seconds" typed into a number node, turned into a frame count by other nodes: a length control in seconds
  const behind = nodesBehind(graph, inputs[linked]);
  const secondsNode = primitiveNamed(r, behind, /second|duration/i);
  if (secondsNode) return { length: undefined, duration: secondsNode };
  // or a frame count typed into a node named so: a length in frames, shown in seconds at the video's rate
  const frames = primitiveNamed(r, behind, /frames?$|^length|num_frames/i);
  return { length: frames ? lengthOf(frames, linked, Number(graph[frames.node]!.inputs[frames.input])) : undefined, duration: undefined };
}

// ---- pictures it loads: what they are named, then what they are wired to
/** Inputs that take the first or the last frame: "start_image", "end_image", "first_frame" (not "start_at_step", not "blend"). */
const FRAME_ROLES: Array<[RegExp, string]> = [[/^(?=.*(^|_)(end|last)(_|$)).*(image|frame|img)/i, "end"], [/^(?=.*(^|_)(start|first)(_|$)).*(image|frame|img)/i, "start"]];
function findImages(r: Reading, reach: Set<string>): { images: Inspection["images"]; loaded: string[]; start: ImageBinding | undefined; end: ImageBinding | undefined; pictures: Bindings["pictures"] } {
  const { graph, ids, catalog, uses, names } = r;
  const loaded = ids.filter((id) => /^LoadImage/.test(graph[id]!.class_type) && typeof graph[id]!.inputs.image === "string");
  const imageRole = (id: string) => {
    // the wiring says it best: a picture that goes into a "start_image" or an "end_image" (straight, or through a
    // node that takes no other picture, a resize or a crop) is that, whatever it is called. Further down the wiring is
    // less sure than the name (a node given both pictures, a long video's segments handing their last frame on as the
    // next one's start), so that is asked last.
    const roleOf = (input: string) => (FRAME_ROLES.find(([re]) => re.test(input))?.[1] ?? null);
    for (const u of uses.get(`${id}:0`) ?? []) {
      const wired = roleOf(u.input);
      if (wired) return wired;
      const n = graph[u.node]!;
      if (Object.entries(n.inputs).filter(([k, v]) => isRef(v) && /image|pixels|frame/i.test(k)).length !== 1) continue;
      for (let o = 0; o < 6; o++) for (const next of uses.get(`${u.node}:${o}`) ?? []) if (roleOf(next.input)) return roleOf(next.input);
    }
    // then the name, in whole words ("Blend overlay" is no end, "OpenPose reference" no start; "FirstFrame" is two words)
    const words = (names.givenName(id) ?? "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ");
    if (/\b(last|end|ending|final)\b/i.test(words)) return "end";
    if (/\b(first|start|starting|opening)\b/i.test(words)) return "start";
    // a mask picture is fed straight in (or through an image-to-mask): further down, a "mask" input is some other part's
    if ((uses.get(`${id}:0`) ?? []).some((u) => /mask/i.test(u.input) || /ToMask/i.test(graph[u.node]!.class_type))) return "mask";
    return usedAs(graph, uses, [id, 0], FRAME_ROLES);
  };
  const binding = (id: string): ImageBinding => {
    const direct = uses.get(`${id}:0`) ?? [];
    const optional = direct.length > 0 && direct.every((u) => Object.hasOwn(infoOf(catalog, graph[u.node]!.class_type)?.input.optional ?? {}, u.input));
    // a picture the result is not made from as things are set (the other side of a choice) can be left out too
    return { target: { node: id, input: "image" }, detach: optional ? direct : [], required: !optional && reach.has(id) };
  };
  const images: Inspection["images"] = loaded.map((id) => ({ node: id, title: names.titleOf(id), role: imageRole(id) as Inspection["images"][number]["role"], binding: binding(id) }));
  const endId = loaded.find((id) => imageRole(id) === "end");
  const startId = loaded.find((id) => id !== endId && imageRole(id) === "start") ?? loaded.find((id) => id !== endId && imageRole(id) !== "mask");
  // the other pictures it loads (references, more pictures to work from): a slot each, named after their loader
  const others = loaded.filter((id) => id !== startId && id !== endId && imageRole(id) !== "mask");
  const pictures = others.map((id, i) => ({ ...binding(id), id: pictureId(id), label: names.givenName(id) ?? `Image ${i + 2}` }));
  return { images, loaded, start: startId ? binding(startId) : undefined, end: endId ? binding(endId) : undefined, pictures };
}

/** The form's input id of a picture loader that is not the start or the end. */
export const pictureId = (node: string) => `pic_${node}`.replace(/[^a-zA-Z0-9_]/g, "_");
/** The form's input id of a sound loader that is not the main one. */
export const soundId = (node: string) => `snd_${node}`.replace(/[^a-zA-Z0-9_]/g, "_");
/** The form's input id of a video loader that is not the main source. */
export const videoId = (node: string) => `vid_${node}`.replace(/[^a-zA-Z0-9_]/g, "_");

// ---- videos and sounds it loads: the clip before (its last frames carry on), the clip after, a sound
function findMedia(r: Reading, reach: Set<string>): { videos: Inspection["videos"]; sounds: Inspection["sounds"]; previous: MediaBinding | undefined; next: MediaBinding | undefined; source: MediaBinding | undefined; otherVideos: Bindings["otherVideos"]; sound: MediaBinding | undefined; otherSounds: Bindings["otherSounds"]; keys: string[] } {
  const { graph, ids, catalog, uses, names } = r;
  const loaders = ids.flatMap((id) => {
    const l = MEDIA_LOADERS[graph[id]!.class_type];
    // the file is typed in, not wired from elsewhere
    return l && typeof graph[id]!.inputs[l.input] === "string" ? [{ id, ...l }] : [];
  });
  const binding = (id: string, input: string): MediaBinding => {
    const direct = [0, 1, 2].flatMap((out) => uses.get(`${id}:${out}`) ?? []);
    const optional = direct.length > 0 && direct.every((u) => Object.hasOwn(infoOf(catalog, graph[u.node]!.class_type)?.input.optional ?? {}, u.input));
    return { target: { node: id, input }, detach: optional ? direct : [], required: !optional && reach.has(id) };
  };
  // by the name the loader was given: the clip after, the clip before; otherwise a video to work on (an upscale, a
  // video-to-video, a control video: what nearly every workflow loads a video for). A hint: the import screen changes it
  const roleOf = (id: string): Inspection["videos"][number]["role"] => {
    const given = names.givenName(id) ?? "";
    if (/next|after|arriv|target/i.test(given)) return "next";
    return /previous|prev|before|continu|extend|carry|last frames?/i.test(given) ? "previous" : "source";
  };
  const videos: Inspection["videos"] = loaders.filter((l) => l.kind === "video").map((l) => ({ node: l.id, title: names.titleOf(l.id), role: roleOf(l.id), binding: binding(l.id, l.input) }));
  const sounds: Inspection["sounds"] = loaders.filter((l) => l.kind === "audio").map((l) => ({ node: l.id, title: names.titleOf(l.id), binding: binding(l.id, l.input) }));
  // of several of a role, the one the result is made from as things are saved
  const pick = <T extends { node: string; binding: MediaBinding }>(list: T[]) => list.find((v) => reach.has(v.node)) ?? list[0];
  const previous = pick(videos.filter((v) => v.role === "previous"))?.binding;
  const next = pick(videos.filter((v) => v.role === "next"))?.binding;
  const sources = videos.filter((v) => v.role === "source");
  const source = pick(sources);
  const otherVideos = sources.filter((v) => v !== source).map((v, i) => ({ ...v.binding, id: videoId(v.node), label: names.givenName(v.node) ?? `Video ${i + 2}` }));
  const sound = pick(sounds)?.binding;
  // the other sounds it loads (the music beside a voice, a second speaker): a slot each, as the other pictures,
  // so that none keeps the author's file, which this ComfyUI would not have
  const otherSounds = sounds.filter((s) => s.binding !== sound).map((s, i) => ({ ...s.binding, id: soundId(s.node), label: names.givenName(s.node) ?? `Sound ${i + 2}` }));
  return { videos, sounds, previous, next, source: source?.binding, otherVideos, sound, otherSounds, keys: loaders.map((l) => `${l.id}.${l.input}`) };
}

// ---- where LoRAs can go
function findLoraPoints(r: Reading): { loraPoints: Inspection["loraPoints"]; chosen: Inspection["loraPoints"] } {
  const { graph, ids, catalog, editor, names } = r;
  const loraPoints: Inspection["loraPoints"] = [];
  for (const id of ids) {
    const n = graph[id]!;
    // a loader of a kind this ComfyUI lacks: the file's own socket types say what it gives out (a WANVIDEOMODEL is a model)
    const out = infoOf(catalog, n.class_type)?.output ?? (editor?.slots[id]?.out ?? []).map((t) => (/MODEL/i.test(String(t)) ? "MODEL" : String(t)));
    if (n.class_type === POWER_LORAS) {
      // a node that is a list of LoRAs already: Afflatus's list takes its place
      loraPoints.push({ node: id, output: 0, title: names.titleOf(id), label: names.givenName(id) ?? "", power: true });
      continue;
    }
    const takesModel = Object.entries(n.inputs).some(([k, v]) => k === "model" && isRef(v));
    if (!out.includes("MODEL") || takesModel || !/load/i.test(n.class_type) || /lora/i.test(n.class_type)) continue;
    const file = Object.values(n.inputs).find((v): v is string => typeof v === "string" && MODEL_FILE.test(v));
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
    const d = classType ? infoOf(catalog, classType)?.description : undefined;
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

/**
 * When a number picks one of a switch's inputs (on the switch itself, or in a value node that only feeds switches),
 * the values it can take, each named after what it picks: the name its author gave the node behind that input, else
 * the node's title. Only the inputs that are connected; nothing when the saved value picks none of them.
 */
function picksOf(r: Reading, node: string, input: string): Array<{ value: number; label: string }> | undefined {
  const { graph, names } = r;
  const n = graph[node];
  if (!n) return undefined;
  const own = selectorOf(n.class_type);
  const switches = own?.by === input ? [node]
    : (r.uses.get(`${node}:0`) ?? []).filter((t) => selectorOf(graph[t.node]?.class_type)?.by === t.input).map((t) => t.node);
  const at = switches[0];
  if (!at) return undefined;
  const sw = graph[at]!;
  const sel = selectorOf(sw.class_type)!;
  const options = sel.options(sw).filter((o) => typeof o.value === "number" && isRef(sw.inputs[o.input]));
  const value = Number(n.inputs[input]);
  if (options.length < 2 || !options.some((o) => o.value === value)) return undefined;
  // the author's own legend ("Styler first (1) / Styler second (2)", "1 = Base | 2 = Refined"): on the value's node,
  // the switch, or the frame either is drawn in
  const frames = (r.editor?.frames ?? []).filter((f) => f.nodes.includes(node) || f.nodes.includes(at)).map((f) => f.title);
  const legend = [names.titleOf(node), names.titleOf(at), ...frames].map(legendOf).find((l) => options.every((o) => l.has(o.value as number)));
  const titled = options.map((o) => {
    const from = (sw.inputs[o.input] as Ref)[0];
    return { value: o.value as number, label: legend?.get(o.value as number) ?? names.givenName(from) ?? String(o.value) };
  });
  // two of one name are told apart by their number
  return titled.map((t) => (titled.filter((x) => x.label === t.label).length > 1 ? { ...t, label: `${t.label} (${t.value})` } : t));
}

/** The values a title names: "Styler first (1) / Styler second (2)" or "1 = Base | 2: Refined". */
export function legendOf(title: string): Map<number, string> {
  const out = new Map<number, string>();
  const clean = (t: string) => t.replace(/[\p{Extended_Pictographic}➡️⬅️]/gu, "").replace(/^[\s:;,.\-–—]+|[\s:;,.\-–—]+$/g, "").trim();
  for (const m of title.matchAll(/([^/|,;()]+?)\s*\((\d+)\)/g)) if (clean(m[1]!)) out.set(Number(m[2]), clean(m[1]!));
  if (out.size < 2) {
    out.clear();
    for (const m of title.matchAll(/(\d+)\s*[=:]\s*([^/|,;]+)/g)) if (clean(m[2]!)) out.set(Number(m[1]), clean(m[2]!));
  }
  return out.size >= 2 ? out : new Map();
}

/** A picture, a clip or a sound by its file name. */
const MEDIA_FILE = /\.(png|jpe?g|webp|gif|bmp|mp4|webm|mov|mkv|wav|mp3|flac|ogg)$/i;
/** Slider nodes that keep an int and a float: the inputs that are the value they give. */
const SLIDERS: Record<string, (inputs: Record<string, unknown>) => string[]> = {
  mxSlider: (i) => [i.isfloatX ? "Xf" : "Xi"],
  mxSlider2D: (i) => [i.isfloatX ? "Xf" : "Xi", i.isfloatY ? "Yf" : "Yi"],
};

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
    if ((!hasKind(catalog, n.class_type) && !editor?.slots[id]) || id === result?.node || n.class_type === POWER_LORAS) continue;
    const primitive = isPrimitive(source, catalog, id);
    // a node that only holds settings for others (a value node, rgthree's KSampler Config): renamed, it is the author's
    // panel. Not a loader: a model file is the Model picker's or a widget of its own, a picture or a clip is an input
    const holdsSettings = primitive || (!MEDIA_LOADERS[n.class_type] && !/^Load(Image|Video|Audio)|^VHS_Load|LoadImage/i.test(n.class_type)
      && Object.values(n.inputs).every((v) => !isRef(v) && !(typeof v === "string" && (MODEL_FILE.test(v) || MEDIA_FILE.test(v)))));
    // a slider (mxToolkit's) keeps an int, a float and which of them it gives: only the one it gives is its value
    const slider = SLIDERS[n.class_type]?.(n.inputs);
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
          const url = own(editor?.downloads, String(c.default).split(/[\\/]/).pop() ?? "");
          missingFiles.push({ node: id, input, classType: n.class_type, file: String(c.default), label: c.label, options: choices, ...(url ? { url } : {}) });
        }
      }
      // the model file is the form's Model picker, not a widget besides
      if (isModel) continue;
      const isResolution = resolution?.node === id && resolution.input === input;
      const isDuration = duration?.node === id && duration.input === input;
      // another model loader's file (a low-noise model beside the high, a refiner): named so
      const other = loaders.find((l) => l.node === id);
      if (Boolean(c.file) && other && folderOfFileInput(n.class_type, input) !== null) c.label = `Model · ${other.label}`;
      // ticked to begin with: what the author put forward (it is their workflow), and what every form has (the size
      // and the length when a node sets them, the mode of an all-in-one node that holds the prompt). Afflatus adds
      // nothing of its own, except, when the author put nothing forward at all, the sampler's steps and cfg
      // (guidance where that is the cfg): see the end
      const promptMode = c.kind === "choice" && input === "mode" && prompt?.target.node === id;
      const byAuthor = onPanel(editor, c.target) >= 0 || names.givenLabel(id, input) !== null || (holdsSettings && names.givenName(id) !== null && c.kind !== "text" && (!slider || slider.includes(input)));
      const suggested = isResolution || isDuration || promptMode || byAuthor;
      const named = isResolution ? { ...c, front: true, label: names.givenLabel(id, input) ?? "Resolution" }
        : isDuration ? { ...c, front: true, label: names.givenLabel(id, input) ?? "Seconds" }
        : c;
      const offers = c.kind === "choice" ? choicesOf(specOf(catalog, n.class_type, input)) ?? undefined : undefined;
      const picks = c.kind === "number" ? picksOf(r, id, input) : undefined;
      if (picks) named.picks = picks;
      candidates.push({ ...tame(named, isDuration ? "seconds" : primitive ? (names.givenName(id) ?? "") : ""), classType: n.class_type, title: names.titleOf(id), suggested, ...(byAuthor ? { byAuthor: true, front: true } : {}), ...(graph[id] ? {} : { off: true }), ...(offers?.length ? { offers } : {}) });
    }
  }
  // the author put nothing forward: the sampler's steps and cfg (guidance where that is the cfg), in a part that runs
  if (!candidates.some((c) => c.byAuthor)) {
    for (const c of candidates) if (c.kind === "number" && !c.off && /^(steps(_total)?|cfg|guidance)$/.test(c.target.input)) c.suggested = true;
  }
  return { candidates, missingFiles, relocated };
}

/** The passes of sampling, the first pass first (the one the fewest nodes feed). */
function samplerPasses(r: Reading): string[] {
  const { graph, ids } = r;
  return ids.filter((id) => isSamplingPass(graph[id]!)).sort((a, z) => r.behind(a).size - r.behind(z).size);
}

// ---- settings of the same name on several nodes are told apart: by the pass of sampling they belong to, else by their node
function tellApart(r: Reading, candidates: Inspection["candidates"], samplerIds: string[]): void {
  const ORDINAL = ["first", "second", "third", "fourth", "fifth"];
  const passOf = (node: string): string | null => {
    // the pass a node works for: the first sampler that is made from it (or is it)
    const at = samplerIds.findIndex((s) => s === node || r.behind(s).has(node));
    const mine = samplerIds.filter((s) => s === node || r.behind(s).has(node)).length;
    // what every pass reads (the text, the model) belongs to none of them
    return samplerIds.length > 1 && at >= 0 && (mine === 1 || samplerIds[at] === node) ? `${ORDINAL[at] ?? `${at + 1}th`} pass` : null;
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
    const whole = r.behind(result.node);
    const isOutput = (id: string) => outputs.some((o) => o.node === id);
    /** What an output is made from, leaving out the nodes that only show or save. */
    const madeFrom = (id: string) => [...r.behind(id)].filter((x) => !isOutput(x)).sort().join(",");
    const count = (id: string, what: RegExp | ((n: Graph[string]) => boolean)) => [...r.behind(id)].filter((x) => (what instanceof RegExp ? what.test(graph[x]!.class_type) : what(graph[x]!))).length;
    /** The node whose picture an output shows. */
    const shows = (id: string): string | undefined => (["images", "image", "video", "audio"].map((k) => graph[id]!.inputs[k]).find(isRef) as Ref | undefined)?.[0];
    const SAMPLER = isSamplingPass;
    const DISPLAY = /Decode|Preview|Save|Compar/i;
    // an output beside the way: it shows a picture of a pass the result goes through (everything behind it but its own decoding is needed by the result)
    const beside = (o: Output) => o.node !== result.node && !whole.has(o.node) && count(o.node, SAMPLER) > 0
      && [...r.behind(o.node)].every((x) => whole.has(x) || isOutput(x) || DISPLAY.test(graph[x]!.class_type));
    const onTheWay = outputs.filter((o) => o.kind === result.kind && (o.node === result.node || whole.has(o.node) || beside(o)));
    // several outputs can show the same picture (a preview, then a save): one stage, the result when it is among them
    const byMake = new Map<string, string>();
    for (const o of onTheWay) if (!byMake.has(madeFrom(o.node)) || o.node === result.node) byMake.set(madeFrom(o.node), o.node);
    byMake.set(madeFrom(result.node), result.node);
    const nodes = [...byMake.values()].sort((a, z) => r.behind(a).size - r.behind(z).size);
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
          if (c.front || !r.behind(second).has(c.target.node) || r.behind(stages[0]!.node).has(c.target.node)) continue;
          if (c.target.input === "scale_by" || c.target.input === "upscale_by") c.label = "Upscale by";
          // after an upscale model whose factor is not known, it is not the whole factor: it must not be named as if it were
          const afterModel = scaleAfterModel(graph, c.target);
          if (afterModel && !(afterModel.factor && size && r.behind(afterModel.upscale).has(size.width.node))) c.label = "Scale after the upscaler";
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
    if (!hasKind(catalog, n.class_type)) continue;
    for (const [input, value] of Object.entries(n.inputs)) {
      if (typeof value !== "string" || MODEL_FILE.test(value)) continue;
      const options = choicesOf(specOf(catalog, n.class_type, input));
      if (!options?.length || options.includes(value) || options.some((o) => MODEL_FILE.test(o))) continue;
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

// ---- nodes of kinds this ComfyUI lacks that only patch what passes through them (a model in, the same model out,
// nothing else read from it): bypassed, with a switch to turn them on once their pack is installed
function bridgeMissing(source: Graph, catalog: NodeCatalog, editor: Wiring | undefined): { bridged: Toggle[]; bridgedModes: Record<string, Mode> } {
  const bridged: Toggle[] = [];
  const bridgedModes: Record<string, Mode> = {};
  if (!editor) return { bridged, bridgedModes };
  const readers = readersOf(source);
  const early = namesOf(source, catalog, editor);
  for (const [id, n] of Object.entries(source)) {
    // (a list of LoRAs is not a patch to pass by: Afflatus's own list takes its place)
    if (hasKind(catalog, n.class_type) || n.class_type === POWER_LORAS || EDITOR_ONLY.test(n.class_type) || editor.modes[id] || editor.toggles.some((t) => t.effects.some((e) => e.nodes.includes(id)))) continue;
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
    const pack = own(editor.packs, n.class_type);
    bridged.push({
      id: `sw_${id}`.replace(/[^a-zA-Z0-9_]/g, "_"), label: early.titleOf(id), default: false, writes: [],
      effects: [{ nodes: [id], activeWhen: true, mode: "bypass" }],
      help: `${n.class_type}${pack ? ` (pack ${pack})` : ""} is not in this ComfyUI. Off, what it would change passes it by; install the pack to turn it on.`,
    });
  }
  return { bridged, bridgedModes };
}

// ---- a group bypasser (rgthree's) in the workflow: the author's frames are the switches, each on or off as saved
function framedSwitches(source: Graph, editor: Wiring | undefined, bridged: Toggle[]): { framed: Toggle[]; bypasser: Graph[string] | undefined } {
  const bypasser = editor ? Object.values(source).find((n) => /^Fast Groups (Bypasser|Muter)/.test(n.class_type)) : undefined;
  const framed: Toggle[] = [];
  if (!editor || !bypasser) return { framed, bypasser };
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
  return { framed, bypasser };
}

// ---- a frame the author saved switched off, with no switch over it, that is a pass of work feeding the output once on
// (a detailer, an upscale, a second sampling left for when it is wanted): a switch, off as saved
function savedOffSwitches(source: Graph, editor: Wiring, bridged: Toggle[], bridgedModes: Record<string, Mode>, result: string): Toggle[] {
  const savedOff: Toggle[] = [];
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
    const behind = ancestors(lit.graph, result);
    if (!nodes.some((id) => behind.has(id)) || [...behind].some((id) => lit.broken.has(id)) || lit.broken.has(result)) return;
    for (const id of nodes) taken.add(id);
    const label = chapterName(fr.title);
    let id = `sw_off_${label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "frame"}`;
    for (let n = 2; savedOff.some((t) => t.id === id); n++) id = `${id.replace(/_\d+$/, "")}_${n}`;
    savedOff.push({ id, label, default: false, writes: [], effects: [{ nodes, activeWhen: true, mode: editor.modes[nodes[0]!] === "mute" ? "mute" : "bypass" }], help: fr.note ?? `The frame "${fr.title}", saved switched off.` });
  });
  return savedOff;
}

// ---- what this ComfyUI lacks: among the nodes the result is made from it blocks a render; elsewhere it is left out
// (rgthree's editor-only helpers are missing from every ComfyUI: no pack to ask for, the build leaves them out)
function missingKinds(r: Reading, result: Output | undefined, reach: Set<string>): { missingNodes: string[]; missingUnneeded: string[]; missingWhenOn: string[] } {
  const { source, graph, ids, catalog } = r;
  const lacks = (g: Graph, id: string) => !hasKind(catalog, g[id]!.class_type) && !EDITOR_ONLY.test(g[id]!.class_type);
  const kinds = (g: Graph, which: string[]) => [...new Set(which.filter((id) => lacks(g, id)).map((id) => g[id]!.class_type))];
  const needed = result ? ids.filter((id) => id === result.node || reach.has(id)) : ids;
  const missingNodes = kinds(graph, needed);
  const missingUnneeded = kinds(graph, ids.filter((id) => !needed.includes(id))).filter((c) => !missingNodes.includes(c));
  const missingWhenOn = kinds(source, Object.keys(source).filter((id) => !graph[id])).filter((c) => !missingNodes.includes(c) && !missingUnneeded.includes(c));
  return { missingNodes, missingUnneeded, missingWhenOn };
}

// ---- the model file: the loader the LoRAs chain after, the first in use, as the form's Model picker
function findModel(r: Reading, passes: string[], loras: { loraPoints: Inspection["loraPoints"]; chosen: Inspection["loraPoints"] }, reach: Set<string>): { model: Bindings["model"]; modelLoader: Inspection["loraPoints"][number] | undefined } {
  const { graph, catalog } = r;
  const { loraPoints, chosen } = loras;
  const behindBase = passes[0] ? r.behind(passes[0]) : new Set<string>();
  const modelLoader = loraPoints.find((p) => !p.power && behindBase.has(p.node)) ?? chosen.find((p) => !p.power && reach.has(p.node)) ?? chosen.find((p) => !p.power) ?? loraPoints.find((p) => !p.power);
  // ComfyUI's folder for the file: known for its own loaders; for a loader of a kind this ComfyUI lacks, the diffusion models' when the input is named as a model
  const folderFor = (cls: string, input: string) => folderOfFileInput(cls, input) ?? (!hasKind(catalog, cls) && /model|unet|ckpt|checkpoint|gguf/i.test(input) ? "diffusion_models" : null);
  const modelFile = modelLoader ? Object.entries(graph[modelLoader.node]?.inputs ?? {}).find(([k, v]) => typeof v === "string" && MODEL_FILE.test(v) && folderFor(graph[modelLoader.node]!.class_type, k)) : undefined;
  const model: Bindings["model"] = modelLoader && modelFile ? { target: { node: modelLoader.node, input: modelFile[0] }, folder: folderFor(graph[modelLoader.node]!.class_type, modelFile[0])! } : undefined;
  return { model, modelLoader };
}

// ---- what runs as is, wherever it is told: hints for the person importing, not rules (an imported workflow runs as it was made)
/** Kinds of node known to run code they are given, or to write a file where they are told. */
const RISKY_KINDS: Array<[RegExp, string]> = [
  [/^Evaluate (Integers|Floats|Strings)$|Python|^Exec(ute)?\b|^Exec(ute)?[A-Z]|RunCommand|Shell/i, "runs code it is given"],
  [/^(easy saveText|Text Save|Save Text File|SaveText\|pysssss)$/i, "writes a file where it is told"],
];
/** A path that leaves ComfyUI's folders: absolute (a drive, a share, a root), or climbing out with "..". */
const OUTSIDE = /^([a-zA-Z]:[\\/]|\\\\\w|\/[\w.~-])|(^|[\\/])\.\.([\\/]|$)/;
function riskHints(source: Graph, catalog: NodeCatalog, editor: Wiring | undefined): string[] {
  const names = namesOf(source, catalog, editor);
  const hints: string[] = [];
  for (const [id, n] of Object.entries(source)) {
    const risky = RISKY_KINDS.find(([re]) => re.test(n.class_type));
    if (risky) hints.push(`"${names.titleOf(id)}" (${n.class_type}) ${risky[1]}: look at what it is set to before a render.`);
    for (const [input, value] of Object.entries(n.inputs)) {
      // a prompt is text, not a place
      if (typeof value !== "string" || value.length > 260 || /[\r\n]/.test(value) || optsOf(specOf(catalog, n.class_type, input)).multiline || !OUTSIDE.test(value)) continue;
      hints.push(`"${names.titleOf(id)}" names a place outside ComfyUI's folders in ${input.replace(/_/g, " ")} (${value}): it reads or writes there when it runs.`);
    }
  }
  return hints;
}

/**
 * @param source the workflow: as exported, or every node of an editor file (see `fromEditor`)
 * @param editor what only the editor's file knows, when the workflow came from one
 * @param notes what the reader of that file could not read with certainty
 */
export function inspect(source: Graph, catalog: NodeCatalog, editor?: Wiring, notes: string[] = []): Inspection {
  // read before anything stands in for a node: what runs code or writes files is said of the node the file has
  const hints = riskHints(source, catalog, editor);
  // a saver of a pack this ComfyUI lacks: ComfyUI's own stands in, in the workflow itself (what is saved is this graph)
  const has = (c: string) => hasKind(catalog, c);
  // values taken out of rgthree's bundles are read where they were put in (the same at run time)
  unbundleContexts(source, editor?.modes);
  const replaced = [
    ...standInSavers(source, has, editor?.slots),
    ...standInLoaders(source, has, editor?.slots),
    ...standInPrimitives(source, has, editor?.slots, (cls, input) => Boolean(choicesOf(specOf(catalog, cls, input)))),
  ];
  const { bridged, bridgedModes } = bridgeMissing(source, catalog, editor);
  const { framed, bypasser } = framedSwitches(source, editor, bridged);
  // what runs with the switches as they were saved: the parts are looked for in there
  const pruned = prune(source, editor, { ...editor?.modes, ...bridgedModes });
  settle(pruned, false);
  const { graph } = pruned;
  // a file name built by a chain of nodes: the name is Afflatus's to give, the chain is not read
  cutFileNameChains(graph, "afflatus");
  const ids = Object.keys(graph);
  const r: Reading = { source, graph, ids, catalog, editor, uses: readersOf(graph), names: namesOf(source, catalog, editor), behind: behindOf(graph) };

  const { outputs, result, reach } = findOutputs(r);
  const savedOff = editor && result && !bypasser ? savedOffSwitches(source, editor, bridged, bridgedModes, result.node) : [];
  const { missingNodes, missingUnneeded, missingWhenOn } = missingKinds(r, result, reach);
  const { texts, prompt, negative } = findTexts(r);
  const seeds = findSeeds(r);
  const { generator, size, resolution } = findSize(r, reach);
  // what could not be read of the frame rate is told only of a video result, the one a length is shown for
  const told: string[] = [];
  const { length, duration } = findLength(r, generator, result, result?.kind === "video" ? told : []);
  const { images, loaded, start, end, pictures } = findImages(r, reach);
  const directorId = ids.find((id) => isDirector(graph, id));
  const { videos, sounds, previous, next, source: sourceVideo, otherVideos, sound, otherSounds, keys: mediaKeys } = findMedia(r, reach);
  const { loraPoints, chosen } = findLoraPoints(r);
  const samplerIds = samplerPasses(r);
  const { model, modelLoader } = findModel(r, samplerIds, { loraPoints, chosen }, reach);
  const { about, toggles: fileToggles } = findAbout(r);
  const toggles = [...fileToggles, ...bridged, ...framed, ...savedOff];
  const { candidates, missingFiles, relocated } = collectCandidates(r, { result, prompt, negative, seeds, size, length, toggles, loaded, mediaKeys, model, loaders: loraPoints.filter((p) => !p.power && p.node !== modelLoader?.node).map((p) => ({ node: p.node, label: p.label || p.title })), resolution, duration });
  tellApart(r, candidates, samplerIds);
  const stages = findStages(r, { result, outputs, candidates, samplerIds, size });
  const missingChoices = findMissingChoices(r);

  const ticked = candidates.filter((c) => c.suggested).map(({ classType: _c, title: _t, suggested: _s, byAuthor: _a, off: _o, offers: _f, ...c }) => c);
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
        // no Load Image, but a Director that takes its frames itself: the form's pictures go into it
        ...(!start && !end && directorId ? { director: { node: directorId } } : {}),
        ...(end ? { endImage: end } : {}),
        pictures,
        ...(previous ? { previousVideo: previous } : {}),
        ...(next ? { nextVideo: next } : {}),
        ...(sourceVideo ? { sourceVideo } : {}),
        otherVideos,
        ...(sound ? { sound } : {}),
        otherSounds,
        loras: chosen.map((p) => ({ node: p.node, output: p.output, label: chosen.length > 1 ? p.label : "", ...(p.power ? { power: true } : {}) })),
        toggles,
        sections: [],
        skip: [],
        result: { node: result.node, kind: result.kind, sound: result.sound },
        controls: ticked,
        stages,
      }
    : null;

  const packs = Object.fromEntries([...missingNodes, ...missingUnneeded, ...missingWhenOn].flatMap((c) => { const p = own(editor?.packs, c); return p ? [[c, p]] : []; }));
  return { nodeCount: Object.keys(source).length, missingNodes, missingUnneeded, replaced, missingWhenOn, missingFiles, missingChoices, relocated, stages, packs, links: editor?.links ?? [], outputs, texts, images, videos, sounds, loraPoints, toggles, suggested, candidates, notes: [...notes, ...told, ...hints], about };
}
