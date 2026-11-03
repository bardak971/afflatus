import { describe, expect, it } from "vitest";
import { canonicalFolder, civitaiKinds, fileKey, folderOfCivitaiKind, folderOfFileInput, isSafetensors, kindOfFolder, nameKey, otherName, pathKey } from "../src";

/** The model and file rules the server and the web each had a copy of, now one (the 2026-11-02 review, card #258). */
describe("model and file rules, one copy", () => {
  it("names the folder a node input reads from: a CLIP vision loader's clip_name is clip_vision", () => {
    // the web's own table sent it to text_encoders, and had no text_encoder, lora_*, upscaler, detector or SAM input
    expect(folderOfFileInput("CLIPVisionLoader", "clip_name")).toBe("clip_vision");
    expect(folderOfFileInput("CLIPLoader", "clip_name")).toBe("text_encoders");
    expect(folderOfFileInput("LoraLoaderModelOnly", "lora_name")).toBe("loras");
    expect(folderOfFileInput("UpscaleModelLoader", "model_name")).toBe("upscale_models");
    expect(folderOfFileInput("UltralyticsDetectorProvider", "model_name")).toBe("ultralytics");
  });

  it("knows unet and clip as the older names of diffusion_models and text_encoders", () => {
    expect(canonicalFolder("unet")).toBe("diffusion_models");
    expect(canonicalFolder("clip")).toBe("text_encoders");
    expect(canonicalFolder("loras")).toBe("loras");
    expect(otherName("unet")).toBe("diffusion_models");
    expect(otherName("diffusion_models")).toBe("unet");
    expect(otherName("text_encoders")).toBe("clip");
    expect(otherName("vae")).toBeUndefined();
    expect(kindOfFolder("unet")).toBe("Diffusion model");
    expect(kindOfFolder("clip")).toBe("Text encoder");
  });

  it("files a Civitai type in its folder, and asks a folder's types, from one table", () => {
    // a link to a detector had no folder, and UNet, CLIP and CLIP vision models none either
    expect(folderOfCivitaiKind("Detection")).toBe("ultralytics");
    expect(folderOfCivitaiKind("UNet")).toBe("diffusion_models");
    expect(folderOfCivitaiKind("CLIP")).toBe("text_encoders");
    expect(folderOfCivitaiKind("CLIPVision")).toBe("clip_vision");
    expect(folderOfCivitaiKind("Checkpoint")).toBe("checkpoints");
    expect(folderOfCivitaiKind("LoCon")).toBe("loras");
    // "Other" is anything: no folder from it
    expect(folderOfCivitaiKind("Other")).toBeNull();
    expect(folderOfCivitaiKind("Workflows")).toBeNull();
    expect(civitaiKinds("unet")).toEqual(civitaiKinds("diffusion_models"));
    expect(civitaiKinds("diffusion_models")).toContain("UNet");
    expect(civitaiKinds("sams")).toEqual(["Other"]);
    expect(civitaiKinds("audio_encoders")).toBeUndefined();
  });

  it("takes .sft for safetensors, and keys a file by its name or its path the same way everywhere", () => {
    expect(isSafetensors("flux1-dev.sft")).toBe(true);
    expect(isSafetensors("X.SafeTensors")).toBe(true);
    expect(isSafetensors("x.gguf")).toBe(false);
    expect(nameKey("SDXL\\Juggernaut.safetensors")).toBe("juggernaut.safetensors");
    expect(nameKey("a/b/C.pt")).toBe("c.pt");
    expect(pathKey("SDXL\\Sub\\X.safetensors")).toBe("sdxl/sub/x.safetensors");
    expect(fileKey({ folder: "loras", file: "IL\\Style.safetensors" })).toBe("loras|style.safetensors");
  });
});
