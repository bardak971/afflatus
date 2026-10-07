import { isRef, type Graph } from "@afflatus/core";
import { PASS_WORK, titleOf } from "./suggest";
import type { Toggle, Wiring } from "./types";
import { ancestors, modesFor, prune, skipsFor } from "./wiring";

/**
 * Plain words for an imported workflow's form, worked out from its graph by fixed rules (no model is asked):
 * what a switch does when it is off, and what a section's nodes do. They go in the "?" beside the setting.
 */

const list = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/**
 * What happens with a switch off, as the build does it: what is skipped, and what the nodes after it get instead
 * ("Off: Hires fix is skipped; Save Image takes VAE Decode's output instead."). Null when the switch turns nothing off.
 */
export function offLine(graph: Graph, wiring: Wiring | undefined, toggle: Toggle): string | null {
  const gone = new Set(toggle.effects.filter((e) => e.activeWhen).flatMap((e) => e.nodes).filter((id) => graph[id]));
  if (!gone.size) return null;
  const values = { [toggle.id]: false };
  const off = prune(graph, wiring, modesFor(wiring, [toggle], values), skipsFor([toggle], values)).graph;
  // the work in it by name (a sampler, an upscale, a detailer); else its nodes
  const work = [...gone].filter((id) => "steps" in graph[id]!.inputs || PASS_WORK.test(graph[id]!.class_type));
  const named = [...new Set((work.length ? work : [...gone]).map((id) => titleOf(graph, id)).filter(Boolean))];
  const shown = named.length > 3 ? [...named.slice(0, 3), `${named.length - 3} more`] : named;
  // what read from it, and what it reads now: a preview last
  const after: Array<{ weight: number; text: string }> = [];
  for (const [id, n] of Object.entries(graph)) {
    if (gone.has(id)) continue;
    for (const [input, v] of Object.entries(n.inputs)) {
      if (!isRef(v) || !gone.has(v[0])) continue;
      const now = off[id]?.inputs[input];
      const text = isRef(now) ? `${titleOf(graph, id)} takes ${titleOf(graph, now[0])}'s output instead` : `${titleOf(graph, id)} goes without its ${input}`;
      after.push({ weight: /Preview/i.test(n.class_type) ? 0 : 1, text });
    }
  }
  const told = [...new Set(after.sort((a, b) => b.weight - a.weight).map((a) => a.text))].slice(0, 2);
  return `Off: ${list(shown)} ${shown.length > 1 ? "are" : "is"} skipped${told.length ? `; ${told.join("; ")}` : ""}.`;
}

/** What nodes do, in plain words, by their kind: the first that fits. */
const DOES: Array<[RegExp, string]> = [
  [/Lora/i, "applies LoRAs"],
  [/CheckpointLoader|UNETLoader|UnetLoader|DiffusionModelLoader|ModelLoader|GGUF/i, "loads the model"],
  [/CLIPLoader|DualCLIP|TripleCLIP|TextEncoderLoader|T5.*Loader/i, "loads the text encoder"],
  [/VAELoader/i, "loads the VAE"],
  [/TextEncode|PromptEncode/i, "encodes the prompt"],
  [/^LoadImage|ImageLoader/i, "loads a picture"],
  [/LoadVideo|VHS_Load/i, "loads a video"],
  [/LoadAudio/i, "loads a sound"],
  [/ControlNet/i, "guides the picture with a control map"],
  [/Detailer/i, "redraws details (detailer)"],
  [/Upscale|SeedVR/i, "upscales"],
  [/Interpolat|RIFE|FILM/i, "adds frames between frames"],
  [/Sampler|KSampler/i, "samples"],
  [/Empty.*Latent|EmptySD3|EmptyEmbeds/i, "sets the size"],
  [/VAEDecode/i, "decodes to pixels"],
  [/VAEEncode/i, "encodes the picture to latent"],
  [/Save|Combine/i, "saves the result"],
  [/Preview/i, "shows a preview"],
];

/**
 * What a section's nodes do, in the order they run ("What it does: loads the model, applies LoRAs, samples.").
 * Null when none of them is of a known kind.
 */
export function sectionSummary(graph: Graph, nodes: string[]): string | null {
  const known = [...new Set(nodes)].filter((id) => graph[id]).sort((a, b) => ancestors(graph, a).size - ancestors(graph, b).size);
  const said: string[] = [];
  for (const id of known) {
    const what = DOES.find(([re]) => re.test(graph[id]!.class_type))?.[1];
    if (what && !said.includes(what)) said.push(what);
  }
  return said.length ? `What it does: ${said.join(", ")}.` : null;
}
