import { GraphBuilder, inBoxOf, isRef, MAX_BOXES, regionBox, roundTo, type BuildContext, type BuiltGraph, type InputSpec, type Recipe, type Ref, type RegionValue } from "@afflatus/core";

/**
 * Edit in a box (card #284): boxes drawn over a picture, each with an instruction, and the picture's instruction editor
 * (Qwen Image Edit, Qwen Image 2.1, Klein, Kontext) doing each one there. All of it is one ComfyUI graph, built here around
 * the editor's own recipe: for each box in turn, the picture so far is cropped round the box with a margin, brought to the
 * editor's working size, edited by the editor's graph as it stands, brought back, colour-matched to the original at the
 * box's edge, and pasted inside the box with a soft edge. The next box crops the picture the last one left, so the boxes
 * run one after another on one machine, never side by side, and a box that fails fails the job with ComfyUI's reason. The
 * job is a version of the picture like any other pass (the queue files it), on the user's ComfyUI or a pod alike, since
 * every step past the editor is a core node.
 */

/** The margin round a box the editor sees, each side, as a share of the box's size (√(w·h)): enough of the scene to fit into. */
export const MARGIN = 0.3;
/** The soft edge inside a box where the edit fades into what was there, as a share of the box's shorter side. */
export const FEATHER = 0.1;
/** The least a box is, in the picture's pixels, on a side: a smaller one is grown about its centre. */
const LEAST_BOX = 16;
/** The ring round the box the colour match reads must hold at least this share of the box's area, or it says too little. */
const LEAST_RING = 0.05;

export interface Box { x: number; y: number; w: number; h: number }
export interface Size { w: number; h: number }

/** How one box is edited, in pixels: everything the graph needs, worked out before it is built (tested on its own). */
export interface BoxPlan {
  /** The box on the picture. */
  box: Box;
  /** What is cropped round it and handed to the editor. */
  crop: Box;
  /** The size the crop is brought to for the editor. */
  work: Size;
  /** The box within the crop. */
  inner: Box;
  /** The soft edge inside the box, by side; none on a side the picture's own edge cuts (nothing beyond it to fade into). */
  feather: { left: number; top: number; right: number; bottom: number };
  /** The parts of the crop round the box, in the crop's pixels, that the colour match reads; none when they hold too little. */
  ring: Box[];
}

