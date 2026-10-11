# Presets

A preset is a starting point for a form: an operation, the values it sets (at least the model file), and the model files it needs with where each one is fetched from. In Afflatus they live in the **Prompt kit → Presets**, where you apply one in Studio, copy it to change it, or fetch its missing files in one click.

## The ones that ship

Each file in this folder is listed in every Afflatus as a read-only "built in" preset. They stay on the **official model releases**, the same files Settings → Models knows how to get:

| Preset | Model | Licence |
|---|---|---|
| `krea2-turbo` | Krea 2 Turbo, fp8 (pictures) | Krea 2 Community License |
| `zimage-turbo` | Z-Image Turbo, bf16 (pictures) | Apache 2.0 |
| `minimax-h3` | MiniMax H3, int8 (video with sound, seamless timeline joins) | MiniMax H3 Community License: read its excluded territories |
| `wan22-i2v` | Wan 2.2 image to video, 14B fp8 (video) | Apache 2.0 |
| `ltx23-distilled` | LTX 2.3 distilled, 22B fp8 (video with sound) | LTX-2 Community License |

Each one shows its licence before anything is fetched, and you accept it once. Nothing is bundled: the files come from the publishers' own Hugging Face pages, through ComfyUI-Manager.

## Your own presets

- **Make one:** set up a form the way you like it in Studio, then Prompt kit → Presets → **New preset**, or **Copy to my presets** on a built-in one and change it.
- **Share one:** **Save as a file** on any preset writes a `.json` file in the format below. Send it, put it in a gist, attach it to a post.
- **Use one someone shared:** Prompt kit → Presets → **Import**, and pick the file. It shows its licence and what it is missing, like the built-in ones.

Community fine-tunes (from Civitai or elsewhere) are best shared that way, as files, rather than shipped here: their versions and licences change, and the person who made the model is the one who should say how it is used.

## Format

```json
{
  "id": "minimax-h3",
  "name": "MiniMax H3 (int8)",
  "author": "MiniMax",
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
- `recipe`: a built-in operation (`h3.video`, `wan.video`, `ltx.video`, `krea2.text-to-picture`, `sdxl.text-to-picture`, `flux.text-to-picture`…; `GET /api/recipes` lists them).
- `inputs`: the form's values, by input id. Only what the preset means to set: everything else follows the model's defaults and what the user saved for it. A model file is named as it is in ComfyUI; a sub-folder on the user's side is matched by name.
- `files[]`: `file` and `folder` (ComfyUI's model folder), and where it comes from: `url` for an address (Hugging Face), or `civitai` for Civitai (`version`: the version id; `pick`: the file's own name there when the version has several; `page`: its page). Civitai needs the user's API key for most files. `optional` marks a file the preset works without. `size` in bytes, when known.
- `licence`: shown before anything is fetched; the user accepts it once.
- `look` (optional): the Prompt kit references, as a saved preset has them.

The family's own files (text encoder, VAE…) are not the preset's: Settings → Models lists and fetches them, and the preset points there when one is missing.
