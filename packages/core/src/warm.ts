import { isRef, type BuiltGraph, type Graph } from "./graph";
import { folderOfFileInput } from "./models";

/** The nodes a set of nodes is made from, themselves included. */
export function upstream(graph: Graph, from: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const todo = [...from];
  while (todo.length) {
    const id = todo.pop()!;
    if (seen.has(id) || !graph[id]) continue;
    seen.add(id);
    for (const v of Object.values(graph[id]!.inputs)) if (isRef(v)) todo.push(v[0]);
  }
  return seen;
}

const MODEL_FILE = /\.(safetensors|ckpt|gguf|sft|pt|pth)$/i;
const BASE_FOLDERS = new Set(["checkpoints", "diffusion_models", "text_encoders", "vae"]);
/** A model file as it is compared: without its folder, whatever the case. */
export const modelFileName = (value: string): string => value.replace(/\\/g, "/").split("/").pop()!.toLowerCase();

/**
 * The base models a render loads: its checkpoint or diffusion model, its text encoders, its VAE. They
 * are the large ones, and the ones ComfyUI's memory is cleared for when they change. A LoRA, an
 * upscaler, a detector or a ControlNet is not one: ComfyUI swaps those without reading the base model
 * again. Only what the results are made from counts. Names without folder, in lower case, sorted.
 */
export function baseModels(built: Pick<BuiltGraph, "graph" | "outputs">): string[] {
  const used = upstream(built.graph, built.outputs.map((o) => o.node));
  const found = new Set<string>();
  for (const id of used) {
    const node = built.graph[id]!;
    for (const [input, value] of Object.entries(node.inputs)) {
      if (typeof value !== "string" || !MODEL_FILE.test(value)) continue;
      const folder = folderOfFileInput(node.class_type, input);
      // loaders of node packs name their file input "model" or "model_name": the node's own name tells what it loads
      const base = folder
        ? BASE_FOLDERS.has(folder)
        : /^(model|model_name|model_path|gguf_name)$/.test(input)
          && /(unet|diffusion|checkpoint|ckpt|vae|text.?encoder|t5|model.?loader)/i.test(node.class_type)
          && !/(upscal|lora|vision|detect|sam|control|interpol|rife|segm)/i.test(node.class_type);
      if (base) found.add(modelFileName(value));
    }
  }
  return [...found].sort();
}

/**
 * The model a render is made with, as a person would name it: its checkpoint or diffusion model (both,
 * when it has two, as a video model in a high and a low part), without folder or extension. Null when
 * it has none of its own.
 */
export function mainModel(built: Pick<BuiltGraph, "graph" | "outputs">): string | null {
  const used = upstream(built.graph, built.outputs.map((o) => o.node));
  const names = new Set<string>();
  for (const id of used) {
    const node = built.graph[id]!;
    for (const [input, value] of Object.entries(node.inputs)) {
      if (typeof value !== "string" || !MODEL_FILE.test(value)) continue;
      const folder = folderOfFileInput(node.class_type, input);
      const main = folder
        ? folder === "checkpoints" || folder === "diffusion_models"
        : /^(model|model_name|model_path|gguf_name)$/.test(input)
          && /(unet|diffusion|checkpoint|ckpt|model.?loader)/i.test(node.class_type)
          && !/(upscal|lora|vision|detect|sam|control|interpol|rife|segm|vae|text.?encoder|t5|clip)/i.test(node.class_type);
      if (main) names.add(value.replace(/\\/g, "/").split("/").pop()!.replace(/\.[a-z0-9]+$/i, ""));
    }
  }
  return names.size ? [...names].sort().join(" + ") : null;
}

/** The node a warm-up ends on. It takes anything, shows it as text, and is an output: ComfyUI runs what feeds it. */
export const WARM_SINK = "PreviewAny";

