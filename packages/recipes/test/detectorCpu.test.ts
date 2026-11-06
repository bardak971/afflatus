import { describe, expect, it } from "vitest";
import { dryContext, parseInput } from "@afflatus/core";
import { recipeById, recipes } from "../src";
import { DETECTOR_FILES } from "../src/shared/adetail";
import { CPU_DETECTOR } from "../src/shared/detector";

// The YOLO detectors on the CPU (card #335): on a pod's GPU, DynamicVRAM left them giving ~300 boxes or none once a diffusion
// model had loaded beside them. Every graph loads its detector with the node pack's CPU provider where the machine has it
// (pack 0.50.2), and with the Impact Subpack's own, as before, on an older pack.
const SUBPACK = "UltralyticsDetectorProvider";
type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
const providers = (graph: Graph) => Object.values(graph).filter((n) => n.class_type === SUBPACK || n.class_type === CPU_DETECTOR);

/** Every variant of every recipe, with Detail face, hands and person on where it has them, on a machine with or without the CPU provider. */
function* builds(cpu: boolean) {
  const has = (n: string) => cpu || n !== CPU_DETECTOR;
  for (const r of recipes) {
    for (const v of r.variants) {
      const detail = Object.fromEntries(["detailFace", "detailHands", "detailPerson"].filter((id) => r.inputs.some((i) => i.id === id)).map((id) => [id, true]));
      const input = parseInput(r, { ...v.input, ...detail });
      const built = r.build(input, dryContext({ slots: { ...DETECTOR_FILES, ...v.slots }, uploads: v.uploads ?? {}, media: v.media ?? {}, canvas: v.canvas, has }));
      yield { name: `${r.id} · ${v.name}`, graph: built.graph as Graph, optional: r.optionalNodes ?? [], nodes: r.nodes(input) };
    }
  }
}

describe("the YOLO detector's provider", () => {
  it("is the CPU one wherever the machine has it, with the Subpack's inputs", () => {
    const withCpu = [...builds(true)];
    const without = [...builds(false)];
    let seen = 0;
    withCpu.forEach((b, i) => {
      const cpu = providers(b.graph);
      const old = providers(without[i]!.graph);
      expect(cpu.map((n) => n.class_type), b.name).toEqual(cpu.map(() => CPU_DETECTOR));
      expect(old.map((n) => n.class_type), b.name).toEqual(old.map(() => SUBPACK));
      // the same models, one provider for one
      expect(cpu.map((n) => n.inputs), b.name).toEqual(old.map((n) => n.inputs));
      if (cpu.length) {
        seen++;
        // taken only where ComfyUI has it; the Subpack it runs on still asked for, by nodes() or by the pass (wanted)
        expect(b.optional, b.name).toContain(CPU_DETECTOR);
        expect([...b.nodes, ...b.optional], b.name).toContain(SUBPACK);
      }
    });
    expect(seen).toBeGreaterThan(10);
  });

  it("covers Detail, Face refine, the fix-face forms and Find mask", () => {
    const ids = new Set([...builds(true)].filter((b) => providers(b.graph).length).map((b) => b.name.split(" · ")[0]));
    for (const id of ["sdxl.text-to-picture", "krea2.text-to-picture", "klein.picture", "sdxl.fix-face", "klein.fix-face", "tools.find-mask"]) {
      expect(recipeById(id), id).toBeTruthy();
      expect(ids.has(id), id).toBe(true);
    }
  });
});
