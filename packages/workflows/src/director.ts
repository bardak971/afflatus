import type { Graph } from "@afflatus/core";

/**
 * The DaSiWa MiniMax H3 Director (pack ComfyUI-DaSiWa-Nodes, GPL-3) takes its pictures in its own canvas, not
 * from a Load Image: its `timeline_data` widget holds `{ items: [{ type: "image", value: <file in ComfyUI's
 * input folder>, slot, ... }] }`, slot 0 the first frame, slot 1 the last (I2VA reads slot 0, FL2VA slots 0
 * and 1, L2VA slot 1). The form's Start image and End image are written there, in the shape its own editor
 * writes them. Its code is not touched; a timeline_data this reads differently is refused with a plain message.
 */
export const DIRECTOR = "MiniMaxH3Director";

/** The modes that take pictures as frames (the others: references, inpainting, are left as the author made them). */
const FRAME_MODES = new Set(["T2VA", "I2VA", "FL2VA", "L2VA"]);

/** Whether a node is a Director whose pictures Afflatus can fill. */
export const isDirector = (graph: Graph, id: string) => graph[id]?.class_type === DIRECTOR && typeof graph[id]?.inputs.timeline_data === "string";

/**
 * Put the form's pictures into the Director's slots (both slots are the form's: a picture the author saved there is
 * on the author's disk, not this one), and, when a picture is given to a mode that would not read it, the mode
 * that does: T2VA with a first frame is I2VA, with a last frame L2VA, with both FL2VA. Throws, in plain words,
 * when its data is not what this was written for, or when the mode needs a picture that was not given.
 */
export function fillDirector(graph: Graph, id: string, pictures: { start?: string; end?: string }): void {
  const node = graph[id]!;
  let state: { items?: unknown };
  try {
    state = JSON.parse(String(node.inputs.timeline_data || "{}"));
  } catch {
    throw new Error("The DaSiWa Director's saved data could not be read: this version of the Director is not supported by Afflatus yet.");
  }
  if (!state || typeof state !== "object" || (state.items !== undefined && !Array.isArray(state.items))) {
    throw new Error("The DaSiWa Director keeps its pictures in a way Afflatus does not know: this version of the Director is not supported yet.");
  }
  const mode = String(node.inputs.mode ?? "");
  const items = ((state.items as Array<Record<string, unknown>> | undefined) ?? []).filter((it) => !(FRAME_MODES.has(mode) && it.type === "image" && [0, 1].includes(Number(it.slot ?? -1))));
  const { start, end } = pictures;
  if (FRAME_MODES.has(mode)) {
    // a picture given is a picture meant: a mode that would not read it becomes one that does; a mode that reads
    // what was given stays the author's (FL2VA with a first frame only is still FL2VA)
    const reads = { T2VA: [], I2VA: ["start"], FL2VA: ["start", "end"], L2VA: ["end"] }[mode as "T2VA"] as string[];
    const given = [start && "start", end && "end"].filter(Boolean) as string[];
    const wanted = given.every((g) => reads.includes(g)) ? mode : start && end ? "FL2VA" : start ? "I2VA" : "L2VA";
    node.inputs.mode = wanted;
    if ((wanted === "I2VA" || wanted === "FL2VA") && !start) throw new Error(`The Director is set to ${wanted}, which opens on a picture: give it a start image, or set it to T2VA.`);
    if (wanted === "L2VA" && !end) throw new Error("The Director is set to L2VA, which ends on a picture: give it an end image, or set it to T2VA.");
    const put = (slot: number, value: string) => items.push({ id: `afflatus_image_${slot}`, type: "image", value, slot, start: slot, duration: 1, enabled: true, order: items.length });
    if (start) put(0, start);
    if (end) put(1, end);
  }
  node.inputs.timeline_data = JSON.stringify({ ...state, items });
}
