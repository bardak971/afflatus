# Presets

A preset is a starting point for a form: an operation, the values it sets (at least the model file), and the model files it needs with where each one is fetched from. In Afflatus they live in the **Prompt kit → Presets**, where you apply one in Studio, copy it to change it, or fetch its missing files in one click.

## The ones that ship

Each file in this folder is listed in every Afflatus as a read-only "built in" preset: the **official model releases**, the same files Settings → Models knows how to get, and **community models whose authors agreed** to have their settings shipped, credited on each preset with links to their pages:

| Preset | Model | Licence |
|---|---|---|
| `krea2-turbo` | Krea 2 Turbo, fp8 (pictures) | Krea 2 Community License |
| `zimage-turbo` | Z-Image Turbo, bf16 (pictures) | Apache 2.0 |
| `klein-4b` | FLUX.2 Klein 4B base (pictures, edit by instruction) | Apache 2.0 |
| `qwen-image-2512` | Qwen Image 2512, fp8, with its Lightning LoRA (pictures, text in the picture) | Apache 2.0 |
| `qwen-image-21` | Qwen Image 2.1, int8 (pictures up to 2K, edit) | Qwen Research License: research use only |
| `minimax-h3` | MiniMax H3, int8 (video with sound, seamless timeline joins) | MiniMax H3 Community License: read its excluded territories |
| `wan22-i2v` | Wan 2.2 image to video, 14B fp8 (video) | Apache 2.0 |
| `wan22-t2v` | Wan 2.2 text to video, 14B fp8, with lightx2v's 4-step LoRAs (video) | Apache 2.0 |
| `ltx23-distilled` | LTX 2.3 distilled, 22B fp8 (video with sound) | LTX-2 Community License |
| `dasiwa-h3-v3` | DaSiWa MiniMax H3 Hybrid v3, int8 (video with sound) | MiniMax H3 Community License, with the author's addendum |
| `dasiwa-h3-v3-int4` | DaSiWa MiniMax H3 Hybrid v3, int4: a smaller file | MiniMax H3 Community License, with the author's addendum |
| `dasiwa-h3-v3-turbo` | DaSiWa MiniMax H3 Hybrid Turbo v3, int8, 8 steps | MiniMax H3 Community License, with the author's addendum |
| `dasiwa-h3-v4` | DaSiWa MiniMax H3 Hybrid v4, int8 | MiniMax H3 Community License, with the author's addendum |
| `dasiwa-h3-v4-turbo` | DaSiWa MiniMax H3 Hybrid v4 Turbo, int8, 4 steps | MiniMax H3 Community License, with the author's addendum |
| `dasiwa-krea2` | DaSiWa Krea 2 DarkDesire v3 Turbo, int8 (pictures) | Krea 2 Community License |
| `dasiwa-ltx-dragonleap` | DaSiWa LTX 2.3 DragonLeap v4, distilled, fp8 (video with sound) | LTX-2 Community License, with the author's addendum |
| `dasiwa-ltx-goldenlace` | DaSiWa LTX 2.3 GoldenLace v3, undistilled, fp8 (video with sound) | LTX-2 Community License, with the author's addendum |
| `dasiwa-wan` | DaSiWa Wan 2.2 image to video, TrueVision SnatchKiss v11, fp8 (video) | Apache 2.0 (Wan 2.2), with the author's distribution addendum |

The DaSiWa ones are [Darksidewalker](https://civitai.com/user/Darksidewalker)'s fine-tunes ([GitHub](https://github.com/darksidewalker)), shipped with his agreement: his recommended settings, set per version from his Civitai pages, and the files fetched from there (Civitai asks for your API key: Settings → Models). His settings are a guide; they are kept up to date from his posts.

Each one shows its licence before anything is fetched, and you accept it once. Nothing is bundled: the files come from the publishers' own Hugging Face pages (or ComfyUI's repackaged ones), downloaded by Afflatus into ComfyUI's model folders.

## Your own presets

- **Make one:** set up a form the way you like it in Studio, then Prompt kit → Presets → **New preset**, or **Copy to my presets** on a built-in one and change it.
- **Share one:** **Save as a file** on any preset writes a `.json` file in the format below. Send it, put it in a gist, attach it to a post.
- **Use one someone shared:** Prompt kit → Presets → **Import**, and pick the file. It shows its licence and what it is missing, like the built-in ones.

A community fine-tune (from Civitai or elsewhere) ships here only when the person who made it agrees: their versions and licences change, and they are the one who should say how it is used. Otherwise, share it as a file.

## Format

```json
{
  "id": "minimax-h3",
  "name": "MiniMax H3",
  "author": "MiniMax",
  "line": "int8 · first/last frame, seamless joins",
  "note": "One or two sentences on what it is and what it is for.",
  "homepage": "https://huggingface.co/Comfy-Org/MiniMax-H3",
  "licence": { "name": "MiniMax H3 Community License", "url": "https://…", "note": "What matters in it, in one line." },
  "recipe": "h3.video",
  "inputs": { "model": "minimax_h3_fl2va_pruned_int8_convrot.safetensors" },
  "files": [
    { "file": "minimax_h3_fl2va_pruned_int8_convrot.safetensors", "folder": "diffusion_models", "url": "https://huggingface.co/…/minimax_h3_fl2va_pruned_int8_convrot.safetensors" }
  ]
}
```

- `id`: lower-case letters, digits and dashes; the file is named after it.
- `name`: the model's own name, as its author calls it ("Miracle int4", "Krea 2 Turbo"). The list already groups by family: the name does not repeat it.
- `line`: what it is picked by, in a few words ("Hybrid v3 · smaller file", "fp8 · 8 steps"): the list's dim line, after the author.
- `recipe`: a built-in operation (`h3.video`, `wan.video`, `ltx.video`, `krea2.text-to-picture`, `sdxl.text-to-picture`, `flux.text-to-picture`…; `GET /api/recipes` lists them).
- `inputs`: the form's values, by input id. Only what the preset means to set: everything else follows the model's defaults and what the user saved for it. A model file is named as it is in ComfyUI; a sub-folder on the user's side is matched by name.
- `files[]`: `file` and `folder` (ComfyUI's model folder), and where it comes from: `url` for an address (Hugging Face), or `civitai` for Civitai (`version`: the version id; `pick`: the file's own name there when the version has several; `page`: its page). Civitai needs the user's API key for most files. `optional` marks a file the preset works without. `size` in bytes, when known.
- `licence`: shown before anything is fetched; the user accepts it once.
- `look` (optional): the Prompt kit references, as a saved preset has them.

The family's own files (text encoder, VAE…) are not the preset's: Settings → Models lists and fetches them, and the preset points there when one is missing.
