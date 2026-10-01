import {
  isRef, type BuiltGraph, type Family, type Graph, type InputSpec, type LoraValue, type Phase, type Recipe, type SizeValue, type VideoTraits,
} from "@studai/core";
import { slug, type Control, type Target, type Toggle, type WorkflowDef } from "./types";
import { ancestors, modesFor, prune, remove, settle, trim } from "./wiring";

/** The family a workflow recipe belongs to: the model name the user gave it. */
export function familyOf(def: WorkflowDef): Family {
  return {
    id: `workflow-${slug(def.model)}`,
    name: def.model,
    summary: "From your own workflow.",
    promptStyle: "sentences",
    slots: [],
    loraMatch: [],
  };
}

const read = (graph: Graph, t: Target) => graph[t.node]?.inputs[t.input];
const write = (graph: Graph, t: Target, value: unknown) => {
  const node = graph[t.node];
  if (node) node.inputs[t.input] = value;
};

/** What a control is shown under: another input that has to be on (or off) for it to matter. */
type Under = InputSpec["showWhen"];

function controlSpec(c: Control, under: Under): InputSpec {
  const base = { id: c.id, label: c.label, advanced: !c.front, ...(under ? { showWhen: under } : {}) };
  switch (c.kind) {
    case "number": return { ...base, type: "number", min: c.min ?? 0, max: c.max ?? 100, step: c.step ?? 1, default: Number(c.default) };
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
  if (/interpolat|rife|film/i.test(classType)) return "interpolating";
  if (/upscale|superres/i.test(classType)) return "upscaling";
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

const MODEL_FILE = /\.(safetensors|ckpt|gguf|sft|pt|pth|bin|onnx)$/i;
const isLoraEntry = (name: string) => /^lora_\d+$/i.test(name);
/** The LoRAs a "list of LoRAs" node came with, as studai's list has them. */
function listedLoras(node: Graph[string] | undefined): LoraValue[] {
  return Object.entries(node?.inputs ?? {}).flatMap(([name, v]) => {
    const l = v as { on?: unknown; lora?: unknown; strength?: unknown } | null;
    return isLoraEntry(name) && l && typeof l === "object" && l.on === true && typeof l.lora === "string" ? [{ file: l.lora, weight: Number(l.strength ?? 1) }] : [];
  });
}

/**
 * A recipe made from an imported workflow: the form comes from the mapping, and building means
 * filling the user's values into a copy of the workflow.
 */
export function recipeFromWorkflow(def: WorkflowDef): Recipe<Record<string, unknown>> {
  const b = def.bindings;
  const g = def.graph as Graph;
  const inputs: InputSpec[] = [];
  const video = b.result.kind === "video";

  if (b.prompt) inputs.push({ id: "prompt", type: "prompt", label: video ? "What happens" : "Describe the picture", style: "sentences", default: String(read(g, b.prompt) ?? ""), optional: true });
  if (b.negative) inputs.push({ id: "negative", type: "prompt", label: "Avoid", style: "sentences", optional: true, default: String(read(g, b.negative) ?? "") });
  if (b.startImage) inputs.push({ id: "startImage", type: "image", role: "start", label: video ? "Opening picture" : "Picture", optional: !b.startImage.required });
  if (b.endImage) inputs.push({ id: "endImage", type: "image", role: "end", label: "Ending picture", optional: !b.endImage.required });
  // one list for the model, or one per loader when the workflow has several that were told apart (a high and a low model)
  const separate = b.loras.length > 1 && b.loras.every((p) => p.label);
  const loraInput = (i: number) => (separate && i > 0 ? `loras_${i + 1}` : "loras");
  const loraLabel = (label: string) => (!separate ? "LoRAs" : /lora/i.test(label) ? label : `LoRAs · ${label}`);
  // a list starts with the LoRAs the workflow came with, when it keeps them in a list node
  const loraDefault = (i: number) => (b.loras[i]?.power ? listedLoras(g[b.loras[i]!.node]) : []);
  (separate ? b.loras : b.loras.slice(0, 1)).forEach((p, i) => inputs.push({ id: loraInput(i), type: "loras", label: loraLabel(p.label), max: 8, default: loraDefault(i) }));
  if (b.size) {
    const w = Number(read(g, b.size.width));
    const h = Number(read(g, b.size.height));
    inputs.push({
      id: "size", type: "size", label: "Shape", default: "imported", grid: b.size.step, min: b.size.min, max: b.size.max,
      shapes: [
        { id: "imported", label: w > h ? "Wide" : w < h ? "Tall" : "Square", width: w, height: h },
        ...(w !== h ? [{ id: "turned", label: w > h ? "Tall" : "Wide", width: h, height: w }] : []),
      ],
    });
  }
  let seconds = 0;
  if (b.length) {
    seconds = Math.max(1, Math.round((Number(read(g, b.length.target)) / b.length.fps) * 2) / 2);
    inputs.push({ id: "seconds", type: "number", label: "Length", unit: " s", min: b.length.min, max: Math.max(b.length.max, seconds), step: 0.5, default: seconds });
  }

  // a setting of a part that a switch turns on shows only while that switch is on, right under it
  const under = (node: string): { toggle: Toggle; when: Under } | undefined => {
    for (const t of b.toggles) {
      const effect = t.effects.find((e) => e.nodes.includes(node));
      if (effect) return { toggle: t, when: effect.activeWhen ? t.id : { input: t.id, in: [false] } };
    }
    return undefined;
  };
  for (const c of b.controls) if (!under(c.target.node)) inputs.push(controlSpec(c, undefined));
  for (const t of b.toggles) {
    inputs.push({ id: t.id, type: "toggle", label: t.label, default: t.default, advanced: !t.front, ...(t.captions ? { captions: t.captions } : {}) });
    for (const c of b.controls) {
      const u = under(c.target.node);
      if (u?.toggle === t) inputs.push({ ...controlSpec(c, u.when), advanced: !t.front });
    }
  }
  if (b.seeds.length) inputs.push({ id: "seed", type: "seed", label: "Seed" });

  const traits: VideoTraits | undefined = video
    ? {
        startFrame: Boolean(b.startImage),
        endFrame: Boolean(b.endImage),
        midFrames: false,
        // a workflow that opens on a picture can pick up from the last frame of the clip before it
        continues: b.startImage ? "frame" : false,
        endAnchor: false,
        sound: b.result.sound,
        fps: b.length?.fps ?? 16,
        frameGrid: { step: b.length?.step ?? 1, offset: b.length?.offset ?? 0 },
      }
    : undefined;

  /** Seconds → a frame count the model accepts. */
  const framesFor = (s: number) => {
    const { fps, step, offset } = b.length!;
    return Math.max(offset || step, Math.round((s * fps - offset) / step) * step + offset);
  };

  function build(input: Record<string, unknown>, ctx: { seed: number; uploads: Record<string, string>; has?: (classType: string) => boolean }): BuiltGraph {
    // every value goes into the whole workflow first; then the parts that are switched off are taken out
    const whole = structuredClone(g);
    if (b.prompt && typeof input.prompt === "string") write(whole, b.prompt, input.prompt);
    if (b.negative && typeof input.negative === "string") write(whole, b.negative, input.negative);
    for (const s of b.seeds) write(whole, s, ctx.seed);
    if (b.size && input.size) {
      const size = input.size as SizeValue;
      write(whole, b.size.width, size.width);
      write(whole, b.size.height, size.height);
    }
    if (b.length && typeof input.seconds === "number") write(whole, b.length.target, framesFor(input.seconds));
    for (const c of b.controls) if (input[c.id] !== undefined) for (const at of [c.target, ...(c.also ?? [])]) write(whole, at, input[c.id]);
    for (const t of b.toggles) for (const at of t.writes) write(whole, at, typeof input[t.id] === "boolean" ? input[t.id] : t.default);
    const pruned = prune(whole, def.wiring, modesFor(def.wiring, b.toggles, input));
    settle(pruned);
    const { graph } = pruned;
    for (const [id, image] of [["startImage", b.startImage], ["endImage", b.endImage]] as const) {
      if (!image) continue;
      const uploaded = ctx.uploads[id];
      if (uploaded) write(graph, image.target, uploaded);
      // no picture: take the loader out, with every link that read it
      else remove(pruned, image.target.node);
    }
    // what broke on the way and the result does not need is left out
    trim(pruned, b.result.node, ctx.has);
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
        const id = `studai_lora_${p}_${i}`;
        graph[id] = { class_type: "LoraLoaderModelOnly", inputs: { model, lora_name: l.file, strength_model: l.weight } };
        model = [id, 0];
      });
      if (loras.length) for (const { n, k } of readers) n.inputs[k] = model;
    });

    // a workflow can hold more than the result needs (another way of making it, left unused): only what
    // the result is made from counts towards progress and memory
    const used = ancestors(graph, b.result.node);
    const phases: Record<string, Phase> = {};
    const passes: Array<{ node: string; steps: number; after: number }> = [];
    let totalSteps = 0;
    for (const [id, n] of Object.entries(graph)) {
      phases[id] = phaseOf(n.class_type);
      // every node with a step count is a pass of sampling: a sampler, the scheduler a custom sampler reads
      // its steps from, a detailer. The count can be typed in or come from a number node.
      if (!used.has(id) || !("steps" in n.inputs)) continue;
      const steps = numberAt(graph, n.inputs.steps);
      if (steps === null) continue;
      // a sampler that runs only part of the schedule (a high then a low model) reports only the steps it runs
      const start = numberAt(graph, n.inputs.start_at_step) ?? 0;
      const end = Math.min(numberAt(graph, n.inputs.end_at_step) ?? steps, steps);
      totalSteps += Math.max(0, end - start);
      // a pass that needs another one runs after it: it has more behind it
      passes.push({ node: id, steps: Math.max(0, end - start), after: ancestors(graph, id).size });
    }
    passes.sort((a, z) => a.after - z.after);
    return {
      graph,
      phases,
      outputs: [{ node: b.result.node, kind: b.result.kind, role: "result" }],
      totalSteps: Math.max(1, totalSteps),
      passes: passes.map(({ node, steps }) => ({ node, steps })),
      loads: [...used].flatMap((id) => Object.values(graph[id]!.inputs).filter((v): v is string => typeof v === "string" && /\.(safetensors|ckpt|gguf|sft|pt|pth)$/i.test(v))).sort(),
    };
  }

  const everyPicture = { ...(b.startImage ? { startImage: "start.png" } : {}), ...(b.endImage ? { endImage: "end.png" } : {}) };
  /** What the result is made from, for a given form. */
  const usedNodes = (input: Record<string, unknown>) => {
    const built = build(input, { seed: 1, uploads: everyPicture });
    return [...ancestors(built.graph, b.result.node)].map((id) => built.graph[id]!);
  };
  return {
    id: def.id,
    family: familyOf(def).id,
    version: 1,
    title: def.title,
    summary: def.source ? `From ${def.source}.` : "From your own workflow.",
    output: b.result.kind,
    inputs,
    traits,
    // the model files it needs as it was saved: the parts that are switched off are not counted
    files: usedNodes({}).flatMap((n) =>
      Object.entries(n.inputs)
        .filter(([, v]) => typeof v === "string" && MODEL_FILE.test(v))
        .map(([input, v]) => {
          const url = def.wiring?.downloads[(v as string).split(/[\\/]/).pop() ?? ""];
          return { classType: n.class_type, input, file: v as string, ...(url ? { url } : {}) };
        }),
    ),
    nodes: (input) => [...new Set(usedNodes(input).map((n) => n.class_type))],
    build,
    // the workflow as it was saved, with a picture in every slot
    variants: [{ name: "as imported", input: Object.fromEntries(Object.keys(everyPicture).map((id) => [id, "a-picture"])), uploads: everyPicture }],
  };
}
