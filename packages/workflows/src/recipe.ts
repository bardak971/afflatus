import {
  isRef, type BuiltGraph, type Family, type Graph, type InputSpec, type LoraValue, type Phase, type Recipe, type SizeValue, type VideoTraits,
} from "@afflatus/core";
import type { Chapter } from "@afflatus/core";
import { MODEL_FILE, own } from "./catalog";
import { slug } from "./text";
import type { Control, Target, Toggle, WorkflowDef } from "./types";
import { ancestors, cutFileNameChains, modesFor, prune, readersOf, remove, selectorOf, settle, skipsFor, trim } from "./wiring";
import { MEDIA_LOADERS } from "./inspect";
import { offLine, sectionSummary } from "./explain";
import { fillDirector } from "./director";
import { inputNode } from "./suggest";

/** The family a workflow recipe belongs to: the model name the user gave it. */
export function familyOf(def: WorkflowDef): Family {
  return {
    id: `workflow-${slug(def.model)}`,
    name: def.model,
    summary: "From your own workflow.",
    imported: true,
    promptStyle: "sentences",
    slots: [],
    // "Krea2", "Krea 2" and "krea_2" are the same name
    loraMatch: def.model.replace(/[^a-z0-9]/gi, "").length >= 3 ? [def.model.trim().split(/[^a-z0-9]+/i).filter(Boolean).map((w) => w.replace(/([a-z])(\d)/gi, "$1[\\s._-]*$2")).join("[\\s._-]*")] : [],
  };
}

const read = (graph: Graph, t: Target) => graph[t.node]?.inputs[t.input];
const write = (graph: Graph, t: Target, value: unknown) => {
  const node = graph[t.node];
  if (node) node.inputs[t.input] = value;
};

/** How many times an upscale model enlarges, as its file name says ("4x_…", "…_x2plus"). Null when the name does not say. */
export function factorOfUpscaler(file: string): number | null {
  const m = /(?:^|[^a-z0-9])(?:([1248])x|x([1248]))(?![0-9])/i.exec(file.split(/[\\/]/).pop() ?? "");
  return m ? Number(m[1] ?? m[2]) : null;
}

/**
 * A "scale by" that comes after an upscale model. The model enlarges by its own factor first, so 0.3
 * after a 4x model is 1.2 in all, and what one would type as A1111's "Upscale by" (1.5) is 6 times:
 * a second pass over a picture 36 times the size, which no card holds. Returns the upscaling node and
 * the factor of the model the workflow was saved with, when its name says it.
 */
export function scaleAfterModel(g: Graph, t: Target): { upscale: string; factor: number | null } | null {
  const node = g[t.node];
  if (!node || node.class_type !== "ImageScaleBy" || t.input !== "scale_by") return null;
  let from = node.inputs.image;
  // a preview on the way passes the picture on
  for (let hops = 0; hops < 4 && isRef(from); hops++) {
    const id = from[0];
    const n = g[id];
    if (!n) return null;
    if (n.class_type === "ImageUpscaleWithModel") {
      const loader = isRef(n.inputs.upscale_model) ? g[n.inputs.upscale_model[0]] : undefined;
      const file = Object.values(loader?.inputs ?? {}).find((v): v is string => typeof v === "string" && MODEL_FILE.test(v));
      return { upscale: id, factor: file ? factorOfUpscaler(file) : null };
    }
    if (!/^(PreviewImage|SaveImage)$/.test(n.class_type)) return null;
    from = n.inputs.images;
  }
  return null;
}

/** What a control is shown under: another input that has to be on (or off) for it to matter. */
type Under = InputSpec["showWhen"];

function controlSpec(c: Control, under: Under): InputSpec {
  const base = { id: c.id, label: c.label, advanced: !c.front, ...(under ? { showWhen: under } : {}), ...(c.help ? { note: c.help } : {}) };
  switch (c.kind) {
    case "number": {
      // a number that picks one of a switch's inputs: a choice of what it picks (a value saved as the number still reads)
      const picked = c.picks?.find((p) => p.value === Number(c.default));
      if (c.picks && picked) return { ...base, type: "choice", options: c.picks.map((p) => p.label), default: picked.label, renamed: Object.fromEntries(c.picks.map((p) => [String(p.value), p.label])) };
      return { ...base, type: "number", min: c.min ?? 0, max: c.max ?? 100, step: c.step ?? 1, default: Number(c.default) };
    }
    case "toggle": return { ...base, type: "toggle", default: Boolean(c.default), ...(c.captions ? { captions: c.captions } : {}) };
    case "choice": return { ...base, type: "choice", options: c.choices ?? [String(c.default)], default: String(c.default) };
    case "text": return { ...base, type: "prompt", style: "sentences", optional: true, default: String(c.default) };
  }
}