/**
 * The graph that loads a render's models without making the render: the same graph up to its first
 * sampling pass, with that pass cut to one step, and nothing after it (no decoding, no upscaling, no
 * file saved). One step at the real size has ComfyUI read the models and place them in memory exactly
 * as the render will need them, so the render that follows starts sampling at once.
 *
 * A graph without a sampling pass (an upscale alone) keeps its loaders only. Null when there is
 * nothing to load.
 */
export function warmGraph(built: BuiltGraph): { graph: Graph; phases: BuiltGraph["phases"]; pass: { node: string; steps: number } | null } | null {
  const used = upstream(built.graph, built.outputs.map((o) => o.node));
  // The first pass is where sampling starts. A pass can be named by the scheduler that holds its step
  // count: the node that samples is then the nearest one that reads it and takes a latent.
  const named = built.passes?.[0]?.node;
  const samples = (id: string) => ["latent_image", "latent", "samples"].some((k) => isRef(built.graph[id]?.inputs[k]));
  const first = named && built.graph[named] && !samples(named)
    ? [...used]
      .filter((id) => samples(id) && upstream(built.graph, [id]).has(named))
      .sort((a, z) => upstream(built.graph, [a]).size - upstream(built.graph, [z]).size)[0] ?? named
    : named;
  const ends = first && built.graph[first]
    ? [first]
    : [...used].filter((id) => Object.values(built.graph[id]!.inputs).some((v) => typeof v === "string" && MODEL_FILE.test(v)));
  if (!ends.length) return null;

  const keep = upstream(built.graph, ends);
  const graph: Graph = {};
  for (const id of keep) graph[id] = { class_type: built.graph[id]!.class_type, inputs: { ...built.graph[id]!.inputs } };

  // one step: where the pass has its count, or where the scheduler it reads from has it, typed in or
  // held by a number node; a schedule written out by hand ("1.0, 0.99, …") keeps its first step
  let cut = false;
  if (first) {
    for (const id of keep) {
      const node = graph[id]!;
      const written = typeof node.inputs.sigmas === "string" ? node.inputs.sigmas.split(",").map((x) => x.trim()).filter(Boolean) : null;
      if (written && written.length >= 2 && written.every((x) => Number.isFinite(Number(x)))) {
        node.inputs.sigmas = written.slice(0, 2).join(", ");
        cut = true;
      }
      if (!("steps" in node.inputs)) continue;
      const steps = node.inputs.steps;
      if (typeof steps === "number") {
        node.inputs.steps = 1;
        cut = true;
      } else if (isRef(steps)) {
        const source = graph[steps[0]];
        const held = source && Object.entries(source.inputs).filter(([, v]) => typeof v === "number");
        if (source && held?.length === 1) {
          source.inputs[held[0]![0]] = 1;
          cut = true;
        }
      }
      // a pass that ran only a part of the schedule runs its one step from the start
      if (typeof node.inputs.start_at_step === "number") node.inputs.start_at_step = 0;
      if (typeof node.inputs.end_at_step === "number") node.inputs.end_at_step = 10000;
    }
  }
  // steps that could not be cut (sigmas written by hand): the pass itself is left out, its loaders stay
  const sinks = first && !cut
    ? [...keep].filter((id) => id !== first && Object.values(graph[id]!.inputs).some((v) => typeof v === "string" && MODEL_FILE.test(v)))
    : ends;
  if (first && !cut) {
    const kept = upstream(graph, sinks);
    for (const id of Object.keys(graph)) if (!kept.has(id)) delete graph[id];
  }
  if (!sinks.length) return null;

  let next = Math.max(0, ...Object.keys(built.graph).map((id) => Number(id) || 0));
  const phases: BuiltGraph["phases"] = {};
  for (const id of Object.keys(graph)) if (built.phases[id]) phases[id] = built.phases[id]!;
  for (const id of sinks) graph[`warm${++next}`] = { class_type: WARM_SINK, inputs: { source: [id, 0] } };
  return { graph, phases, pass: first && cut ? { node: first, steps: 1 } : null };
}
