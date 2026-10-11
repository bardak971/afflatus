import { isRef, plural, type Graph, type InputSpec } from "@afflatus/core";
import { isSamplingPass } from "./catalog";
import { slug } from "./text";
import type { Bindings, Section, SwitchGroup, Toggle, Wiring } from "./types";
import { ancestors, prune, readersOf } from "./wiring";

/**
 * A first arrangement of an imported workflow's form, from what its author already said: the frames
 * drawn around nodes become sections, in the order they are laid out; a frame that is a pass of work
 * the output can do without (a second sampling, an upscale, a detailer) becomes a switch, with its
 * settings under it, on or off as the author left it; a frame drawn inside another is a part of that
 * one's section. A workflow without frames is arranged by what its nodes do: Model, Inputs, Output,
 * Sampling, then a section per pass. Whatever is placed nowhere stays under Advanced; the person edits the rest.
 */

/** Something the form holds that can be placed: its input id, and the node it belongs to. */
export interface Placeable {
  id: string;
  node?: string;
}

/**
 * What of a form can be placed in its sections, each with the node it belongs to (for placing it in the frame that
 * holds the node): every input but the prompt and its negative (they lead the form) and the switches the sections made themselves.
 */
export function placeablesFor(b: Bindings, inputs: InputSpec[]): Placeable[] {
  // the prompt and its negative lead the form whatever the sections say
  return inputs
    .filter((i) => !(i.type === "prompt" && (i.id === "prompt" || i.id === "negative")) && !b.toggles.some((t) => t.made && t.id === i.id))
    .map((i) => ({ id: i.id, node: inputNode(b, i.id) }));
}

/** The node an input of an imported workflow's form belongs to. */
export function inputNode(b: Bindings, id: string): string | undefined {
  const c = b.controls.find((x) => x.id === id || `${x.id}_net` === id);
  if (c) return c.target.node;
  const t = b.toggles.find((x) => x.id === id);
  if (t) return t.effects[0]?.nodes[0];
  const fixed: Record<string, string | undefined> = {
    size: b.size?.width.node, seed: b.seeds[0]?.node, negative: b.negative?.node, seconds: b.length?.target.node,
    startImage: b.startImage?.target.node, endImage: b.endImage?.target.node, model: b.model?.target.node,
    previousVideo: b.previousVideo?.target.node, nextVideo: b.nextVideo?.target.node, sourceVideo: b.sourceVideo?.target.node, sound: b.sound?.target.node,
  };
  if (Object.hasOwn(fixed, id)) return fixed[id];
  const lora = /^loras(?:_(\d+))?$/.exec(id);
  if (lora) return b.loras[lora[1] ? Number(lora[1]) - 1 : 0]?.node;
  return [...(b.pictures ?? []), ...(b.otherSounds ?? []), ...(b.otherVideos ?? [])].find((p) => p.id === id)?.target.node;
}

export interface Suggestion {
  sections: Section[];
  /** The switches made, one per frame (or pass) the output can do without. */
  toggles: Toggle[];
  /** What was decided and why, a line per frame, for the person. */
  why: string[];
}

type Frame = Wiring["frames"][number];

/** A node that does work worth switching off, besides a sampler (which has a step count): upscaling, detailing, interpolating. */
export const PASS_WORK = /Detailer|Upscale|SeedVR|Interpolat|RIFE|FILM|Refin|Enhance|Restor/i;
/** A frame that is a note rather than a part of the workflow. */
const NOTE = /https?:\/\/|discord|patreon|civitai|buy me a coffee|ko-?fi|\b(workflow|made|created) by\b|^\W*credits?\b/i;
/** What an author writes in a frame's title of a part that is usually left off. */
const OFF_WORDS = /\b(only (use )?(if|when)|usually not|not (usually )?(needed|necessary|required)|optional|if needed|experimental|disabled|unused|off by default)\b/i;
/** More settings than this in a section and it is split by node. */
const LONG = 12;
/** A title is read this far: what is longer is not a name. */
const TITLE = 200;

/** The nodes of a frame, with those of the frames drawn inside it (a file that says a frame is inside itself is read once round). */
export function frameNodes(frames: Frame[], i: number, seen = new Set<number>()): string[] {
  if (seen.has(i)) return [];
  seen.add(i);
  const out = [...(frames[i]?.nodes ?? [])];
  frames.forEach((f, j) => {
    if (f.parent === i && j !== i) out.push(...frameNodes(frames, j, seen));
  });
  return out;
}