/**
 * The number an input will have, when it can be known without running the graph: typed in, or linked
 * to a node that only passes typed-in values on (a primitive, or a settings node whose outputs are its
 * inputs in the same order).
 */
function numberAt(graph: Graph, value: unknown): number | null {
  if (typeof value === "number") return value;
  if (!isRef(value)) return null;
  const source = graph[value[0]];
  if (!source) return null;
  const inputs = Object.values(source.inputs);
  if (inputs.some(isRef)) return null;
  const v = inputs[value[1]];
  return typeof v === "number" ? v : null;
}

/** What each node is doing, for the progress bar: guessed from what kind of node it is. */
function phaseOf(classType: string): Phase {
  if (/sampler|ksampler/i.test(classType) && !/select|config/i.test(classType)) return "sampling";
  if (/detailer/i.test(classType)) return "detailing";
  if (/decode/i.test(classType)) return "decoding";
  if (/interpolat|rife|film|latentupsampler/i.test(classType)) return "interpolating";
  if (/seedvr2(temporalmerge|postprocess)/i.test(classType)) return "restoring";
  if (/upscale|superres|upsampl/i.test(classType)) return "upscaling";
  if (/removebackground|rmbg|birefnet|matting|segment/i.test(classType)) return "processing";
  if (/combine|save|createvideo/i.test(classType)) return "encoding";
  return "loading";
}

/**
 * A file name as ComfyUI's editor would send it. Save nodes take names like "video/%date:yyyy-MM-dd%/clip"
 * or "%KSampler.seed%": the editor fills those in before it queues, ComfyUI itself does not, and Windows
 * refuses a folder with a colon in its name.
 */
