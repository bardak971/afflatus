import { afterEach, describe, expect, it } from "vitest";
import { ComfyClient, scan, type InfoLookup, type Scan } from "@afflatus/comfy";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { missingSlotFile, type ModelInfo } from "@afflatus/core";
import { ltx, ltx25, ltx25Video, ltxVideo } from "@afflatus/recipes";
import { podSlotFiles } from "../src/jobFiles";
import { referenceCatalog } from "./helpers";

/**
 * A slot is never filled with a file of another version of its family's model. On the 0.7.0 test pod (2026-10-26, card #94),
 * LTX 2.5's transformer was there and no LTX 2.3 diffusion model: 2.3's slot took 2.5's file by its weights (its header says
 * "LTX", as every LTX's does), no 2.3 model was sent, and a 2.3 Lip sync rendered 84 s on 2.5's transformer under 2.3's VAEs.
 */

const T25 = "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors";
const DASIWA = "DasiwaLTX23_dragonleapV4.safetensors";

// the pod as it was: 2.3's VAEs, projection and Gemma 3 fetched, then 2.5's set for the jobs after
const POD = {
  checkpoints: [],
  diffusion_models: [T25],
  text_encoders: ["gemma_3_12B_it_fp4_mixed.safetensors", "ltx-2.3_text_projection_bf16.safetensors", "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors"],
  vae: ["LTX23_video_vae_bf16.safetensors", "LTX23_audio_vae_bf16.safetensors", "ltx-2.5-video-vae-bf16.safetensors", "ltx-2.5-audio-vae-bf16.safetensors"],
  loras: [],
};

// what the headers say, as this PC's model_info had it: "LTX" for each of them
const INFO: Record<string, ModelInfo> = { [T25]: { base: "LTX" }, [DASIWA]: { base: "LTX" }, "nameless.safetensors": { base: "LTX" } };
const infoOf = (more: Record<string, ModelInfo> = {}): InfoLookup => (folder, file) => (folder === "diffusion_models" ? more[file] ?? INFO[file] : undefined);

const fakes: FakeComfy[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((f) => f.close()));
});

async function scanOf(diffusionModels: string[], info = infoOf()): Promise<Scan> {
  const fake = await startFakeComfy({ catalog: referenceCatalog(), models: { ...POD, diffusion_models: diffusionModels } });
  fakes.push(fake);
  return scan(new ComfyClient(fake.url), [ltx, ltx25], [ltxVideo, ltx25Video], {}, info);
}
const slotsOf = (s: Scan, family: string) => s.families.find((f) => f.id === family)!.slots;
const unetOf = (s: Scan, family: string) => slotsOf(s, family).find((x) => x.id === "unet")!;

describe("a slot and another version's file", () => {
  it("leaves LTX 2.3's diffusion model a gap on a pod with only 2.5's transformer, and does not offer it", async () => {
    const s = await scanOf([T25]);
    expect(unetOf(s, "ltx")).toMatchObject({ file: null, auto: null, choices: [] });
    // 2.5's own slot still has it
    expect(unetOf(s, "ltx25").file).toBe(T25);
    // the 2.3 form lists it last, with the files of other models
    const options = s.recipes.find((r) => r.id === ltxVideo.id)!.options.model ?? [];
    expect(options.at(-1)).toBe(T25);
  });

  it("sends the pod this PC's 2.3 model for the job, and builds with it once it is there", async () => {
    const pod = await scanOf([T25]);
    const here = await scanOf([DASIWA, T25]);
    // what the job is sent: this PC's 2.3 model, not the pod's 2.5 one
    expect(podSlotFiles(ltxVideo, {}, ltx.slots, slotsOf(pod, "ltx"), slotsOf(here, "ltx")).unet).toBe(DASIWA);
    // landed (a file settled reads the pod's folders again): the slot the build reads is that file
    const landed = await scanOf([T25, DASIWA]);
    expect(unetOf(landed, "ltx").file).toBe(DASIWA);
    expect(podSlotFiles(ltxVideo, {}, ltx.slots, slotsOf(landed, "ltx"), slotsOf(here, "ltx")).unet).toBe(DASIWA);
  });

  it("names the slot missing when no machine has a 2.3 model", async () => {
    const pod = await scanOf([T25]);
    expect(podSlotFiles(ltxVideo, {}, ltx.slots, slotsOf(pod, "ltx"), slotsOf(pod, "ltx")).unet).toBe(missingSlotFile("unet"));
  });

  it("fills each temporal upscaler slot by its file's name, though 2.3's and 2.5's are the same bytes (card #104)", async () => {
    // a slot is told its files' versions by name and weights only, never by a hash Settings › Models has read: the 2.5 file,
    // whose hash is also 2.3's, stays 2.5's slot file and is not 2.3's
    const T23 = "ltx-2.3-temporal-upscaler-x2-1.0.safetensors";
    const T25 = "ltx-2.5-latent-temporal-upscaler-x2-bf16-1.0.safetensors";
    const temporalOf = async (files: string[], family: string) => {
      const fake = await startFakeComfy({ catalog: referenceCatalog(), models: { ...POD, diffusion_models: [T25], latent_upscale_models: files } });
      fakes.push(fake);
      return slotsOf(await scan(new ComfyClient(fake.url), [ltx, ltx25], [ltxVideo, ltx25Video], {}, infoOf()), family).find((x) => x.id === "temporal")!;
    };
    expect(await temporalOf([T23, T25], "ltx25")).toMatchObject({ file: T25, choices: [T25] });
    expect(await temporalOf([T23, T25], "ltx")).toMatchObject({ file: T23, choices: [T23] });
    expect(await temporalOf([T25], "ltx")).toMatchObject({ file: null, choices: [] });
    expect(await temporalOf([T23], "ltx25")).toMatchObject({ file: null, choices: [] });
  });

  it("takes a nameless LTX file by its weights only when its version is told as well", async () => {
    // "LTX" alone could be any of them: a choice, not the slot's file
    const unsure = await scanOf(["nameless.safetensors"]);
    expect(unetOf(unsure, "ltx")).toMatchObject({ file: null, choices: ["nameless.safetensors"] });
    expect(unetOf(unsure, "ltx25")).toMatchObject({ file: null, choices: ["nameless.safetensors"] });
    // Civitai's base model says 2.3: 2.3's file, and not 2.5's choice
    const told = await scanOf(["nameless.safetensors"], infoOf({ "nameless.safetensors": { base: "LTX", civitaiBase: "LTXV 2.3" } }));
    expect(unetOf(told, "ltx").file).toBe("nameless.safetensors");
    expect(unetOf(told, "ltx25")).toMatchObject({ file: null, choices: [] });
  });
});