/** A box given as shares of the picture, in its pixels: whole pixels, inside the picture, at least LEAST_BOX a side. */
export function pixelBox(unit: RegionValue["box"], picture: Size): Box {
  const u = regionBox(unit);
  const w = Math.min(picture.w, Math.max(LEAST_BOX, Math.round(u.w * picture.w)));
  const h = Math.min(picture.h, Math.max(LEAST_BOX, Math.round(u.h * picture.h)));
  const cx = (u.x + u.w / 2) * picture.w, cy = (u.y + u.h / 2) * picture.h;
  return { x: clamp(Math.round(cx - w / 2), 0, picture.w - w), y: clamp(Math.round(cy - h / 2), 0, picture.h - h), w, h };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/** A span of `want` pixels about the centre of [from, from + size), moved to lie within [0, total), no larger than it. */
function span(from: number, size: number, want: number, total: number): [number, number] {
  const len = Math.min(total, Math.max(size, Math.round(want)));
  const start = clamp(Math.round(from + size / 2 - len / 2), 0, total - len);
  return [start, len];
}

/**
 * The working size an editor reads a picture of this shape at (width over height), in its pixels: what it would bring the
 * crop to itself, so that the crop handed over is not scaled again inside, and comes back the same size.
 */
export type WorkingSize = (aspect: number) => Size;

/** Kontext's working sizes, as ComfyUI's FluxKontextImageScale picks from them (PREFERRED_KONTEXT_RESOLUTIONS): Kontext and Qwen Image Edit read the picture through it. */
const KONTEXT_SIZES: ReadonlyArray<[number, number]> = [
  [672, 1568], [688, 1504], [720, 1456], [752, 1392], [800, 1328], [832, 1248], [880, 1184], [944, 1104], [1024, 1024],
  [1104, 944], [1184, 880], [1248, 832], [1328, 800], [1392, 752], [1456, 720], [1504, 688], [1568, 672],
];
/** The Kontext size nearest in shape, as FluxKontextImageScale chooses it. */
export const kontextSize: WorkingSize = (aspect) => {
  let best = KONTEXT_SIZES[0]!;
  for (const s of KONTEXT_SIZES) if (Math.abs(aspect - s[0] / s[1]) < Math.abs(aspect - best[0] / best[1])) best = s;
  return { w: best[0], h: best[1] };
};
/** About `pixels` pixels in all, the shape kept, each side on `grid`: Klein's (16) and Qwen Image 2.1's (32) way. */
export const areaSize = (pixels: number, grid: number): WorkingSize => (aspect) => ({
  w: roundTo(Math.sqrt(pixels * aspect), grid), h: roundTo(Math.sqrt(pixels / aspect), grid),
});

/**
 * The plan of one box: the crop is the box with MARGIN round it, kept within the picture, then grown on one side (never cut)
 * towards the working size's shape, so that bringing it there scales both sides alike; a crop the picture leaves no room to
 * grow is brought there a little stretched, and back by the same stretch. The ring is the crop's four bands round the box.
 */
export function planBox(unit: RegionValue["box"], picture: Size, working: WorkingSize): BoxPlan {
  const box = pixelBox(unit, picture);
  const margin = MARGIN * Math.sqrt(box.w * box.h);
  let [cx, cw] = span(box.x, box.w, box.w + 2 * margin, picture.w);
  let [cy, ch] = span(box.y, box.h, box.h + 2 * margin, picture.h);
  const work = working(cw / ch);
  const aspect = work.w / work.h;
  // the crop grown towards the working shape, about the box's centre, as far as the picture goes
  if (cw / ch < aspect) [cx, cw] = span(box.x, box.w, Math.max(cw, ch * aspect), picture.w);
  else [cy, ch] = span(box.y, box.h, Math.max(ch, cw / aspect), picture.h);
  // the grown span is centred on the box, not on the first crop: it must still hold the box whole
  cx = clamp(cx, Math.max(0, box.x + box.w - cw), box.x);
  cy = clamp(cy, Math.max(0, box.y + box.h - ch), box.y);
  const crop = { x: cx, y: cy, w: cw, h: ch };
  const inner = { x: box.x - cx, y: box.y - cy, w: box.w, h: box.h };
  const f = Math.max(1, Math.round(FEATHER * Math.min(box.w, box.h)));
  const feather = { left: box.x > 0 ? f : 0, top: box.y > 0 ? f : 0, right: box.x + box.w < picture.w ? f : 0, bottom: box.y + box.h < picture.h ? f : 0 };
  const bands: Box[] = [
    { x: 0, y: 0, w: cw, h: inner.y },
    { x: 0, y: inner.y + inner.h, w: cw, h: ch - inner.y - inner.h },
    { x: 0, y: inner.y, w: inner.x, h: inner.h },
    { x: inner.x + inner.w, y: inner.y, w: cw - inner.x - inner.w, h: inner.h },
  ].filter((b) => b.w > 0 && b.h > 0);
  const area = bands.reduce((sum, b) => sum + b.w * b.h, 0);
  return { box, crop, work, inner, feather, ring: area >= LEAST_RING * box.w * box.h ? bands : [] };
}

/** The upload name the editor's graph is built with for its picture: its LoadImage is then replaced by the crop. */
const CROP_SLOT = "afflatus-box-crop.png";

/**
 * The editor's graph for one box, folded into `g`: its picture (the LoadImage of CROP_SLOT) is the crop, its result is
 * returned rather than saved, and a node it shares with a box before (the model, the text encoder, the VAE: the same
 * inputs) is the same node, so that each is loaded once. Its passes come back with their nodes as they are in `g`.
 */
function foldEdit(g: GraphBuilder, built: BuiltGraph, crop: Ref, seen: Map<string, string>): { image: Ref; passes: NonNullable<BuiltGraph["passes"]> } {
  const result = built.outputs.find((o) => o.role === "result");
  if (!result) throw new Error("The edit makes no picture to paste back");
  const outputs = new Set(built.outputs.map((o) => o.node));
  const ids = new Map<string, string>();
  const picture = new Set(Object.entries(built.graph).filter(([, n]) => n.class_type === "LoadImage" && n.inputs.image === CROP_SLOT).map(([id]) => id));
  const remap = (v: unknown): unknown => {
    if (isRef(v)) {
      if (picture.has(v[0])) {
        if (v[1] !== 0) throw new Error("The edit reads its picture's mask, which a box's crop does not have");
        return crop;
      }
      const to = ids.get(v[0]);
      if (!to) throw new Error(`The edit's node ${v[0]} is read before it is made`);
      return [to, v[1]];
    }
    if (Array.isArray(v)) return v.map(remap);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, remap(x)]));
    return v;
  };
  const at = g.at;
  for (const id of order(built.graph)) {
    if (picture.has(id) || outputs.has(id)) continue;
    const node = built.graph[id]!;
    const inputs = remap(node.inputs) as Record<string, unknown>;
    const key = `${node.class_type}\u0000${JSON.stringify(inputs)}`;
    const same = seen.get(key);
    if (same) {
      ids.set(id, same);
      continue;
    }
    g.phase(built.phases[id] ?? at);
    const made = g.add(node.class_type, inputs);
    ids.set(id, made);
    seen.set(key, made);
  }
  g.phase(at);
  const images = built.graph[result.node]!.inputs.images;
  if (!isRef(images)) throw new Error("The edit's result is not a picture made in its graph");
  return {
    image: remap(images) as Ref,
    passes: (built.passes ?? []).map((p) => ({ ...p, node: ids.get(p.node) ?? p.node })),
  };
}