/** The base pass: of the sampling passes (else of the nodes with a step count), the one with the fewest nodes behind it. */
function basePass(graph: Graph): string | null {
  const steps = Object.entries(graph).filter(([, n]) => "steps" in n.inputs).map(([id]) => id);
  const passes = steps.filter((id) => isSamplingPass(graph[id]!));
  let base: string | null = null;
  let least = Infinity;
  for (const id of passes.length ? passes : steps) {
    const behind = ancestors(graph, id).size;
    if (behind < least) {
      least = behind;
      base = id;
    }
  }
  return base;
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

/** Pictographs, the joiners and selectors that go with them, and arrows: what titles are decorated with. */
const DECOR = /[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️⃣←-⇿➔➡⬅-⬇]/gu;
/** A text without the run of `chars` at its end (a loop, not a regex: a long run in the middle would make one backtrack). */
const trimEnd = (s: string, chars: string) => {
  let end = s.length;
  while (end > 0 && chars.includes(s[end - 1]!)) end--;
  return s.slice(0, end);
};

/**
 * A frame's title as a chapter's name, and what it says besides: without the author's numbering, markers
 * and pictographs, and the instructions in brackets or after a dash ("6  UPSCALE  hires pass 1.5x  (switch off
 * in the toggles box)" → "UPSCALE"; "# ::Face 🙂" → "Face"; "Face Detailer - Only use if faces are far away"
 * → "Face Detailer", aside "Only use if faces are far away"). Empty when nothing is left.
 */
export function titleParts(title: string): { name: string; aside: string } {
  let t = title.slice(0, TITLE).normalize("NFKC").replace(DECOR, " ");
  let aside = "";
  const bracket = /[([]([^()[\]]*)[)\]]\s*$/.exec(t);
  if (bracket) {
    aside = bracket[1]!.trim();
    t = t.slice(0, bracket.index);
  }
  t = t.replace(/^[\s#:;|>*=~_.\-–—]+/, "").replace(/^(step|part|stage|section|group)?\s*\d+[a-z]?\s*[.:)\-–—]+\s*/i, "").replace(/^\d+\s{2,}/, "");
  // "UPSCALE  hires pass 1.5x": a title written as segments set apart by two spaces is named by its first
  t = (t.trim().split(/\s{2,}/)[0] ?? t).replace(/\s/g, " ");
  // "Face Detailer - Only use if faces are far away": a name, then what it is for
  const dash = /^(.{3,}?) [-–—:|] (.+)$/.exec(t);
  if (dash) {
    t = dash[1]!;
    aside = [dash[2]!.trim(), aside].filter(Boolean).join(" · ");
  }
  // a colour written into the title, a version, and the editor's own name for a new frame say nothing
  t = t.replace(/#[0-9a-f]{6}\b/gi, " ").replace(/\s+(version\s*\d[\d.]*|v\d+(\.\d+)*)\s*$/i, "");
  const name = trimEnd(t, " \t#:;|*=~_-–—").replace(/\s+/g, " ").trim().replace(/^(new )?group( \d+)?$/i, "");
  return { name, aside };
}

/** A frame's title as a chapter's name (see titleParts). */
export const chapterName = (title: string) => titleParts(title).name || title.slice(0, TITLE).replace(DECOR, " ").replace(/\s+/g, " ").trim();

/** What a part does, said in a word, when its title says nothing: from the nodes in it. */
function nameFromNodes(graph: Graph, nodes: string[], base: string | null): string {
  const classes = nodes.map((id) => graph[id]?.class_type ?? "");
  if (classes.some((c) => /Interpolat|RIFE|FILM/i.test(c))) return "Interpolation";
  if (classes.some((c) => /Detailer/i.test(c))) return "Detailer";
  if (classes.some((c) => /Upscale|SeedVR/i.test(c))) return nodes.some((id) => id !== base && graph[id] && "steps" in graph[id]!.inputs) ? "Hires fix" : "Upscale";
  if (classes.some((c) => /Refin/i.test(c))) return "Refiner";
  if (nodes.some((id) => graph[id] && "steps" in graph[id]!.inputs)) return nodes.includes(base ?? "") ? "Sampling" : "2nd pass";
  // a model's loader with its LoRAs is the model's part; LoRAs alone are their own
  if (classes.some((c) => /Loader|Checkpoint|UNET/i.test(c) && !/Lora/i.test(c))) return "Model";
  if (classes.some((c) => /Lora/i.test(c))) return "LoRAs";
  if (classes.some((c) => /TextEncode|Prompt/i.test(c))) return "Prompt";
  if (classes.some((c) => /^Load(Image|Video|Audio)|VHS_Load/i.test(c))) return "Inputs";
  if (classes.some((c) => /Save|Combine|Preview/i.test(c))) return "Output";
  return "Settings";
}

export const titleOf = (graph: Graph, id: string | undefined) => ((id && ((graph[id] as { _meta?: { title?: string } } | undefined)?._meta?.title ?? graph[id]?.class_type)) || "").slice(0, TITLE).replace(DECOR, " ").replace(/\s+/g, " ").trim();

/** What every step of the arrangement shares. */
interface Arranging {
  graph: Graph;
  wiring: Wiring | undefined;
  result: string;
  placeables: Placeable[];
  existing: Toggle[];
  base: string | null;
  nodeOf: Map<string, string | undefined>;
  placedIds: Set<string>;
  sections: Section[];
  toggles: Toggle[];
  why: string[];
  ids: Set<string>;
}

const settings = (n: number) => plural(n, "setting");
function uniqueId(a: Arranging, prefix: string, title: string): string {
  let id = `${prefix}_${slug(title) || "frame"}`;
  for (let n = 2; a.ids.has(id); n++) id = `${prefix}_${slug(title) || "frame"}_${n}`;
  a.ids.add(id);
  return id;
}
/** The settings on these nodes not placed yet, in the form's order; marked placed. */
function take(a: Arranging, nodes: string[]): string[] {
  const inside = new Set(nodes);
  const items = a.placeables.filter((p) => p.node && inside.has(p.node) && !a.placedIds.has(p.id)).map((p) => p.id);
  for (const id of items) a.placedIds.add(id);
  return items;
}
/** Saved switched off in the file: every node of it. */
const savedOff = (a: Arranging, nodes: string[]) => nodes.length > 0 && nodes.every((id) => a.wiring?.modes[id]);

/**
 * A part as a switch, when it can be one: the author's own switch over its nodes, else one made here when it is a
 * pass of work the output can do without. Null when it is neither (the base pass, the output, a part that cannot be skipped).
 */
function switchFor(a: Arranging, nodes: string[], label: string, aside: string, note: string | undefined): { group: (items: string[]) => SwitchGroup; said: string } | null {
  const { graph, result, base } = a;
  if (!nodes.length) return null;
  const own = a.existing.find((t) => !t.made && t.effects.some((e) => nodes.every((id) => e.nodes.includes(id))));
  if (own) return { group: (items) => ({ toggle: own.id, items: items.filter((id) => id !== own.id) }), said: `the author's own switch "${own.label}" covers it` };
  const work = nodes.some((id) => "steps" in graph[id]!.inputs || PASS_WORK.test(graph[id]!.class_type));
  if (!work || nodes.includes(result) || (base !== null && nodes.includes(base)) || !survivesBypass(graph, a.wiring, nodes, result)) return null;
  const off = savedOff(a, nodes) || OFF_WORDS.test(aside) || OFF_WORDS.test(label);
  const help = [aside, note].filter(Boolean).join("\n\n");
  const toggle: Toggle = {
    id: uniqueId(a, "sw_made", label), label, default: !off,
    effects: [{ nodes, activeWhen: true, mode: "skip" }], writes: [], front: true, made: true,
    ...(help ? { help } : {}),
  };
  a.toggles.push(toggle);
  return { group: (items) => ({ toggle: toggle.id, items }), said: `a pass the output can do without: a switch, ${off ? (savedOff(a, nodes) ? "off as the author saved it" : "off, as its title says") : "on"}` };
}

/** The author's frames, drawn around something: the outermost in reading order (left to right, then top to bottom; those with no place known keep their file order), each with the frames drawn inside it. */
function framesToSections(a: Arranging, frames: Frame[]): void {
  const { graph, result, base } = a;
  const live = frames.map((f, i) => ({ ...f, i, deep: frameNodes(frames, i).filter((id) => graph[id]) }));
  const usable = (f: (typeof live)[number]) => f.deep.length > 0 && !NOTE.test(f.title);
  const topOf = (f: (typeof live)[number]): (typeof live)[number] => {
    // up through the frames it is drawn in; a file whose frames hold each other stops where it comes round
    const seen = new Set<number>();
    let at = f;
    for (let up = at.parent !== undefined ? live[at.parent] : undefined; up && usable(up) && !seen.has(up.i); up = up.parent !== undefined ? live[up.parent] : undefined) {
      seen.add(at.i);
      at = up;
    }
    return at;
  };
  const reading = <T extends { box?: number[]; i: number }>(x: T, y: T) => (x.box && y.box ? x.box[0]! - y.box[0]! || x.box[1]! - y.box[1]! : x.i - y.i);
  const tops = live.filter((f) => usable(f) && topOf(f) === f).sort(reading);

  for (const f of tops) {
    const { name, aside } = titleParts(f.title);
    const label = name || nameFromNodes(graph, f.deep, base);
    // the frames drawn inside it, each with all that is inside it in turn
    const children = live.filter((c) => c.parent === f.i && c.i !== f.i && usable(c)).sort(reading);
    const ownNodes = f.nodes.filter((id) => graph[id]);
    const parts: Array<{ sw: ReturnType<typeof switchFor>; nodes: string[]; label: string }> = children.map((c) => {
      const t = titleParts(c.title);
      const cl = t.name || nameFromNodes(graph, c.deep, base);
      return { sw: switchFor(a, c.deep, cl, t.aside, c.note), nodes: c.deep, label: cl };
    });
    const sectionId = uniqueId(a, "sec", label);
    let items: Section["items"];
    let said: string;
    if (parts.some((p) => p.sw)) {
      // switches inside: the frame is the chapter, each switch with what is in its own frame
      items = [...take(a, ownNodes)];
      for (const p of parts) {
        const got = take(a, p.nodes);
        if (p.sw) items.push(p.sw.group(got));
        else items.push(...got);
      }
      // a frame inside that was not made a switch: no switch of its own was made for nothing
      const made = parts.filter((p) => p.sw).map((p) => `"${p.label}" (${p.sw!.said})`);
      said = `a section, with ${made.length === 1 ? "a switch" : `${made.length} switches`} inside: ${made.join(", ")}`;
    } else {
      const sw = switchFor(a, f.deep, label, aside, f.note);
      const got = take(a, f.deep);
      if (sw) {
        items = [sw.group(got)];
        said = `${sw.said}, with ${settings(got.length)} under it`;
      } else {
        items = got;
        const why = f.deep.includes(result) ? " (it holds the output)" : base !== null && f.deep.includes(base) ? " (the base pass: never a switch)" : f.deep.some((id) => "steps" in graph[id]!.inputs || PASS_WORK.test(graph[id]!.class_type)) ? " (bypassing it would cut the output)" : "";
        said = `a section with ${settings(got.length)}${why}`;
      }
    }
    const count = items.reduce<number>((n, it) => n + (typeof it === "string" ? 1 : 1 + it.items.length), 0);
    if (!count) {
      a.why.push(`"${label}": nothing of the form in it${f.deep.includes(result) ? " (it holds the output)" : ""}: left alone.`);
      continue;
    }
    // what the author wrote: in the title besides its name, and in the notes inside the frame
    const help = [parts.some((p) => p.sw) ? aside : "", f.note && !items.some((it) => typeof it !== "string" && a.toggles.some((t) => t.id === it.toggle && t.help?.includes(f.note!))) ? f.note : ""].filter(Boolean).join("\n\n");
    a.sections.push({ id: sectionId, label, items, ...(help ? { help } : {}) });
    a.why.push(`"${label}": ${said}.`);
  }
}

/**
 * Without frames: Model, Inputs, Output, Sampling, then a section per pass of work (a switch when it can be skipped).
 * After the frames (`withPasses` false): the first four only, for what the frames left out.
 */
function byRole(a: Arranging, withPasses = true): void {
  const { graph, result, base, nodeOf, placedIds } = a;
  const at = (id: string) => nodeOf.get(id);
  const cls = (id: string) => graph[at(id) ?? ""]?.class_type ?? "";
  const rest = () => a.placeables.filter((p) => !placedIds.has(p.id));
  const pick = (test: (p: Placeable) => boolean) => {
    const items = rest().filter(test).map((p) => p.id);
    for (const id of items) placedIds.add(id);
    return items;
  };
  const add = (label: string, items: Section["items"]) => {
    if (!items.length) return;
    // after the frames, a section of that name the author made takes them
    const twin = withPasses ? undefined : a.sections.find((x) => x.label.toLowerCase() === label.toLowerCase());
    if (twin) twin.items.push(...items);
    else a.sections.push({ id: uniqueId(a, "sec", label), label, items });
  };
  // the passes: each sampling after the base one and each node of work, with the nodes only it is made from
  const consumersOf = readersOf(graph, true);
  const behindResult = ancestors(graph, result);
  const heads = Object.entries(graph)
    .filter(([id, n]) => behindResult.has(id) && id !== base && ("steps" in n.inputs || PASS_WORK.test(n.class_type)) && !/Loader$/i.test(n.class_type))
    .map(([id]) => id);
  // the main line: the base pass, what it is made from, and what is made from it; a pass's own nodes are off it
  const beforeBase = base ? new Set([base, ...ancestors(graph, base)]) : new Set<string>();
  const afterBase = new Set(Object.keys(graph).filter((id) => base !== null && ancestors(graph, id).has(base)));
  /** A pass: its node of work, with what feeds only it from off the main line (its loaders, its own prompt). */
  const passOf = (head: string) => {
    const nodes = new Set([head]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const id of [...nodes]) {
        for (const v of Object.values(graph[id]!.inputs)) {
          const x = isRef(v) ? v[0] : null;
          if (!x || !graph[x] || nodes.has(x) || beforeBase.has(x) || afterBase.has(x) || heads.includes(x)) continue;
          if ((consumersOf.get(x) ?? []).every((c) => nodes.has(c.node))) {
            nodes.add(x);
            grew = true;
          }
        }
      }
    }
    return { head, nodes: [...nodes] };
  };
  let passes = heads.map(passOf);
  // an upscale that only feeds the sampling after it is that sampling's pass (a hires fix), not one of its own
  for (const p of [...passes]) {
    const only = (consumersOf.get(p.head) ?? []).map((c) => c.node);
    const into = only.length === 1 ? passes.find((q) => q.head === only[0] && "steps" in graph[q.head]!.inputs) : undefined;
    if (into && /Upscale/i.test(graph[p.head]!.class_type) && !("steps" in graph[p.head]!.inputs)) {
      into.nodes.push(...p.nodes);
      passes = passes.filter((q) => q !== p);
    }
  }
  passes.sort((x, y) => ancestors(graph, x.head).size - ancestors(graph, y.head).size);
  const inPass = new Set(passes.flatMap((p) => p.nodes));

  const media = (p: Placeable) => ["startImage", "endImage", "previousVideo", "nextVideo", "sourceVideo", "sound"].includes(p.id) || /^(pic|snd|vid)_/.test(p.id) || /^Load(Image|Video|Audio)|VHS_Load/i.test(cls(p.id));
  add("Model", pick((p) => p.id === "model" || /^loras(_\d+)?$/.test(p.id) || (!inPass.has(at(p.id) ?? "") && /Loader|Checkpoint|UNET|Lora|GGUF/i.test(cls(p.id)) && !media(p))));
  add("Inputs", pick(media));
  add("Output", pick((p) => p.id === "size" || p.id === "seconds" || (!inPass.has(at(p.id) ?? "") && /Save|Combine|Empty.*Latent|EmptyEmbeds/i.test(cls(p.id)))));
  // the choice of how far it runs (or the hires fix switch) leads the sampling
  add("Sampling", pick((p) => p.id === "stage" || p.id === "seed" || (!inPass.has(at(p.id) ?? "") && (at(p.id) === base || /Sampler|Scheduler|Sigmas|Guider|CFG|ModelSampling|Noise|Guidance|Shift/i.test(cls(p.id))))));
  if (!withPasses) return;
  for (const p of passes) {
    const label = nameFromNodes(graph, p.nodes, base);
    const sw = switchFor(a, p.nodes, label, "", undefined);
    const got = take(a, p.nodes);
    if (!got.length && !sw) continue;
    add(label, sw ? [sw.group(got)] : got);
    a.why.push(`"${label}": ${sw ? sw.said : "a pass that cannot be skipped: a section"}.`);
  }
}

/** A value left over (a number node, some arithmetic) sits with what it feeds, wherever that was placed. */
function placeValueNodes(a: Arranging): void {
  const { graph, nodeOf, placedIds } = a;
  const consumers = readersOf(graph, true);
  // (a value node: one that takes no link, or a number node or some arithmetic by its kind)
  const valueNode = (id: string) => !Object.values(graph[id]?.inputs ?? {}).some(isRef) || /Primitive|Math|Number|Constant|Int|Float|Steps|Value/i.test(graph[id]?.class_type ?? "");
  for (let round = 0; round < 3; round++) {
    for (const p of a.placeables) {
      if (placedIds.has(p.id) || !p.node || !valueNode(p.node)) continue;
      const fed = new Set((consumers.get(p.node) ?? []).map((c) => c.node));
      const home = a.sections.find((sec) => sec.items.some((it) => (typeof it === "string" ? [it] : it.items).some((id) => fed.has(nodeOf.get(id) ?? ""))));
      if (!home) continue;
      home.items.push(p.id);
      placedIds.add(p.id);
    }
  }
}

/** Two sections of the same name: one, when neither is a switch; otherwise told apart by a number. */
function mergeTwins(sections: Section[]): Section[] {
  const merged: Section[] = [];
  for (const s of sections) {
    const twin = merged.find((m) => m.label.toLowerCase() === s.label.toLowerCase());
    const plain = (x: Section) => x.items.every((it) => typeof it === "string");
    if (twin && plain(twin) && plain(s)) twin.items.push(...s.items);
    else {
      let label = s.label;
      for (let n = 2; merged.some((m) => m.label.toLowerCase() === label.toLowerCase()); n++) label = `${s.label} ${n}`;
      merged.push({ ...s, label });
    }
  }
  return merged;
}

/** A long section: split by node, a few nodes' settings together, each part named by its first node. */
function splitLong(a: Arranging, sections: Section[]): Section[] {
  const { graph, nodeOf } = a;
  const split: Section[] = [];
  for (const s of sections) {
    const loose = s.items.filter((it): it is string => typeof it === "string");
    if (loose.length <= LONG) {
      split.push(s);
      continue;
    }
    const runs: string[][] = [];
    for (const id of loose) {
      const last = runs.at(-1);
      if (last && nodeOf.get(last[0]!) === nodeOf.get(id)) last.push(id);
      else runs.push([id]);
    }
    const chunks: string[][] = [];
    for (const run of runs) {
      const last = chunks.at(-1);
      if (last && last.length + run.length <= 8) last.push(...run);
      else chunks.push([...run]);
    }
    chunks.forEach((chunk, n) => {
      const groups = n === 0 ? s.items.filter((it) => typeof it !== "string") : [];
      let label = `${s.label} · ${titleOf(graph, nodeOf.get(chunk[0]!))}`;
      for (let k = 2; split.some((x) => x.label === label); k++) label = `${s.label} · ${titleOf(graph, nodeOf.get(chunk[0]!))} ${k}`;
      split.push(n === 0 ? { ...s, items: [...chunk, ...groups] } : { id: uniqueId(a, "sec", `${s.label} ${n + 1}`), label, items: chunk });
    });
    a.why.push(`"${s.label}": ${loose.length} settings, split by node into ${chunks.length} sections.`);
  }
  return split;
}

export function suggestSections(graph: Graph, wiring: Wiring | undefined, result: string, placeables: Placeable[], frames: Wiring["frames"] = wiring?.frames ?? [], existing: Toggle[] = []): Suggestion {
  const a: Arranging = {
    graph, wiring, result, placeables, existing, base: basePass(graph),
    nodeOf: new Map(placeables.map((p) => [p.id, p.node])), placedIds: new Set(), sections: [], toggles: [], why: [], ids: new Set(),
  };
  framesToSections(a, frames);
  if (!a.sections.length) {
    a.why.push(frames.length ? "None of this workflow's frames holds part of the form: arranged by what its nodes do." : "This workflow has no frames: arranged by what its nodes do.");
    byRole(a);
  } else {
    // what the author's frames leave out (a loader, a sampler, the choice of how far it runs): by what its nodes do
    const before = a.placedIds.size;
    byRole(a, false);
    if (a.placedIds.size > before) a.why.push(`${settings(a.placedIds.size - before)} outside the author's frames: placed by what ${a.placedIds.size - before === 1 ? "its node does" : "their nodes do"}.`);
  }
  placeValueNodes(a);
  const split = splitLong(a, mergeTwins(a.sections));
  const left = placeables.filter((p) => !a.placedIds.has(p.id)).length;
  if (split.length && left) a.why.push(`${settings(left)} placed nowhere ${left === 1 ? "stays" : "stay"} under Advanced.`);
  if (!split.length) a.why.push("Nothing to arrange: arrange it by hand.");
  return { sections: split, toggles: a.toggles.filter((t) => split.some((s) => s.items.some((it) => typeof it !== "string" && it.toggle === t.id))), why: a.why };
}
