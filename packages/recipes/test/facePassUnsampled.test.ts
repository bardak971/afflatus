import { describe, expect, it } from "vitest";
import { dryContext, parseInput } from "@afflatus/core";
import { recipes } from "../src";

/**
 * A face detailer that finds no face, or none it redraws (Krea 2's Face refine takes small faces only), samples nothing and
 * hands the picture back as it was, ComfyUI saying nothing of it. Each such pass says what its job tells then (the monitor
 * counts its steps only once it samples): a Krea 2 picture showed 28 steps and ran 8, and nothing said Face refine had not run.
 */
const DETAILERS = new Set(["FaceDetailer", "DetailerForEach"]);

describe("a face detailer's pass", () => {
  it("says what its job tells when it samples nothing, in every recipe that has one", () => {
    let seen = 0;
    for (const r of recipes) for (const v of r.variants) {
      const built = r.build(parseInput(r, v.input), dryContext({ slots: v.slots ?? {}, uploads: v.uploads ?? {}, media: v.media ?? {}, canvas: v.canvas, ...(v.has ? { has: v.has } : {}) }));
      for (const p of built.passes ?? []) {
        if (!DETAILERS.has(built.graph[p.node]?.class_type ?? "")) continue;
        seen++;
        expect(p.unsampled, `${r.id} · ${v.name}`).toMatch(/^(No face found|No second face found|Face refine left the face as drawn|Detail: (face|hands|person) (left the picture as drawn|found no))/);
      }
    }
    // the Fix face tools (SDXL, Klein, the flow families'), Klein's two people, Krea 2's Face refine, txt2img's Detail rows
    expect(seen).toBeGreaterThan(4);
  });
});