/** A graph's nodes in an order where each comes after every node it reads (GraphBuilder's own numbering already is one). */
function order(graph: BuiltGraph["graph"]): string[] {
  const done = new Set<string>();
  const out: string[] = [];
  const visit = (id: string, path: Set<string>) => {
    if (done.has(id)) return;
    if (path.has(id)) throw new Error("The edit's graph loops");
    path.add(id);
    const reads = (v: unknown): void => {
      if (isRef(v)) visit(v[0], path);
      else if (Array.isArray(v)) v.forEach(reads);
      else if (v && typeof v === "object") Object.values(v).forEach(reads);
    };
    reads(graph[id]?.inputs);
    path.delete(id);
    done.add(id);
    out.push(id);
  };
  for (const id of Object.keys(graph).sort((a, b) => Number(a) - Number(b))) visit(id, new Set());
  return out;
}

/** A part of a picture, in its pixels. */
const cut = (g: GraphBuilder, image: Ref, b: Box): Ref => g.out("ImageCrop", { image, width: b.w, height: b.h, x: b.x, y: b.y });
/** Two pictures one after the other (down) or side by side (right), the second scaled to meet the first: for the ring's figures. */
const stitch = (g: GraphBuilder, a: Ref, b: Ref, direction: "down" | "right"): Ref =>
  g.out("ImageStitch", { image1: a, image2: b, direction, match_image_size: true, spacing_width: 0, spacing_color: "white" });

/**
 * The ring round the box as one picture: the bands above and below (as wide as the crop) one under the other, those left and
 * right (as tall as the box) side by side, then both together. Only its colours are read, so its layout does not matter;
 * the original and the edit are laid out alike.
 */
function ringOf(g: GraphBuilder, image: Ref, plan: BoxPlan): Ref {
  // the bands above and below span the crop; those beside the box are narrower than it by the box at least
  const across = plan.ring.filter((b) => b.w === plan.crop.w).map((b) => cut(g, image, b));
  const sides = plan.ring.filter((b) => b.w !== plan.crop.w).map((b) => cut(g, image, b));
  const join = (parts: Ref[], direction: "down" | "right") => parts.reduce((a, b) => stitch(g, a, b, direction));
  const rows = across.length ? join(across, "down") : null;
  const cols = sides.length ? join(sides, "right") : null;
  return rows && cols ? stitch(g, rows, cols, "down") : (rows ?? cols)!;
}

