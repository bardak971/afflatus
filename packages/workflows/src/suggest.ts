import { isRef, type Graph } from "@afflatus/core";
import { slug, type Section, type Toggle, type Wiring } from "./types";
import { ancestors, prune } from "./wiring";

/**
 * A first arrangement of an imported workflow's form, from what its author already said: the frames
 * drawn around nodes become sections, in the order they are laid out; a frame that is a pass of work
 * the output can do without (a second sampling, an upscale, a detailer) becomes a switch, with its
 * settings under it; whatever is placed nowhere stays under Advanced. It only says what the file
 * says: a workflow with no frames gives nothing, and the person edits the rest.
 */

/** Something the form holds that can be placed: its input id, and the node it belongs to. */
export interface Placeable {
  id: string;
  node?: string;
}

export interface Suggestion {
  sections: Section[];
  /** The switches made, one per frame the output can do without. */
  toggles: Toggle[];
  /** What was decided and why, a line per frame, for the person. */
  why: string[];
}

/** A node that does work worth switching off, besides a sampler (which has a step count): upscaling, detailing, interpolating. */
const WORK = /Detailer|Upscale|SeedVR|Interpolat|RIFE|FILM|Refin|Enhance|Restor/i;
/** A frame that is a note rather than a part of the workflow. */
const NOTE = /https?:\/\/|discord|patreon|civitai|^\W*$/i;

/** The sampling passes: every node with a step count, the base pass being the one with the fewest nodes behind it. */
function samplers(graph: Graph): { all: Set<string>; base: string | null } {
  const all = new Set(Object.entries(graph).filter(([, n]) => "steps" in n.inputs).map(([id]) => id));
  let base: string | null = null;
  let least = Infinity;
  for (const id of all) {
    const behind = ancestors(graph, id).size;
    if (behind < least) {
      least = behind;
      base = id;
    }
  }
  return { all, base };
}

/** Whether the output still gets something when this part is skipped as one: what fed it flows through to what read it. */
function survivesBypass(graph: Graph, wiring: Wiring | undefined, nodes: string[], result: string): boolean {
  const modes = Object.fromEntries(nodes.map((id) => [id, "skip" as const]));
  const pruned = prune(graph, wiring, { ...wiring?.modes, ...modes }, [nodes]);
  const out = pruned.graph[result];
  if (!out || pruned.broken.has(result)) return false;
  // nothing the output is made from lost a link (a sampler whose sampler choice was bypassed away is broken, the output with it)
  if ([...ancestors(pruned.graph, result)].some((id) => pruned.broken.has(id))) return false;
  return Object.values(out.inputs).every((v) => !isRef(v) || Boolean(pruned.graph[v[0]]));
}

/** A frame's title as a chapter's name: without the author's numbering and the instructions in brackets ("6  UPSCALE  hires pass 1.5x  (switch off in the toggles box)" → "UPSCALE hires pass 1.5x"). */
export const chapterName = (title: string) => {
  const bare = title.replace(/^\s*\d+[\s.:)-]+/, "").replace(/\s*[([][^()[\]]*[)\]]\s*$/, "");
  // "UPSCALE  hires pass 1.5x": a title written as segments set apart by two spaces is named by its first
  const first = bare.split(/\s{2,}/)[0] ?? bare;
  return first.trim() || bare.replace(/\s+/g, " ").trim() || title.trim();
};

export function suggestSections(graph: Graph, wiring: Wiring | undefined, result: string, placeables: Placeable[], frames: Wiring["frames"] = wiring?.frames ?? [], existing: Toggle[] = []): Suggestion {
  const sections: Section[] = [];
  const toggles: Toggle[] = [];
  const why: string[] = [];
  const { base } = samplers(graph);
  const ids = new Set<string>();
  const uniqueId = (prefix: string, title: string) => {
    let id = `${prefix}_${slug(title) || "frame"}`;
    for (let n = 2; ids.has(id); n++) id = `${prefix}_${slug(title) || "frame"}_${n}`;
    ids.add(id);
    return id;
  };
  // the author's frames in reading order: left to right, then top to bottom; those with no place known keep their file order
  const ordered = frames
    .map((f, i) => ({ ...f, i, nodes: f.nodes.filter((id) => graph[id]) }))
    .filter((f) => f.nodes.length && !NOTE.test(f.title))
    .sort((a, b) => (a.box && b.box ? a.box[0] - b.box[0] || a.box[1] - b.box[1] : a.i - b.i));
  const placedIds = new Set<string>();
  for (const f of ordered) {
    const inFrame = new Set(f.nodes);
    const items = placeables.filter((p) => p.node && inFrame.has(p.node) && !placedIds.has(p.id)).map((p) => p.id);
    const holdsOutput = inFrame.has(result);
    const work = f.nodes.some((id) => "steps" in graph[id]!.inputs || WORK.test(graph[id]!.class_type));
    const isBase = base !== null && inFrame.has(base);
    const switchable = work && !holdsOutput && !isBase && survivesBypass(graph, wiring, f.nodes, result);
    if (!items.length && !switchable) {
      why.push(`"${f.title}": nothing of the form in it${holdsOutput ? " (it holds the output)" : ""}: left alone.`);
      continue;
    }
    for (const id of items) placedIds.add(id);
    const label = chapterName(f.title);
    const sectionId = uniqueId("sec", label);
    // a switch the file already has over these nodes (the author's own bypass group) is used rather than a new one
    const own = existing.find((t) => !t.made && t.effects.some((e) => f.nodes.every((id) => e.nodes.includes(id))));
    if (own) {
      sections.push({ id: sectionId, label, items: [{ toggle: own.id, items: items.filter((id) => id !== own.id) }] });
      why.push(`"${label}": the author's own switch "${own.label}" covers it: placed, with ${items.length} setting${items.length === 1 ? "" : "s"} under it.`);
    } else if (switchable) {
      const toggle: Toggle = {
        id: uniqueId("sw_made", label), label, default: true,
        effects: [{ nodes: f.nodes, activeWhen: true, mode: "skip" }], writes: [], front: true, made: true,
      };
      toggles.push(toggle);
      sections.push({ id: sectionId, label, items: [{ toggle: toggle.id, items }] });
      why.push(`"${label}": a pass the output can do without: a switch, on, with ${items.length} setting${items.length === 1 ? "" : "s"} under it.`);
    } else {
      sections.push({ id: sectionId, label, items });
      why.push(`"${label}": a section with ${items.length} setting${items.length === 1 ? "" : "s"}${isBase ? " (the base pass: never a switch)" : holdsOutput ? " (it holds the output)" : work ? " (bypassing it would cut the output)" : ""}.`);
    }
  }
  if (!ordered.length) why.push("This workflow has no frames to go by: nothing to suggest. Arrange it by hand.");
  const left = placeables.filter((p) => !placedIds.has(p.id)).length;
  if (ordered.length && left) why.push(`${left} setting${left === 1 ? "" : "s"} in no frame stay under Advanced.`);
  return { sections, toggles, why };
}
