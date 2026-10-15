/** A ComfyUI prompt graph in API format: what POST /prompt accepts. */
export interface GraphNode {
  class_type: string;
  inputs: Record<string, unknown>;
}
export type Graph = Record<string, GraphNode>;
/** A link to another node's output: [node id, output index]. */
export type Ref = [node: string, output: number];

/** What the progress bar says while a node runs. */
export const PHASES = [
  "loading", "sampling", "upscaling", "refining", "restoring", "detailing", "processing", "decoding", "interpolating", "encoding",
] as const;
export type Phase = (typeof PHASES)[number];

/** A node whose files the queue fetches when the prompt is done. */
interface GraphOutput {
  node: string;
  kind: "image" | "video" | "audio";
  /**
   * result = what the user asked for; poster / tail = side files a video recipe also saves; raw = the
   * video as the model made it, before any upscale, interpolation or colour pass: kept beside the result,
   * never shown, and handed to the model when another clip carries on from this one; latent = the clip's
   * own latent (MiniMax H3, with the Afflatus node pack), kept beside it for the clips that continue it.
   */
  role: "result" | "poster" | "tail" | "raw" | "latent" | "fine" | "score";
}

export interface BuiltGraph {
  graph: Graph;
  phases: Record<string, Phase>;
  outputs: GraphOutput[];
  /** Sampler steps in total, for progress and the time estimate. */
  totalSteps: number;
  /**
   * The sampling passes in the order they run, each with its steps. With it, progress can be picked up
   * in the middle of a render (after a restart): the passes before the one running are known to be done.
   */
  passes?: Array<{
    node: string;
    steps: number;
    /**
     * The frames this pass samples, said when a part is made in chunks of different lengths (a last chunk of 9 frames after
     * one of 81): the forecast prices each chunk at its own size, where the graph's `frames` (its largest) priced every
     * chunk's steps as the largest's, and a window carried on into a short second chunk read twice its time.
     */
    frames?: number;
    /**
     * The canvas one step of this pass samples, in pixels, said when it is not the graph's largest: a tile of a picture
     * redrawn in tiles (its steps come round once per tile, each at the tile's size, not the whole picture's), or an edit
     * that reads pictures beside its canvas (each one costs a step more). The forecast prices each pass at its own; the
     * work recorded of a render is its first pass's, the one its measured step is the pace of.
     */
    pixels?: number;
  }>;
  /**
   * The canvas the graph samples, in pixels, when none of its nodes says a size: a tool that works on a picture at the
   * picture's own size (a background removal). Set by the server from what it hands the graph; the forecast reads it.
   */
  pixels?: number;
  /** The models this graph loads. The queue frees ComfyUI's memory when the next job's list differs. */
  loads: string[];
  /**
   * How many frames the graph samples, said by the recipe when its nodes do not say it plainly (a continuation window
   * counted in its own terms, a latent loaded from a file): what a render's work is measured in for the forecast.
   */
  frames?: number;
  /**
   * The parts of a video that repeat its neighbours: its start replays the end of the clip it continues,
   * its end replays the start of the clip it arrives at. A timeline skips them, so the join is seamless.
   */
  overlap?: {
    headMs: number;
    tailMs: number;
    /** The start continues the clip before's own latent (the Afflatus node pack): its run-up and its sound are the latent's. */
    latent?: boolean;
    /** With `latent`: the picture guide is the clip before's re-encoded frames, not its exact latent (takes made before 2026-10-08). */
    frames?: boolean;
    /** With `latent`: decoded as one piece with the clip before (its own last tokens before the new ones): the join is a plain cut. */
    seam?: boolean;
  };
}

/**
 * How a clip joins the clip before: "seamless" continues its exact latent and was decoded as one piece with it
 * (the join is a plain cut, as the whole chain decoded at once), "latent" its exact latent decoded alone,
 * "hybrid" its re-encoded frames for the picture (takes made before 2026-10-08: it softened a full-step chain
 * ~35 % a clip), "pixels" pinned frames and re-encoded sound (ComfyUI alone); null when it starts on its own.
 */
export type JoinKind = "seamless" | "latent" | "hybrid" | "pixels";
export function joinKindOf(overlap: BuiltGraph["overlap"] | undefined): JoinKind | null {
  if (!overlap || overlap.headMs <= 0) return null;
  return overlap.latent ? (overlap.frames ? "hybrid" : overlap.seam ? "seamless" : "latent") : "pixels";
}

/** Nodes are numbered in insertion order and tagged with the phase that was current when they were added. */
export class GraphBuilder {
  readonly graph: Graph = {};
  readonly phases: Record<string, Phase> = {};
  private next = 0;
  private current: Phase = "loading";

  phase(p: Phase): this {
    this.current = p;
    return this;
  }

  /** The phase new nodes are tagged with now (to put it back after a helper that sets its own). */
  get at(): Phase {
    return this.current;
  }

  add(classType: string, inputs: Record<string, unknown>): string {
    const id = String(++this.next);
    this.graph[id] = { class_type: classType, inputs };
    this.phases[id] = this.current;
    return id;
  }

  /** add(), returning a link to one of the new node's outputs. */
  out(classType: string, inputs: Record<string, unknown>, output = 0): Ref {
    return [this.add(classType, inputs), output];
  }
}

export const isRef = (v: unknown): v is Ref =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "number";