/**
 * The edit brought to the original's colours as they stand round the box (Reinhard in Lab, ComfyUI's ColorTransfer): the
 * figures of the edit's ring against the original's, the change applied to the whole edit, so that what was added keeps
 * its own colours and only the editor's drift is taken out. The edit's ring rides in the batch as the frame the change is
 * worked out from (target_frame), stretched to the edit's size, which leaves its figures as they were.
 */
function colourMatched(g: GraphBuilder, edited: Ref, original: Ref, plan: BoxPlan): Ref {
  const theirs = g.out("ImageScale", { image: ringOf(g, edited, plan), upscale_method: "bilinear", width: plan.crop.w, height: plan.crop.h, crop: "disabled" });
  const matched = g.out("ColorTransfer", {
    image_target: g.out("ImageBatch", { image1: edited, image2: theirs }), image_ref: ringOf(g, original, plan),
    method: "reinhard_lab", source_stats: "target_frame", "source_stats.target_index": 1, strength: 1,
  });
  return g.out("ImageFromBatch", { image: matched, batch_index: 0, length: 1 });
}

/** The core nodes the boxes take round the editor's graph; the colour match's are used only where this ComfyUI has them. */
const BOX_NODES = ["ImageCrop", "ImageScale", "SplitImageWithAlpha", "SolidMask", "FeatherMask", "ImageCompositeMasked"];
const MATCH_NODES = ["ColorTransfer", "ImageStitch", "ImageBatch", "ImageFromBatch"];

/** What an Edit in box adds to its editor's input: the boxes, each with its instruction. */
export interface InBox { source: string; boxes: RegionValue[] }

/** The boxes as the build takes them: those drawn, each said what to do. */
function boxesOf(boxes: RegionValue[]): RegionValue[] {
  if (!boxes.length) throw new Error("Draw a box on the picture first");
  const unsaid = boxes.findIndex((b) => !b.prompt.trim());
  if (unsaid >= 0) throw new Error(`Box ${unsaid + 1} says nothing to do: give it an instruction`);
  return boxes.slice(0, MAX_BOXES);
}

/**
 * The Edit in box of an instruction editor: its rows (the model, references, sampling) as they are, its one instruction
 * replaced by each box's own, built as said above. `working`: the size the editor reads a picture at, for its input.
 * Hidden: it is the Stage's, sent from its bar, never a form of its own.
 */
