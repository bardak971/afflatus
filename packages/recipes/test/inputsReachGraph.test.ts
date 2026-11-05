import { describe, expect, it } from "vitest";
import { dryContext, parseInput, type Recipe } from "@afflatus/core";
import { recipes } from "../src";
import { EXTRA_FILES, other, shown } from "./rowValues";

type Values = Record<string, unknown>;

/**
 * Settings the build does not read, each for its reason: what is read elsewhere is not a setting the graph shows.
 * Besides these, the start, length, loudness and going on of a media input's part (its `window`) and the frames a joined clip
 * gives (`framesFrom`) are the server's: it cuts the part before the build sees it.
 */
const NOT_IN_GRAPH: Record<string, string> = {
  "qwen21.text-to-picture.detailMethod": "its two ways are both Lying sigma: the built-in sharpen breaks Qwen Image 2.1's pictures (card #275); the row stays for the drafts that hold it",
  "h3.video.handover": "the timeline's plan reads it, trimming the clip before to its last lively moment",
  "h3.lipsync.handover": "the timeline's plan reads it, trimming the clip before to its last lively moment",
  "h3.video.joinFrom": "it chooses between the latent join and the frames; the latent join needs the clip before's saved latent, which the recipe tests hand over (not a variant)",
  "h3.lipsync.joinFrom": "it chooses between the latent join and the frames; the latent join needs the clip before's saved latent, which the recipe tests hand over (not a variant)",
  "h3.swap.joinFrom": "it chooses between the latent join and the frames; the latent join needs the clip before's saved latent, which the recipe tests hand over (not a variant)",
  "h3.motion.joinFrom": "it chooses between the latent join and the frames; the latent join needs the clip before's saved latent, which the recipe tests hand over (not a variant)",
  "ltx.video.cueSound": "one value left, the file's sound (card #105): kept so that a clip saved with the model's own still loads",
  "ltx25.video.cueSound": "one value left, the file's sound (card #105): kept so that a clip saved with the model's own still loads",
  "ltx25.lipsync.latentAfter": "set by a timeline, it acts only on a clip doubled by the temporal upscaler, which no 2.5 Lip sync variant is: ltxJoinFixes builds it (card #108)",
  "h3.lipsync.turboIn": "a recording always takes the reference model, whose turbo LoRA is its own: the setting acts on a hybrid fine-tune only",
};

/**
 * The inputs a media input's part is cut by on the server: its window's start, length, loudness, whether the sound goes on
 * after it and whether it is handed over with what comes before it, the frames a joined clip gives.
 */
const serverRead = (r: Recipe<any>) =>
  new Set(r.inputs.flatMap((i) => [
    ...("window" in i && i.window ? [i.window.start, i.window.seconds, ...("even" in i.window && i.window.even ? [i.window.even] : []), ...("goesOn" in i.window && i.window.goesOn ? [i.window.goesOn] : []), ...("leadIn" in i.window && i.window.leadIn ? [i.window.leadIn] : [])] : []),
    ...("framesFrom" in i && i.framesFrom ? [i.framesFrom] : []),
  ]));

describe("every setting of a form", () => {
  it("reaches the graph: some variant's graph changes with its value, its conditions met (review K-11)", () => {
    const missed: string[] = [];
    for (const r of recipes) {
      const elsewhere = serverRead(r);
      for (const spec of r.inputs) {
        if (!["number", "toggle", "choice"].includes(spec.type) || elsewhere.has(spec.id) || NOT_IN_GRAPH[`${r.id}.${spec.id}`]) continue;
        let changes = false;
        for (const v of r.variants) {
          const at = shown(r, spec, v);
          if (!at) continue;
          const ctx = () => dryContext({ slots: { ...EXTRA_FILES, ...v.slots }, uploads: at.uploads, media: at.media as never, canvas: v.canvas, ...(v.has ? { has: v.has } : {}) });
          let base: string;
          try {
            base = JSON.stringify(r.build(parseInput(r, at.input), ctx()).graph);
          } catch {
            continue;
          }
          const now = (parseInput(r, at.input) as Values)[spec.id];
          for (const value of other(spec, now)) {
            try {
              if (JSON.stringify(r.build(parseInput(r, { ...at.input, [spec.id]: value }), ctx()).graph) !== base) changes = true;
            } catch {
              changes = true;
            }
            if (changes) break;
          }
          if (changes) break;
        }
        if (!changes) missed.push(`${r.id}.${spec.id}`);
      }
    }
    expect(missed).toEqual([]);
  });

  it("names in its list only settings the recipes have", () => {
    for (const key of Object.keys(NOT_IN_GRAPH)) {
      const at = key.lastIndexOf(".");
      expect(recipes.find((r) => r.id === key.slice(0, at))?.inputs.some((i) => i.id === key.slice(at + 1)), key).toBe(true);
    }
  });
});
