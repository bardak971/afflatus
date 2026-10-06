import { z } from "zod";

/**
 * A workflow recipe: a ComfyUI workflow in API format, plus a mapping that says which of its node
 * inputs Afflatus fills in. It is plain data (two things a user can export and share), with no code.
 */

/** One input of one node of the workflow. */
export const target = z.object({ node: z.string(), input: z.string() });
export type Target = z.infer<typeof target>;

/** What the two positions of a switch are called, when it chooses between two things ("I2V" or "FLF2V"). */
export const captions = z.object({ on: z.string(), off: z.string() });

/**
 * Workflow authors name such a switch "X: True = A | False = B". That reads badly on a form: the name
 * and the two captions are taken apart.
 */
export function splitCaptions(label: string): { label: string; captions?: { on: string; off: string } } {
  const m = /^(.*?)[\s:–-]*\btrue\s*=\s*(.+?)\s*\|\s*false\s*=\s*(.+)$/i.exec(label);
  return m ? { label: m[1]!.trim() || "Mode", captions: { on: m[2]!.trim(), off: m[3]!.trim() } } : { label };
}

/** A setting of the workflow shown as a control. Its kind and range were read from ComfyUI when it was imported. */
export const control = z.object({
  /** Stable within the recipe: used as the input id ("ctl_<node>_<input>"). */
  id: z.string(),
  label: z.string(),
  target,
  kind: z.enum(["number", "toggle", "choice", "text"]),
  /** The value the workflow was exported with: the control's default. */
  default: z.union([z.number(), z.boolean(), z.string()]),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  /** A choice among files or names offered by this node input on the user's ComfyUI. */
  choices: z.object({ node: z.string(), input: z.string() }).optional(),
  /** A file on disk (a model): its availability is part of the setup check. */
  file: z.boolean().optional(),
  /** For a yes/no control that is a choice between two named things. */
  captions: captions.optional(),
  /** Other inputs that hold the same setting: they get the same value. */
  also: z.array(target).optional(),
  /** Shown with the main inputs instead of under "All settings": a control the workflow's author made on purpose. */
  front: z.boolean().optional(),
  /** What the input is for, in the node author's words: ComfyUI's tooltip for it, read when the workflow was imported. */
  help: z.string().optional(),
});
export type Control = z.infer<typeof control>;

/**
 * How a node is switched off: bypassed (what goes in comes straight out, as ComfyUI does it), muted
 * (nothing comes out), or skipped: Afflatus's own, for a switch made here over a whole part. The part is
 * stepped over as one: a reader of one of its nodes takes the part's one incoming link of its type, so a
 * pass that goes picture → latent → picture can be switched off where ComfyUI's bypass could not.
 */
export const mode = z.enum(["bypass", "mute", "skip"]);
export type Mode = z.infer<typeof mode>;

/**
 * An on/off switch for parts of the workflow. ComfyUI only has these in its editor: an exported
 * workflow has them frozen. They exist here when the workflow was imported from the editor's own file.
 */
export const toggle = z.object({
  /** Stable within the recipe: used as the input id ("sw_<node>"). */
  id: z.string(),
  label: z.string(),
  /** How the switch was set in the file. */
  default: z.boolean(),
  captions: captions.optional(),
  /** The nodes it switches: active when the switch has the value `activeWhen`, otherwise off in the given way. */
  effects: z.array(z.object({ nodes: z.array(z.string()), activeWhen: z.boolean(), mode })),
  /** Places in the workflow that read the same on/off value. */
  writes: z.array(target).default([]),
  front: z.boolean().optional(),
  /** What the nodes it switches do, from their descriptions in ComfyUI. */
  help: z.string().optional(),
  /** Made in Afflatus at import (a section's switch), not read from the file: its nodes can be changed. */
  made: z.boolean().optional(),
});
export type Toggle = z.infer<typeof toggle>;

/** A switch inside a section, with the settings shown while it is on (as Hires fix holds the upscale settings). */
export const switchGroup = z.object({
  /** The toggle's id, in `toggles`. */
  toggle: z.string(),
  /** Ids of the inputs under it, in the order shown. */
  items: z.array(z.string()).default([]),
});
export type SwitchGroup = z.infer<typeof switchGroup>;

/**
 * A chapter of the form, arranged by the person importing: its settings in the order they are shown,
 * among them switches, each with the settings that show while it is on (off, those fold away and the
 * switch's nodes are bypassed). Settings in no section keep their usual place (up front or under Advanced).
 */
export const section = z.object({
  id: z.string(),
  label: z.string(),
  /** Ids of inputs (controls, the file's switches, the mapping's own inputs), or switch groups, in the order shown. */
  items: z.array(z.union([z.string(), switchGroup])).default([]),
});
export type Section = z.infer<typeof section>;

/**
 * What the editor's file knows and an exported workflow has lost: which nodes are switched off, enough
 * about each node's sockets to work out where a link leads when a node on its way is off, and what the
 * author set up for whoever uses the workflow (names, a control panel, switches).
 */
