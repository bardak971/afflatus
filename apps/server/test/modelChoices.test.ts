import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scan, type ComfyClient } from "@afflatus/comfy";
import type { NodeCatalog } from "@afflatus/core";
import { families, h3Video, ltx25Video, recipeById } from "@afflatus/recipes";

/**
 * What a recipe's Model field offers: a file that fills another slot of the family is not a choice for H3's own clips (it
 * is used by itself when a clip needs it), but Swap's model, a slot of its own, may be any of the family's files. The
 * owner's hybrid turbo fine-tune, set as H3's video model, was missing from the swap's list (2026-10-17).
 */

const catalog = JSON.parse(readFileSync(fileURLToPath(new URL("../../../reference/comfy-object-info.json", import.meta.url)), "utf-8")) as NodeCatalog;
const files: Record<string, string[]> = {
  diffusion_models: [
    "DasiwaMinimaxH3_dasiwaHybridTurboV3_int8.safetensors",
    "DasiwaMinimaxH3_dasiwaHybridV3_int8.safetensors",
    "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
    "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
    "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors",
    "ltx-2.5-22b-dev-transformer-comfy-int8-convrot.safetensors",
  ],
  loras: ["h3_character_swap_pro4500_1000.safetensors", "h3_character_swap_v1.5.safetensors", "minimax_h3_hyperflow_EMA600_pruned_r128_fro0995_turbo_lora.safetensors", "someone_style.safetensors"],
};
const client = {
  baseUrl: "http://comfy.test",
  status: async () => ({ version: "0.41.2", device: "test", vramTotal: 0, vramFree: 0 }),
  catalog: async () => catalog,
  models: async (folder: string) => files[folder] ?? [],
} as unknown as ComfyClient;

describe("a Model field's files", () => {
  it("leaves out another slot's file for H3's clips, and offers every file of the family to Swap's own", async () => {
    const s = await scan(client, families, [h3Video, recipeById("h3.swap")!], { h3: { unet: "DasiwaMinimaxH3_dasiwaHybridTurboV3_int8.safetensors" } });
    const options = (id: string, input: string) => s.recipes.find((r) => r.id === id)!.options[input] ?? [];
    // the reference model is H3's clips' own when they follow references: not a choice for the video model
    expect(options("h3.video", "model")).not.toContain("minimax_h3_ref2va_pruned_int8_convrot.safetensors");
    // the swap starts on its reference model and offers the hybrid turbo fine-tune that is H3's video model
    expect(options("h3.swap", "swapModel")[0]).toBe("minimax_h3_ref2va_pruned_int8_convrot.safetensors");
    expect(options("h3.swap", "swapModel")).toContain("DasiwaMinimaxH3_dasiwaHybridTurboV3_int8.safetensors");
  });

  it("shows the swap's LoRA as a field of its own, V1.5 first, its other versions beside it (the owner, 2026-10-18)", async () => {
    const s = await scan(client, families, [recipeById("h3.swap")!], {});
    const options = s.recipes.find((r) => r.id === "h3.swap")!.options.swapLora ?? [];
    // V1.5 first, as its author recommends (the owner, 2026-10-18); V1 a choice beside it
    expect(options[0]).toBe("h3_character_swap_v1.5.safetensors");
    expect(options).toContain("h3_character_swap_pro4500_1000.safetensors");
    // the swap's versions first; another LoRA stays a choice after them, as a model's fine-tune can be named anything
    expect(options.indexOf("h3_character_swap_v1.5.safetensors")).toBeLessThan(options.indexOf("someone_style.safetensors"));
  });

  // card #105: the dev transformer has a slot of its own for its address and its Download; it stays a choice of the Model
  it("keeps LTX 2.5's dev transformer among its Model's files, the distilled one first", async () => {
    const s = await scan(client, families, [ltx25Video], {});
    const slots = s.families.find((f) => f.id === "ltx25")!.slots;
    expect(slots.find((x) => x.id === "unet")!.file).toBe("ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors");
    expect(slots.find((x) => x.id === "dev")!.file).toBe("ltx-2.5-22b-dev-transformer-comfy-int8-convrot.safetensors");
    const model = s.recipes.find((r) => r.id === "ltx25.video")!.options.model ?? [];
    expect(model[0]).toBe("ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors");
    expect(model).toContain("ltx-2.5-22b-dev-transformer-comfy-int8-convrot.safetensors");
  });
});