export function fillFileName(text: string, graph: Graph, at: Date = new Date()): string {
  const two = (n: number) => String(n).padStart(2, "0");
  const part: Record<string, string> = {
    yyyy: String(at.getFullYear()), yy: String(at.getFullYear()).slice(-2),
    MM: two(at.getMonth() + 1), M: String(at.getMonth() + 1), dd: two(at.getDate()), d: String(at.getDate()),
    hh: two(at.getHours()), h: String(at.getHours()), mm: two(at.getMinutes()), m: String(at.getMinutes()), ss: two(at.getSeconds()), s: String(at.getSeconds()),
  };
  return text.replace(/%([^%]+)%/g, (whole, inside: string) => {
    if (inside.startsWith("date:")) return inside.slice(5).replace(/yyyy|yy|MM|M|dd|d|hh|h|mm|m|ss|s/g, (t) => part[t] ?? t);
    // "%Node.input%": the value typed into another node, found by its title or its type
    const dot = inside.lastIndexOf(".");
    const [name, input] = [inside.slice(0, dot), inside.slice(dot + 1)];
    const node = dot < 0 ? undefined : Object.values(graph).find((n) => (n as { _meta?: { title?: string } })._meta?.title === name || n.class_type === name);
    const value = node?.inputs[input];
    return typeof value === "string" || typeof value === "number" ? String(value).replace(/[\\/:*?"<>|]/g, "_") : whole;
  });
}

const isLoraEntry = (name: string) => /^lora_\d+$/i.test(name);
/**
 * The LoRAs a "list of LoRAs" node came with, as Afflatus's list has them. One its author switched off stays on the
 * list at 0, so it can be raised again; a LoRA at 0 is not loaded.
 */
function listedLoras(node: Graph[string] | undefined): LoraValue[] {
  return Object.entries(node?.inputs ?? {}).flatMap(([name, v]) => {
    const l = v as { on?: unknown; lora?: unknown; strength?: unknown } | null;
    return isLoraEntry(name) && l && typeof l === "object" && typeof l.lora === "string" && l.lora !== "None" ? [{ file: l.lora, weight: l.on === true ? Number(l.strength ?? 1) : 0 }] : [];
  });
}

/** The form of an imported workflow, and what building from it needs to know of that form. */
interface Form {
  inputs: InputSpec[];
  /** The DaSiWa Director whose own picture slots are the form's start and end images. */
  director: { node: string } | undefined;
  /** One LoRA list per loader (a high and a low model), or one for the model. */
  separate: boolean;
  loraInput(i: number): string;
  loraDefault(i: number): LoraValue[];
  /** A scale after an upscale model, shown as what it comes to in all: its own input id and default. */
  net: Map<string, { id: string; default: number }>;
  /** The places it can stop at, when it shows its picture at several. */
  stages: Array<{ node: string; label: string }>;
  staged: boolean;
  hiresFix: boolean;
}

/** The form's inputs, in their first order: the model, the prompts, what it loads, the LoRAs, size and length, how far it runs, the settings and switches, the seed. */
function formInputs(def: WorkflowDef): Form {
  const b = def.bindings;
  const g = def.graph as Graph;
  const inputs: InputSpec[] = [];
  const video = b.result.kind === "video";

  // the model file, as the form's Model picker: the file the workflow came with to begin with
  if (b.model && g[b.model.target.node]) inputs.push({ id: "model", type: "model", label: "Model", folder: b.model.folder, default: String(read(g, b.model.target) ?? "") });
  // the prompt it was saved with is its author's, for one picture: the form starts empty and shows it as an example
  const savedPrompt = b.prompt ? String(read(g, b.prompt) ?? "") : "";
  if (b.prompt) inputs.push({ id: "prompt", type: "prompt", label: "Prompt", style: "sentences", default: savedPrompt, optional: true, example: true });
  if (b.negative) inputs.push({ id: "negative", type: "prompt", label: "Negative prompt", style: "sentences", optional: true, default: String(read(g, b.negative) ?? "") });
  // of a picture workflow, the picture it works from is its source: such a workflow is then offered wherever a picture can be changed
  if (b.startImage) inputs.push({ id: "startImage", type: "image", role: video ? "start" : "source", label: video ? "Start image" : "Image", optional: !b.startImage.required });
  if (b.endImage) inputs.push({ id: "endImage", type: "image", role: "end", label: "End image", optional: !b.endImage.required });
  // the DaSiWa Director's own picture slots: uploaded where it reads them (ComfyUI's input folder)
  const director = b.director && !b.startImage && g[b.director.node] ? b.director : undefined;
  if (director) {
    inputs.push({ id: "startImage", type: "image", role: "start", label: "Start image", optional: true, folder: "input", note: "the Director's first frame. Given to T2VA, it is made I2VA (FL2VA with an end image too)" });
    inputs.push({ id: "endImage", type: "image", role: "end", label: "End image", optional: true, folder: "input", note: "the Director's last frame (L2VA, or FL2VA with a start image)" });
  }
  for (const p of b.pictures ?? []) if (g[p.target.node]) inputs.push({ id: p.id, type: "image", role: "source", label: p.label, optional: !p.required });
  // a video the workflow's own loader reads: the whole file goes up, the workflow takes the frames it wants of it
  if (b.previousVideo && g[b.previousVideo.target.node]) inputs.push({ id: "previousVideo", type: "clip", role: "previous", label: "Previous clip", note: "the video it carries on from: the workflow reads its last frames", frames: [], fps: b.length?.fps ?? 24, whole: true, optional: !b.previousVideo.required });
  if (b.nextVideo && g[b.nextVideo.target.node]) inputs.push({ id: "nextVideo", type: "clip", role: "next", label: "Next clip", note: "the video it arrives at", frames: [], fps: b.length?.fps ?? 24, whole: true, optional: !b.nextVideo.required });
  if (b.sourceVideo && g[b.sourceVideo.target.node]) inputs.push({ id: "sourceVideo", type: "clip", role: "source", label: "Source video", note: "the video it works on: the whole file goes to its loader", frames: [], fps: b.length?.fps ?? 24, whole: true, optional: !b.sourceVideo.required });
  for (const v of b.otherVideos ?? []) if (g[v.target.node]) inputs.push({ id: v.id, type: "clip", role: "source", label: v.label, frames: [], fps: b.length?.fps ?? 24, whole: true, optional: !v.required });
  if (b.sound && g[b.sound.target.node]) inputs.push({ id: "sound", type: "audio", role: "sound", label: "Sound", note: "a sound of the library, or a video's sound", optional: !b.sound.required });
  for (const s of b.otherSounds ?? []) if (g[s.target.node]) inputs.push({ id: s.id, type: "audio", role: "sound", label: s.label, optional: !s.required });
  // one list for the model, or one per loader when the workflow has several that were told apart (a high and a low model)
  const separate = b.loras.length > 1 && b.loras.every((p) => p.label);
  const loraInput = (i: number) => (separate && i > 0 ? `loras_${i + 1}` : "loras");
  const loraLabel = (label: string) => (!separate ? "LoRAs" : /lora/i.test(label) ? label : `LoRAs · ${label}`);
  // a list starts with the LoRAs the workflow came with, when it keeps them in a list node
  const loraDefault = (i: number) => (b.loras[i]?.power ? listedLoras(g[b.loras[i]!.node]) : []);
  (separate ? b.loras : b.loras.slice(0, 1)).forEach((p, i) => inputs.push({ id: loraInput(i), type: "loras", label: loraLabel(p.label), max: Math.max(8, loraDefault(i).length), default: loraDefault(i) }));
  if (b.size) {
    const w = Number(read(g, b.size.width));
    const h = Number(read(g, b.size.height));
    inputs.push({
      id: "size", type: "size", label: "Size", default: "imported", grid: b.size.step, min: b.size.min, max: b.size.max,
      shapes: [
        { id: "imported", label: w > h ? "Landscape" : w < h ? "Portrait" : "Square", width: w, height: h },
        ...(w !== h ? [{ id: "turned", label: w > h ? "Portrait" : "Landscape", width: h, height: w }] : []),
      ],
    });
  }
  if (b.length) {
    // the roundest number of seconds that gives back the frames it was saved with, so the form left as it came changes
    // nothing (77 at 16 fps is 4.8 s: 5 s would be 81); one shorter than the usual least (21 frames at 24 fps) stays as short
    const frames = Number(read(g, b.length.target));
    const exact = Math.max(0.01, frames / b.length.fps);
    const seconds = [2, 10, 100].map((k) => Math.max(1 / k, Math.round(exact * k) / k)).find((s) => framesFor(b.length!, s) === frames) ?? Math.round(exact * 100) / 100;
    inputs.push({ id: "seconds", type: "number", label: "Length", unit: " s", min: Math.min(b.length.min, seconds), max: Math.max(b.length.max, seconds), step: 0.5, default: seconds });
  }

  // a workflow that shows its picture at several points can stop at one of them: what comes after is not run
  const stages = (b.stages ?? []).filter((s) => g[s.node]);
  const staged = stages.length > 1 && stages.at(-1)!.node === b.result.node;
  const hiresFix = staged && stages.length === 2 && stages[0]!.label === "Hires fix off";
  if (staged) {
    // a base pass, an upscale and a second pass is hires fix: a switch, as in A1111. Anything else is "how much of it runs".
    if (hiresFix) {
      inputs.push({ id: "stage", type: "toggle", label: "Hires fix", note: "the upscale and the second pass. Off: the base pass only, the quick way to try seeds", default: true });
    } else {
      inputs.push({
        id: "stage", type: "choice", label: "Run", note: "the base pass alone is the quick way to try seeds; the full workflow is for the one worth finishing",
        options: stages.map((s) => s.label), default: stages.at(-1)!.label,
      });
    }
  }
  /** The stages a node is part of: a setting of a later step is not shown when the form stops before it. */
  const fromStage = (node: string): Under | undefined => {
    if (!staged) return undefined;
    const first = stages.findIndex((s) => ancestors(g, s.node).has(node));
    if (first <= 0) return undefined;
    // the switch is on, or the form goes at least that far
    return hiresFix ? "stage" : { input: "stage", in: stages.slice(first).map((s) => s.label) };
  };

  // a scale after an upscale model is shown as what it comes to in all: from the base size to the final size.
  // That needs the base size (the form's) and the factor of the model it was saved with (for where it starts).
  const net = new Map<string, { id: string; default: number }>();
  const after = new Map<string, { factor: number | null }>();
  for (const c of b.controls) {
    const found = c.kind === "number" ? scaleAfterModel(g, c.target) : null;
    if (!found) continue;
    after.set(c.id, found);
    if (found.factor && b.size && ancestors(g, found.upscale).has(b.size.width.node)) {
      // an id of its own: a value saved under the old one meant something else
      net.set(c.id, { id: `${c.id}_net`, default: Math.round(found.factor * Number(c.default) * 100) / 100 });
    }
  }
  const autoScaleLabel = (label: string) => label.replace(/^(scale by|upscale by|scale after the upscaler)/i, "").trim();
  const controlInput = (c: Control, when: Under): InputSpec => {
    const spec = controlSpec(c, when);
    const whole = net.get(c.id);
    const tail = autoScaleLabel(c.label);
    const auto = tail !== c.label.trim() || /^(scale by|upscale by|scale after the upscaler)$/i.test(c.label.trim());
    if (whole && spec.type === "number") {
      return {
        ...spec, id: whole.id, label: auto ? `Upscale by${tail ? ` ${tail}` : ""}` : c.label, min: Math.min(1, whole.default), max: 4, step: 0.05, default: whole.default,
        note: `from the base size to the final size, as in A1111 (the workflow's own: ${c.default} after a ${after.get(c.id)!.factor}x upscaler)`,
      };
    }
    if (after.has(c.id) && spec.type === "number") {
      return { ...spec, label: auto ? `Scale after the upscaler${tail ? ` ${tail}` : ""}` : c.label, note: "the upscaler enlarges by its own factor first (often 4): the final size is that times this, so 0.3 after a 4x upscaler is 1.2 in all" };
    }
    return spec;
  };

  // a setting of a part that a switch turns on shows only while that switch is on, right under it
  const under = (node: string): { toggle: Toggle; when: Under } | undefined => {
    for (const t of b.toggles) {
      const effect = t.effects.find((e) => e.nodes.includes(node));
      if (effect) return { toggle: t, when: effect.activeWhen ? t.id : { input: t.id, in: [false] } };
    }
    return undefined;
  };
  // a setting used by only some of what a switch on the form picks shows while one of those is picked
  const picked = whenPicked(def);
  for (const c of b.controls) if (!under(c.target.node)) inputs.push(controlInput(c, fromStage(c.target.node) ?? picked.get(c.id)));
  for (const t of b.toggles) {
    // what the author said of it, then what it does off, worked out from the graph
    const note = [t.help, offLine(g, def.wiring, t)].filter(Boolean).join("\n\n");
    inputs.push({ id: t.id, type: "toggle", label: t.label, default: t.default, advanced: !t.front, ...(t.captions ? { captions: t.captions } : {}), ...(note ? { note } : {}) });
    for (const c of b.controls) {
      const u = under(c.target.node);
      if (u?.toggle === t) inputs.push({ ...controlInput(c, u.when), advanced: !t.front });
    }
  }
  if (b.seeds.length) inputs.push({ id: "seed", type: "seed", label: "Seed" });
  return { inputs, director, separate, loraInput, loraDefault, net, stages, staged, hiresFix };
}

/**
 * The importer's own chapters: each section's settings in its order, folded away by the switch at its head. "advanced"
 * and "prompt" among the sections are not sections: they mark where the folded Advanced chapter (last, without the
 * mark) and the prompt block (first, without it) go. Puts `inputs` in the chapters' order, in place.
 */
function placeSections(def: WorkflowDef, inputs: InputSpec[], net: Form["net"]): Chapter[] {
  const b = def.bindings;
  const g = def.graph as Graph;
  const MARKS: Record<string, string> = { advanced: "Advanced", prompt: "Prompt" };
  const sections = (b.sections ?? []).filter((s) => s.items.length || Object.hasOwn(MARKS, s.id));
  const chapters: Chapter[] = [];
  if (sections.length) {
    const byId = new Map(inputs.map((i) => [i.id, i]));
    const inputOf = (id: string) => byId.get(net.get(id)?.id ?? id) ?? byId.get(id);
    const ordered: InputSpec[] = [];
    const placed = new Set<string>();
    /** Put an input in a chapter, under a switch when given: shown while the switch is on, unless something else already decides it. */
    const place = (id: string, chapter: string, under?: string) => {
      const i = inputOf(id);
      if (!i || placed.has(i.id)) return;
      Object.assign(i, { chapter, advanced: false, ...(under && !i.showWhen ? { showWhen: under } : {}) });
      ordered.push(i);
      placed.add(i.id);
    };
    for (const s of sections) {
      if (Object.hasOwn(MARKS, s.id)) {
        chapters.push({ id: s.id, label: MARKS[s.id]! });
        continue;
      }
      for (const item of s.items) {
        if (typeof item === "string") place(item, s.id);
        else {
          const head = byId.get(item.toggle);
          // a switch whose toggle is gone takes its settings with it: they keep their usual place
          if (!head) continue;
          place(head.id, s.id);
          for (const id of item.items) place(id, s.id, head.id);
        }
      }
      // an empty section is a chapter too: the form leaves it out, the import screen's preview shows where it goes.
      // Its "?": what the author wrote, then what its nodes do
      const nodes = s.items.flatMap((item) => (typeof item === "string" ? [inputNode(b, item)] : [...(b.toggles.find((t) => t.id === item.toggle)?.effects.flatMap((e) => e.nodes) ?? []), ...item.items.map((id) => inputNode(b, id))]));
      const help = [s.help, sectionSummary(g, nodes.filter((n): n is string => Boolean(n)))].filter(Boolean).join("\n\n");
      chapters.push({ id: s.id, label: s.label, ...(help ? { help } : {}) });
    }
    inputs.splice(0, inputs.length, ...ordered, ...inputs.filter((i) => !placed.has(i.id)));
  }
  // no shelves of the form's own for an imported workflow: what the importer did not place goes under Advanced, folded.
  // The prompt stays at the top (the form's spine), its negative under it, and the pictures where they are dropped
  for (const i of inputs) {
    if (i.chapter || i.id === "prompt" || i.id === "negative" || i.type === "model" || i.type === "image" || i.type === "clip" || i.type === "references" || i.type === "audio") continue;
    Object.assign(i, { advanced: true, section: "rare" });
  }
  return chapters;
}

/**
 * For each control used by only some of the values a switch's control on the form can take (a numbered pick, or a
 * yes/no that picks a side), the values it is used under: built for each value (written, pruned, settled), what the
 * result is made from tells. Nothing for a control every value uses, or none.
 */
function whenPicked(def: WorkflowDef): Map<string, NonNullable<InputSpec["showWhen"]>> {
  const b = def.bindings;
  const g = def.graph as Graph;
  const out = new Map<string, NonNullable<InputSpec["showWhen"]>>();
  const readers = readersOf(g);
  const drives = (t: Target) => selectorOf(g[t.node]?.class_type)?.by === t.input
    || Object.keys(g[t.node]?.inputs ?? {}).length === 1 && (readers.get(`${t.node}:0`) ?? []).some((r) => selectorOf(g[r.node]?.class_type)?.by === r.input);
  const drivers = b.controls.filter((c) => (c.picks || c.kind === "toggle") && drives(c.target));
  if (!drivers.length) return out;
  const modes = modesFor(def.wiring, b.toggles, {});
  for (const d of drivers) {
    const values = d.picks ? d.picks.map((p) => ({ form: p.label as unknown, graph: p.value as unknown })) : [{ form: true, graph: true }, { form: false, graph: false }];
    const used = values.map((v) => {
      const whole = structuredClone(g);
      for (const at of [d.target, ...(d.also ?? [])]) write(whole, at, v.graph);
      const pruned = prune(whole, def.wiring, modes);
      settle(pruned);
      return ancestors(pruned.graph, b.result.node);
    });
    for (const c of b.controls) {
      if (c.id === d.id || out.has(c.id)) continue;
      const when = values.filter((_, i) => used[i]!.has(c.target.node)).map((v) => v.form);
      if (!when.length || when.length === values.length) continue;
      out.set(c.id, !d.picks && when.length === 1 ? (when[0] ? d.id : { input: d.id, in: [false] }) : { input: d.id, in: when });
    }
  }
  return out;
}

/** What a form's value is in the graph: the number a named pick stands for, else itself. */
const formValue = (c: Control, value: unknown) => (c.picks && typeof value === "string" ? c.picks.find((p) => p.label === value)?.value ?? Number(c.default) : value);

/** Seconds → a frame count the model accepts. */
const framesFor = (length: NonNullable<WorkflowDef["bindings"]["length"]>, s: number) => {
  const { fps, step, offset } = length;
  return Math.max(offset || step, Math.round((s * fps - offset) / step) * step + offset);
};

/** The workflow ComfyUI is sent for a form's values: every value goes into the whole workflow first, then the parts that are switched off are taken out. */
function buildWorkflow(def: WorkflowDef, form: Form, input: Record<string, unknown>, ctx: { seed: number; uploads: Record<string, string>; has?: (classType: string) => boolean }): BuiltGraph {
  const b = def.bindings;
  const { director, separate, loraInput, loraDefault, net, stages, staged, hiresFix } = form;
  const whole = structuredClone(def.graph as Graph);
  if (b.prompt && typeof input.prompt === "string") write(whole, b.prompt, input.prompt);
  if (b.negative && typeof input.negative === "string") write(whole, b.negative, input.negative);
  if (b.model && typeof input.model === "string" && input.model) write(whole, b.model.target, input.model);
  for (const s of b.seeds) write(whole, s, ctx.seed);
  if (b.size && input.size) {
    const size = input.size as SizeValue;
    write(whole, b.size.width, size.width);
    write(whole, b.size.height, size.height);
  }
  if (b.length && typeof input.seconds === "number") write(whole, b.length.target, framesFor(b.length, input.seconds));
  for (const c of b.controls) if (input[c.id] !== undefined && !net.has(c.id)) for (const at of [c.target, ...(c.also ?? [])]) write(whole, at, formValue(c, input[c.id]));
  // "Upscale by": the node is given the size itself, base size times the factor, whatever the upscale model's own factor
  for (const c of b.controls) {
    const by = net.has(c.id) ? input[net.get(c.id)!.id] : undefined;
    const node = whole[c.target.node];
    if (typeof by !== "number" || !node || !b.size) continue;
    const { scale_by: _by, ...rest } = node.inputs;
    whole[c.target.node] = {
      ...node, class_type: "ImageScale",
      inputs: { ...rest, width: Math.round(Number(read(whole, b.size.width)) * by), height: Math.round(Number(read(whole, b.size.height)) * by), crop: "disabled" },
    };
  }
  for (const t of b.toggles) for (const at of t.writes) write(whole, at, typeof input[t.id] === "boolean" ? input[t.id] : t.default);
  const pruned = prune(whole, def.wiring, modesFor(def.wiring, b.toggles, input), skipsFor(b.toggles, input));
  settle(pruned);
  const { graph } = pruned;
  // previews left out at import, with the branches that only served them: ComfyUI runs every output node it is sent
  for (const sk of b.skip ?? []) for (const id of [sk.node, ...sk.nodes]) if (id !== b.result.node) delete graph[id];
  // a file name built by a chain of nodes: a plain name instead, and the chain goes (its packs are not needed)
  cutFileNameChains(graph, slug(def.title) || "afflatus");
  for (const [id, image] of [["startImage", b.startImage], ["endImage", b.endImage], ...(b.pictures ?? []).map((p) => [p.id, p] as const), ["previousVideo", b.previousVideo], ["nextVideo", b.nextVideo], ["sourceVideo", b.sourceVideo], ...(b.otherVideos ?? []).map((v) => [v.id, v] as const), ["sound", b.sound], ...(b.otherSounds ?? []).map((s) => [s.id, s] as const)] as const) {
    if (!image) continue;
    const uploaded = ctx.uploads[id];
    const node = graph[image.target.node];
    const loader = node ? MEDIA_LOADERS[node.class_type] : undefined;
    const twin = loader?.upload && (ctx.has?.(loader.upload.classType) ?? true) ? loader.upload : undefined;
    if (uploaded && node && twin) {
      // a loader that takes a path on disk: the file Afflatus uploaded is in ComfyUI's temp folder, which is wherever
      // that ComfyUI was told (the portable build, --temp-directory, the desktop app), and a relative "temp/…" is
      // read from ComfyUI's working directory. The pack's upload twin takes "<name> [temp]" and asks ComfyUI where
      // that is, with the same settings: it stands in for the path loader.
      const renamed = twin.renamed ?? {};
      node.class_type = twin.classType;
      node.inputs = Object.fromEntries(Object.entries(node.inputs).map(([k, v]) => [renamed[k] ?? k, k === image.target.input ? uploaded : v]));
    } else if (uploaded) write(graph, image.target, loader?.path ? `temp/${uploaded.replace(/ \[temp\]$/, "")}` : uploaded);
    // no picture, video or sound: take the loader out, with every link that read it
    else remove(pruned, image.target.node);
  }
  if (director && graph[director.node]) fillDirector(graph, director.node, { start: ctx.uploads.startImage, end: ctx.uploads.endImage });
  // where it stops: the result, or an earlier point the form asked for. What comes after that point is taken out.
  const stop = !staged ? b.result.node : hiresFix ? (input.stage === false ? stages[0]!.node : b.result.node) : stages.find((s) => s.label === input.stage)?.node ?? b.result.node;
  if (stop !== b.result.node && graph[stop]) {
    const kept = ancestors(graph, stop);
    for (const id of Object.keys(graph)) if (!kept.has(id)) delete graph[id];
  }
  const end = graph[stop] ? stop : b.result.node;
  // what broke on the way and the result does not need is left out
  trim(pruned, end, ctx.has);
  for (const n of Object.values(graph)) {
    if (typeof n.inputs.filename_prefix === "string") n.inputs.filename_prefix = fillFileName(n.inputs.filename_prefix, graph);
  }

  b.loras.forEach((point, p) => {
    const node = graph[point.node];
    if (!node) return;
    const list = separate ? p : 0;
    const loras = ((input[loraInput(list)] as LoraValue[] | undefined) ?? loraDefault(list)).filter((l) => l.weight !== 0);
    if (point.power) {
      // the node is a list of LoRAs: the user's list replaces the one it came with
      for (const name of Object.keys(node.inputs)) if (isLoraEntry(name)) delete node.inputs[name];
      loras.forEach((l, i) => (node.inputs[`lora_${i + 1}`] = { on: true, lora: l.file, strength: l.weight }));
      return;
    }
    let model: [string, number] = [point.node, point.output];
    // everything that read the loader's model reads the end of the LoRA chain instead
    const readers = Object.values(graph).flatMap((n) => Object.entries(n.inputs).filter(([, v]) => isRef(v) && v[0] === point.node && v[1] === point.output).map(([k]) => ({ n, k })));
    loras.forEach((l, i) => {
      const id = `afflatus_lora_${p}_${i}`;
      graph[id] = { class_type: "LoraLoaderModelOnly", inputs: { model, lora_name: l.file, strength_model: l.weight } };
      model = [id, 0];
    });
    if (loras.length) for (const { n, k } of readers) n.inputs[k] = model;
  });

  // a workflow can hold more than the result needs (another way of making it, left unused): only what
  // the result is made from counts towards progress and memory
  const used = ancestors(graph, end);
  const phases: Record<string, Phase> = {};
  const passes: Array<{ node: string; steps: number; after: number }> = [];
  let totalSteps = 0;
  for (const [id, n] of Object.entries(graph)) {
    phases[id] = phaseOf(n.class_type);
    // for progress, every node with a step count is a pass of sampling (unlike isSamplingPass, which tells the passes
    // apart for naming): a sampler, the scheduler a custom sampler reads its steps from, a detailer. The count can be
    // typed in or come from a number node.
    if (!used.has(id) || !("steps" in n.inputs)) continue;
    const steps = numberAt(graph, n.inputs.steps);
    if (steps === null) continue;
    // a sampler that runs only part of the schedule (a high then a low model) reports only the steps it runs
    const start = numberAt(graph, n.inputs.start_at_step) ?? 0;
    const stopAt = Math.min(numberAt(graph, n.inputs.end_at_step) ?? steps, steps);
    totalSteps += Math.max(0, stopAt - start);
    // a pass that needs another one runs after it: it has more behind it
    passes.push({ node: id, steps: Math.max(0, stopAt - start), after: ancestors(graph, id).size });
  }
  passes.sort((a, z) => a.after - z.after);
  return {
    graph,
    phases,
    outputs: [{ node: end, kind: b.result.kind, role: "result" }],
    totalSteps: Math.max(1, totalSteps),
    passes: passes.map(({ node, steps }) => ({ node, steps })),
    loads: [...used].flatMap((id) => Object.values(graph[id]!.inputs).filter((v): v is string => typeof v === "string" && MODEL_FILE.test(v))).sort(),
  };
}

/** The model files a workflow needs, from the nodes its result is made from: with where its author says each can be had. */
function filesOf(def: WorkflowDef, nodes: Graph[string][]): NonNullable<Recipe["files"]> {
  return nodes.flatMap((n) =>
    Object.entries(n.inputs)
      .filter(([, v]) => typeof v === "string" && MODEL_FILE.test(v))
      .map(([input, v]) => {
        const url = own(def.wiring?.downloads, (v as string).split(/[\\/]/).pop() ?? "");
        return { classType: n.class_type, input, file: v as string, ...(url ? { url } : {}) };
      }),
  );
}

/**
 * A recipe made from an imported workflow: the form comes from the mapping, and building means
 * filling the user's values into a copy of the workflow. Nothing is built until it is asked for: the
 * files it needs are worked out the first time they are read.
 */
export function recipeFromWorkflow(def: WorkflowDef): Recipe<Record<string, unknown>> {
  const b = def.bindings;
  const video = b.result.kind === "video";
  const form = formInputs(def);
  const { inputs, director } = form;
  const chapters = placeSections(def, inputs, form.net);

  const traits: VideoTraits | undefined = video
    ? {
        startFrame: Boolean(b.startImage || director),
        endFrame: Boolean(b.endImage || director),
        midFrames: false,
        // a workflow that reads the clip before carries its motion on; one that opens on a picture picks up from its last frame
        continues: b.previousVideo ? "clip" : b.startImage || director ? "frame" : false,
        endAnchor: false,
        sound: b.result.sound,
        fps: b.length?.fps ?? 16,
        frameGrid: { step: b.length?.step ?? 1, offset: b.length?.offset ?? 0 },
      }
    : undefined;

  const build = (input: Record<string, unknown>, ctx: { seed: number; uploads: Record<string, string>; has?: (classType: string) => boolean }) => buildWorkflow(def, form, input, ctx);
  const everyPicture: Record<string, string> = {
    ...(b.startImage || director ? { startImage: "start.png" } : {}), ...(b.endImage || director ? { endImage: "end.png" } : {}),
    ...Object.fromEntries((b.pictures ?? []).map((p) => [p.id, `${p.id}.png`])),
    ...(b.previousVideo ? { previousVideo: "previous.mp4" } : {}), ...(b.nextVideo ? { nextVideo: "next.mp4" } : {}), ...(b.sound ? { sound: "sound.wav" } : {}),
    ...Object.fromEntries((b.otherSounds ?? []).map((s) => [s.id, `${s.id}.wav`])),
    ...(b.sourceVideo ? { sourceVideo: "source.mp4" } : {}), ...Object.fromEntries((b.otherVideos ?? []).map((v) => [v.id, `${v.id}.mp4`])),
  };
  /** A value of the right shape for each of them, for the dry run. */
  const dryValue = (id: string): unknown => (id.endsWith("Video") || id.startsWith("vid_") ? { asset: "a-video" } : "a-picture");
  /** What the result is made from, for a given form. */
  const usedNodes = (input: Record<string, unknown>) => {
    const built = build(input, { seed: 1, uploads: everyPicture });
    return [...ancestors(built.graph, built.outputs[0]!.node)].map((id) => built.graph[id]!);
  };
  let files: Recipe["files"];
  return {
    id: def.id,
    family: familyOf(def).id,
    imported: true,
    version: 1,
    title: def.title,
    summary: def.source ? `From ${def.source}.` : "From your own workflow.",
    output: b.result.kind,
    inputs,
    ...(chapters.length ? { chapters } : {}),
    traits,
    // the model files it needs as it was saved: the parts that are switched off are not counted
    get files() {
      return (files ??= filesOf(def, usedNodes({})));
    },
    nodes: (input) => [...new Set(usedNodes(input).map((n) => n.class_type))],
    build,
    // the workflow as it was saved, with a picture in every slot
    variants: [{ name: "as imported", input: Object.fromEntries(Object.keys(everyPicture).map((id) => [id, dryValue(id)])), uploads: everyPicture }],
  };
}