export const wiring = z.object({
  /** Nodes that are off in the file. Switches override this for the nodes they control. */
  modes: z.record(z.string(), mode),
  /** Per node: its input sockets in the editor's order, as [name, type], and the types of its outputs. */
  slots: z.record(z.string(), z.object({ in: z.array(z.tuple([z.string(), z.string()])), out: z.array(z.string()) })),
  /** The typed-in value of an input that is also linked: used when the link leads to a node that is off. */
  fallback: z.record(z.string(), z.record(z.string(), z.unknown())),
  /** Names the author gave to single settings: "node.input" to the name. */
  labels: z.record(z.string(), z.string()).default({}),
  /** The author's own control panel (settings shown on the front of a group node), in its order. */
  panel: z.array(target).default([]),
  /** Every switch found in the file, whether or not the recipe offers it. */
  toggles: z.array(toggle).default([]),
  /** A setting read by several inputs (one field on the front of a group node): "node.input" of the first, to the others. */
  shared: z.record(z.string(), z.array(target)).default({}),
  /** Where the workflow says its things come from, for when one is missing: */
  /** the pack each kind of node belongs to (its id in ComfyUI's registry), */
  packs: z.record(z.string(), z.string()).default({}),
  /** where a model file can be downloaded, by file name, */
  downloads: z.record(z.string(), z.string()).default({}),
  /** and the links its author wrote in its notes. */
  links: z.array(z.object({ label: z.string(), url: z.string() })).default([]),
  /** The frames the author drew around nodes (the editor's groups): their titles and the nodes inside, for making switches. */
  /** The inputs of each node that its kind declares optional: a link to one that leads nowhere is dropped, not broken. */
  optional: z.record(z.string(), z.array(z.string())).default({}),
  frames: z.array(z.object({ title: z.string(), nodes: z.array(z.string()), /** Where the author drew it: x, y, width, height; for reading frames in their order. */ box: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional() })).default([]),
});
export type Wiring = z.infer<typeof wiring>;

const image = z.object({
  /** The loader node whose file is replaced by the picture the user picks. */
  target,
  /** Without a picture, these links to the loader are removed (only when every one of them is optional). */
  detach: z.array(target),
  required: z.boolean(),
});
export type ImageBinding = z.infer<typeof image>;

export const bindings = z.object({
  prompt: target.optional(),
  negative: target.optional(),
  /** Every seed in the workflow gets the same value. */
  seeds: z.array(target).default([]),
  size: z.object({ width: target, height: target, step: z.number(), min: z.number(), max: z.number() }).optional(),
  /** Video length: seconds on the form, frames in the graph (frames = step × k + offset). */
  length: z.object({ target, fps: z.number(), step: z.number(), offset: z.number(), min: z.number(), max: z.number() }).optional(),
  startImage: image.optional(),
  endImage: image.optional(),
  /**
   * Every other picture the workflow loads (reference pictures, a second picture to edit with): each
   * is a slot of its own in the form, under the name its loader was given.
   */
  pictures: z.array(image.extend({ id: z.string(), label: z.string() })).default([]),
  /** Outputs of model loaders after which the user's LoRAs are chained. */
  loras: z.array(z.object({
    node: z.string(),
    output: z.number(),
    /** Says which loader it is when there are several (a high and a low model). */
    label: z.string().default(""),
    /** The node is itself a list of LoRAs (rgthree's Power Lora Loader): the user's list replaces its own. */
    power: z.boolean().optional(),
  })).default([]),
  toggles: z.array(toggle).default([]),
  sections: z.array(section).default([]),
  /**
   * Output nodes left out of what is sent (a preview or a comparer on a branch the result does not need),
   * each with the nodes that only serve it: ComfyUI runs every output node, so a preview on a dead end
   * costs the work of its branch. Kept by default, as ComfyUI would; the person leaves them out.
   */
  skip: z.array(z.object({ node: z.string(), nodes: z.array(z.string()) })).default([]),
  /** The node whose files are the result. */
  result: z.object({ node: z.string(), kind: z.enum(["image", "video", "audio"]), sound: z.boolean().default(false) }),
  controls: z.array(control).default([]),
  /**
   * Places along the way to the result where the workflow also shows a picture: the first picture,
   * the enlarged one, the one gone over again. The form can stop at one of them, and what comes after
   * is not run. In the order they are made; the last one is the result itself. Empty: it always runs whole.
   */
  stages: z.array(z.object({ node: z.string(), label: z.string() })).default([]),
});
export type Bindings = z.infer<typeof bindings>;

const graphNode = z.looseObject({ class_type: z.string(), inputs: z.record(z.string(), z.unknown()) });
export const graph = z.record(z.string(), graphNode);

export const workflowDef = z.object({
  /** "workflow.<slug>": the recipe id. */
  id: z.string().regex(/^workflow\.[a-z0-9][a-z0-9-]*$/),
  title: z.string().min(1).max(120),
  /** What the user calls the model ("Wan 2.2"): shown under "Made with" and used to group LoRAs and saved settings. */
  model: z.string().min(1).max(60),
  /** Where it came from, for the list ("my workflow.json"). */
  source: z.string().max(200).default(""),
  /** Every node of the workflow. With `wiring`, that includes the ones that are switched off. */
  graph,
  /** Present when the workflow came from the editor's own file. */
  wiring: wiring.optional(),
  /** The editor's own file, as it was imported: what "Open in ComfyUI" opens, exact to the pixel. */
  editor: z.unknown().optional(),
  bindings,
});
export type WorkflowDef = z.infer<typeof workflowDef>;

export const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "workflow";
