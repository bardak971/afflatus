import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extraDirs, extraPaths, insideDir, modelDirs, readLocalHeader } from "../src/modelFiles";

const yaml = `#Rename this to extra_model_paths.yaml and ComfyUI will load it

#comfyui:
#     base_path: path/to/comfyui/
#     checkpoints: models/checkpoints/

a1111:
     base_path: /tools/webui
     is_default: true
     checkpoints: models/Stable-diffusion
     configs: models/Stable-diffusion
     vae: models/VAE
     loras: |
          models/LyCORIS
          models/Lora
     upscale_models: |
                  models/ESRGAN
                  models/RealESRGAN
     controlnet: models/ControlNet

a1111_diffusion_models:
     base_path: /tools/webui
     diffusion_models: models/Stable-diffusion/Krea2

other:
     base_path: ./shared
     unet: big-models
     clip: encoders
`;

describe("ComfyUI's model folders on this computer", () => {
  it("reads the directories a folder maps to from extra_model_paths.yaml: single paths, | blocks, several sections, the older names", () => {
    // absolute paths as this platform resolves them (a drive letter on Windows, none elsewhere), slashes one way
    const abs = (p: string) => resolve(p).replace(/\\/g, "/");
    const norm = (p: string) => p.replace(/\\/g, "/");
    const comfy = abs("/comfy");
    expect(extraDirs(yaml, comfy, "checkpoints").map(norm)).toEqual([abs("/tools/webui/models/Stable-diffusion")]);
    expect(extraDirs(yaml, comfy, "loras").map(norm)).toEqual([abs("/tools/webui/models/LyCORIS"), abs("/tools/webui/models/Lora")]);
    expect(extraDirs(yaml, comfy, "upscale_models").map(norm)).toEqual([abs("/tools/webui/models/ESRGAN"), abs("/tools/webui/models/RealESRGAN")]);
    // the folder's older name counts, and a relative base path sits under ComfyUI's folder
    expect(extraDirs(yaml, comfy, "diffusion_models").map(norm)).toEqual([abs("/tools/webui/models/Stable-diffusion/Krea2"), abs("/comfy/shared/big-models")]);
    expect(extraDirs(yaml, comfy, "vae").map(norm)).toEqual([abs("/tools/webui/models/VAE")]);
    expect(extraDirs(yaml, comfy, "text_encoders").map(norm)).toEqual([abs("/comfy/shared/encoders")]);
    expect(extraDirs(yaml, comfy, "embeddings")).toEqual([]);
  });

  it("puts an is_default section's directories first, as ComfyUI does, the last one listed the first", async () => {
    const comfy = mkdtempSync(join(tmpdir(), "afflatus-comfy-"));
    made.push(comfy);
    for (const d of ["models/loras", "store/a", "store/b", "store/c", "other"]) mkdirSync(join(comfy, ...d.split("/")), { recursive: true });
    const base = comfy.replace(/\\/g, "/");
    // is_default after the folders it applies to (ComfyUI pops it before reading them), and a plain section after
    const file = ["plain:", `  base_path: ${base}`, "  loras: other", "shared:", `  base_path: ${base}/store`, "  loras: |", "    a", "    b", "  is_default: true", "late:", `  base_path: ${base}/store`, "  is_default: True", "  loras: c", ""].join("\n");
    writeFileSync(join(comfy, "extra_model_paths.yaml"), file);
    expect(extraPaths(file, comfy, "loras").map((d) => d.isDefault)).toEqual([false, true, true, true]);
    expect(await modelDirs(comfy, "loras")).toEqual([join(comfy, "store", "c"), join(comfy, "store", "b"), join(comfy, "store", "a"), join(comfy, "models", "loras"), join(comfy, "other")]);
    // a default directory listed already is moved first, not listed twice
    writeFileSync(join(comfy, "extra_model_paths.yaml"), ["mine:", `  base_path: ${base}`, "  is_default: true", "  loras: models/loras", "  checkpoints: other", ""].join("\n"));
    expect(await modelDirs(comfy, "loras")).toEqual([join(comfy, "models", "loras")]);
    expect(extraPaths("x:\n  is_default: false\n  loras: a\n", comfy, "loras")).toEqual([{ path: join(comfy, "a"), isDefault: false }]);
  });

  const made: string[] = [];
  afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A .safetensors file: its header, and no weights at all (only the header is ever read). */
  const safetensors = (path: string, header: Record<string, unknown>) => {
    const body = Buffer.from(JSON.stringify(header), "utf8");
    const head = Buffer.alloc(8);
    head.writeBigUInt64LE(BigInt(body.length), 0);
    writeFileSync(path, Buffer.concat([head, body]));
  };

  it("finds a folder's directories under ComfyUI's folder and reads a file's whole header from the disk, by the name ComfyUI lists it under", async () => {
    const comfy = mkdtempSync(join(tmpdir(), "afflatus-comfy-"));
    made.push(comfy);
    mkdirSync(join(comfy, "models", "diffusion_models", "Krea2"), { recursive: true });
    mkdirSync(join(comfy, "models", "unet"), { recursive: true });
    const header = { __metadata__: { ss_output_name: "muse" }, "txtfusion.projector.weight": { dtype: "BF16", shape: [3072, 2560], data_offsets: [0, 0] } };
    safetensors(join(comfy, "models", "diffusion_models", "Krea2", "muse.safetensors"), header);
    safetensors(join(comfy, "models", "unet", "old.safetensors"), { "input_blocks.0.0.weight": { dtype: "F16", shape: [320, 4, 3, 3], data_offsets: [0, 0] } });
    const dirs = await modelDirs(comfy, "diffusion_models");
    // in ComfyUI's order (folder_paths.py): models/unet first, the file it loads by a name both hold
    expect(dirs).toEqual([join(comfy, "models", "unet"), join(comfy, "models", "diffusion_models")]);
    expect(await readLocalHeader(dirs, "Krea2\\muse.safetensors")).toEqual(header);
    expect(await readLocalHeader(dirs, "Krea2/muse.safetensors")).toEqual(header);
    expect(await readLocalHeader(dirs, "old.safetensors")).toMatchObject({ "input_blocks.0.0.weight": { shape: [320, 4, 3, 3] } });
    // not there, not a safetensors file, no ComfyUI folder: nothing
    expect(await readLocalHeader(dirs, "missing.safetensors")).toBeNull();
    expect(await readLocalHeader(dirs, "muse.gguf")).toBeNull();
    expect(await modelDirs("", "diffusion_models")).toEqual([]);
    expect(await modelDirs(join(comfy, "nowhere"), "diffusion_models")).toEqual([]);
  });

  it("reads no file a name from ComfyUI leads out of the models folder to", async () => {
    const comfy = mkdtempSync(join(tmpdir(), "afflatus-comfy-"));
    made.push(comfy);
    mkdirSync(join(comfy, "models", "loras", "sub"), { recursive: true });
    const header = { __metadata__: { ss_output_name: "zz-test" } };
    // a file beside the models folder, which a hostile ComfyUI names by going up, or by its whole path
    safetensors(join(comfy, "secret.safetensors"), header);
    safetensors(join(comfy, "models", "loras", "sub", "ok.safetensors"), header);
    safetensors(join(comfy, "models", "loras", "..dots.safetensors"), header);
    const dirs = await modelDirs(comfy, "loras");
    for (const name of ["../../secret.safetensors", "..\\..\\secret.safetensors", "sub/../../../secret.safetensors", join(comfy, "secret.safetensors"), "/etc/x.safetensors", "C:/x.safetensors", "c:secret.safetensors"]) {
      expect(await readLocalHeader(dirs, name), name).toBeNull();
      expect(insideDir(dirs[0]!, name), name).toBeNull();
    }
    // inside it, whatever the slashes, and a name that only starts with two dots
    expect(await readLocalHeader(dirs, "sub\\ok.safetensors")).toEqual(header);
    expect(await readLocalHeader(dirs, "..dots.safetensors")).toEqual(header);
    expect(insideDir(dirs[0]!, "sub/ok.safetensors")).toBe(resolve(dirs[0]!, "sub", "ok.safetensors"));
  });
});