export function inBox<In extends { source: string; prompt: string }>(edit: Recipe<In>, working: (input: In) => WorkingSize): Recipe<Omit<In, "prompt"> & InBox> {
  type Boxed = Omit<In, "prompt"> & InBox;
  const boxes: InputSpec = { id: "boxes", type: "regions", label: "Boxes", max: MAX_BOXES, note: "each box's instruction, done there one box after another" };
  const withPrompt = (input: Boxed, prompt: string) => ({ ...input, prompt }) as unknown as In;
  const first = edit.variants[0];
  return {
    id: inBoxOf(edit.id),
    family: edit.family,
    hidden: true,
    version: 1,
    title: "Edit in box",
    summary: `Each box drawn on the picture edited from its own instruction by ${edit.title.toLowerCase()}, one after another; the rest of the picture is kept.`,
    output: "image",
    inputs: [...edit.inputs.filter((i) => i.id !== "prompt"), boxes],
    ...(edit.needs ? { needs: edit.needs } : {}),
    ...(edit.needsWith ? { needsWith: (input: Boxed, slots?: Record<string, string>, where?: { own?: boolean }) => edit.needsWith!(withPrompt(input, ""), slots, where) } : {}),
    ...(edit.presets ? { presets: edit.presets } : {}),
    ...(edit.starts ? { starts: edit.starts } : {}),
    ...(edit.refuses ? { refuses: edit.refuses } : {}),
    ...(edit.comfy ? { comfy: edit.comfy } : {}),
    nodes: (input) => [...new Set([...edit.nodes(withPrompt(input, "")), "LoadImage", "PreviewImage", ...BOX_NODES])],
    optionalNodes: [...(edit.optionalNodes ?? []), ...MATCH_NODES],
    build(input, ctx) {
      const picture = ctx.media.source;
      if (!picture?.width || !picture.height) throw new Error("Edit in box needs the picture's size");
      const size = { w: picture.width, h: picture.height };
      const matching = MATCH_NODES.every((n) => ctx.has(n));
      const g = new GraphBuilder();
      let current = g.out("LoadImage", { image: ctx.uploads.source });
      const seen = new Map<string, string>();
      const passes: NonNullable<BuiltGraph["passes"]> = [];
      const loads = new Set<string>();
      const warnings: string[] = [];
      let totalSteps = 0;
      for (const region of boxesOf(input.boxes)) {
        const plan = planBox(region.box, size, working(withPrompt(input, region.prompt)));
        g.phase("processing");
        const crop = cut(g, current, plan.crop);
        const work = g.out("ImageScale", { image: crop, upscale_method: "lanczos", width: plan.work.w, height: plan.work.h, crop: "disabled" });
        const built = edit.build(withPrompt(input, region.prompt.trim()), {
          ...ctx, uploads: { ...ctx.uploads, source: CROP_SLOT }, media: { ...ctx.media, source: { width: plan.work.w, height: plan.work.h } },
        } satisfies BuildContext);
        const done = foldEdit(g, built, work, seen);
        passes.push(...done.passes);
        built.loads.forEach((l) => loads.add(l));
        warnings.push(...(built.warnings ?? []));
        totalSteps += built.totalSteps;
        g.phase("processing");
        // as a picture of three channels: Qwen Image 2.1's VAE decodes four (it makes RGBA pictures), which ColorTransfer
        // refuses and a paste onto the picture could not take (a pod, 2026-11-04)
        const rgb = g.out("SplitImageWithAlpha", { image: done.image });
        const back = g.out("ImageScale", { image: rgb, upscale_method: "lanczos", width: plan.crop.w, height: plan.crop.h, crop: "disabled" });
        const matched = matching && plan.ring.length ? colourMatched(g, back, crop, plan) : back;
        const mask = g.out("FeatherMask", { mask: g.out("SolidMask", { value: 1, width: plan.box.w, height: plan.box.h }), ...plan.feather });
        current = g.out("ImageCompositeMasked", { destination: current, source: cut(g, matched, plan.inner), x: plan.box.x, y: plan.box.y, resize_source: false, mask });
      }
      if (!matching) warnings.push("This ComfyUI has no ColorTransfer: the boxes were pasted back without matching their colours");
      const out = g.add("PreviewImage", { images: current });
      return {
        graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps, passes, loads: [...loads],
        ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}),
      };
    },
    // each of the editor's own variants with a box, so that every row of its reaches the graph here too; then three boxes
    variants: [
      ...edit.variants.map((v) => ({
        ...v, name: `${v.name}, in a box`,
        input: { ...withoutPrompt(v.input), boxes: [{ id: "r1", box: { x: 0.3, y: 0.4, w: 0.3, h: 0.25 }, prompt: "a deer drinking at the stream" }] } as Partial<Boxed>,
      })),
      ...(first ? [{
        ...first, name: "three boxes, one at the picture's edge, one the whole picture",
        input: {
          ...withoutPrompt(first.input),
          boxes: [
            { id: "r1", box: { x: 0.05, y: 0.1, w: 0.2, h: 0.2 }, prompt: "a red bicycle leaning on the wall" },
            { id: "r2", box: { x: 0.6, y: 0.5, w: 0.4, h: 0.5 }, prompt: "remove the lamp" },
            { id: "r3", box: { x: 0, y: 0, w: 1, h: 1 }, prompt: "make it evening" },
          ],
        } as Partial<Boxed>,
      }] : []),
    ],
  };
}

const withoutPrompt = <T extends object>(input: T): Omit<T, "prompt"> => {
  const { prompt: _, ...rest } = input as T & { prompt?: unknown };
  return rest;
};
