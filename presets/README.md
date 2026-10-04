# Presets that ship with Afflatus

Each JSON file here is a Prompt kit preset: an operation, the form values it sets (at least the model
file), and the model files it is made for with where each is fetched from. Afflatus lists them among
the user's presets, read-only ("built in"), to apply in Studio or to copy; the preset itself says which
of its files are missing and fetches them through ComfyUI-Manager, under its licence, accepted once.

The built-ins stay on the official files, which Settings → Models knows how to get. These presets are
how someone else's line of models is offered: not Afflatus's work, so not in its settings. To contribute
one, add a file here by pull request. "Save as a file" on any preset in the Prompt kit writes this shape.

## Format

```json
{
  "id": "dasiwa-h3",
  "name": "DaSiWa MiniMax H3: Hybrid v3 (int8, full steps)",
  "author": "Darksidewalker",
  "note": "One or two sentences on what it is and what it is for.",
  "homepage": "https://civitai.com/models/2877206",
  "licence": { "name": "MiniMax H3 Community License", "url": "https://…", "note": "What matters in it, in one line." },
  "recipe": "h3.video",
  "inputs": { "model": "DasiwaMinimaxH3_dasiwaHybridV3_int8.safetensors" },
  "files": [
    { "file": "DasiwaMinimaxH3_dasiwaHybridV3_int8.safetensors", "folder": "diffusion_models", "size": 20480000000,
      "civitai": { "version": 3374445, "pick": "DasiwaMinimaxH3_dasiwaHybridV3_3263052.safetensors", "page": "https://civitai.com/models/2877206?modelVersionId=3374445" } }
  ]
}
```

- `id`: lower-case letters, digits and dashes; the file is named after it.
- `recipe`: a built-in operation (`h3.video`, `wan.video`, `ltx.video`, `krea2.text-to-picture`,
  `sdxl.text-to-picture`, `flux.text-to-picture`…; `GET /api/recipes` lists them).
- `inputs`: the form's values, by input id. Only what the preset means to set: everything else follows
  the model's defaults and what the user saved for it. A model file is named as it is in ComfyUI; a
  sub-folder on the user's side is matched by name.
- `files[]`: `file` and `folder` (ComfyUI's model folder); `url` fetches from an address (Hugging Face),
  `civitai` from Civitai — the version id, and `pick`, the file's own name there when the version has
  several (it often carries a number; `file` is the name it is saved under). Civitai needs the user's key
  for most files. `optional` marks a file the preset works without. `size` in bytes, when known.
- `licence`: shown before anything is fetched; the user accepts it once.
- `look` (optional): the Prompt kit references, as a saved preset has them.

The family's own files (text encoder, VAE…) are not the preset's: Settings → Models lists and fetches
them, and the preset points there when one is missing.
