import { describe, expect, it } from "vitest";
import { paintSwitches } from "../src/paint";
import type { Toggle } from "../src/types";

const toggle = (id: string, nodes: string[], made = true): Toggle => ({ id, label: id, default: true, effects: [{ nodes, activeWhen: true, mode: "bypass" }], writes: [], front: true, ...(made ? { made } : {}) });

describe("colouring the nodes a switch covers, in the file ComfyUI opens", () => {
  const file = { nodes: [{ id: 10, type: "A" }, { id: 11, type: "B", color: "#111" }, { id: 12, type: "C" }], links: [] };

  it("gives each switch made here one colour of ComfyUI's palette, title bar and body, and leaves the rest", () => {
    const painted = paintSwitches(file, [toggle("sw_made_1", ["10", "11"]), toggle("sw_made_2", ["12"])]);
    expect(painted.nodes[0]).toMatchObject({ id: 10, color: "#232", bgcolor: "#353" });
    expect(painted.nodes[1]).toMatchObject({ id: 11, color: "#232", bgcolor: "#353" });
    expect(painted.nodes[2]).toMatchObject({ id: 12, color: "#223", bgcolor: "#335" });
    // the given file is not touched
    expect(file.nodes[0]).toEqual({ id: 10, type: "A" });
  });

  it("leaves the author's own switches as drawn, and a file it does not understand as it is", () => {
    expect(paintSwitches(file, [toggle("sw_3_enabled", ["10"], false)])).toBe(file);
    const odd = { graph: {} };
    expect(paintSwitches(odd, [toggle("sw_made_1", ["10"])])).toBe(odd);
    // a node inside a group node is not in the top list: nothing to colour, no error
    expect(paintSwitches(file, [toggle("sw_made_1", ["3:20"])]).nodes[0]).toEqual({ id: 10, type: "A" });
  });
});
