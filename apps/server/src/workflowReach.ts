import { isRef } from "@afflatus/core";
import type { WorkflowDef } from "@afflatus/workflows";

/**
 * What a workflow reaches outside ComfyUI's own folders: the nodes that read or write a path or fetch an address. Shown
 * where the user approves a workflow an agent imported (Studio › Workflows), and answered to the agent: a workflow runs its
 * nodes' code on the user's machines, and VideoHelperSuite (which Afflatus itself needs) or WAS read files and URLs.
 *
 * A node is named when its type is one known to (VideoHelperSuite's path loaders, WAS's file nodes), when an input's name
 * says a path, a folder or an address, or when a value typed in looks like one (http://…, C:\…, /etc/…, ../). The model
 * pickers (ckpt_name, lora_name) and a Save node's filename_prefix are ComfyUI's own folders and are not named. More named
 * than less: the list is read once, by a person.
 */

/** Node types that read or write files or fetch addresses whatever their inputs are called. */
const KNOWN = new Set([
  "VHS_LoadVideoPath", "VHS_LoadImagePath", "VHS_LoadImagesPath", "VHS_LoadAudio", "VHS_LoadVideoFFmpegPath",
  "Load Text File", "Save Text File", "Text Load Line From File", "Image Load", "Load Image Batch", "Image Save",
  "Load Cache", "Save Cache", "Cache Node", "Export API", "Video Dump Frames", "Write to Video", "Write to GIF",
  "Create Video from Path", "Text File History Loader", "Load Image From Url", "LoadImageFromUrl", "LoadImageFromURL",
]);

/** An input whose name says a path, a folder, a file or an address. */
const PATH_NAME = /(^|_)(paths?|urls?|uri|dir|directory|folder|filepath|file)($|_)/i;

/** A value that is an address or a path outside ComfyUI's folders: a scheme, a drive, a root, a share, or a step up. */
const PATH_VALUE = /^([a-z][a-z0-9+.-]*:\/\/|file:|[a-z]:[\\/]|[\\/])|(^|[\\/])\.\.([\\/]|$)/i;

/** The inputs that are ComfyUI's own folders, whatever their name says. */
const OWN_FOLDERS = /^(filename_prefix|.+_name)$/;

export interface ReachInput {
  input: string;
  /** What is typed in (cut at 200 characters). */
  value?: string;
  /** The node it is linked from, when it is not typed in. */
  from?: string;
  /** A control of the form sets it: whoever renders the workflow picks it. */
  onForm?: true;
}
export interface Reach { node: string; type: string; title?: string; inputs: ReachInput[] }

export function reachOf(def: Pick<WorkflowDef, "graph" | "bindings">): Reach[] {
  const onForm = new Set([...def.bindings.controls.map((c) => c.target), def.bindings.prompt, def.bindings.negative].filter(Boolean).map((t) => `${t!.node}.${t!.input}`));
  const out: Reach[] = [];
  for (const [id, node] of Object.entries(def.graph)) {
    const inputs: ReachInput[] = [];
    for (const [name, value] of Object.entries(node.inputs)) {
      const typed = typeof value === "string" ? value : null;
      const named = PATH_NAME.test(name) && !OWN_FOLDERS.test(name);
      const looks = typed !== null && PATH_VALUE.test(typed.trim());
      // a known node names every text typed in: which one it reads is its own business. A link is named when the input's
      // name says a path (a known node is listed whole all the same, whatever feeds it)
      if (typed !== null ? !named && !looks && !KNOWN.has(node.class_type) : !(named && isRef(value))) continue;
      inputs.push({
        input: name,
        ...(typed !== null ? { value: typed.slice(0, 200) } : { from: String((value as [string, number])[0]) }),
        ...(onForm.has(`${id}.${name}`) ? { onForm: true as const } : {}),
      });
    }
    if (!inputs.length && !KNOWN.has(node.class_type)) continue;
    const title = typeof node._meta === "object" && node._meta && typeof (node._meta as { title?: unknown }).title === "string" ? (node._meta as { title: string }).title : undefined;
    out.push({ node: id, type: node.class_type, ...(title && title !== node.class_type ? { title } : {}), inputs });
  }
  return out;
}
