# Setting up ComfyUI for Afflatus

Afflatus does not bundle or install ComfyUI. It talks to yours over HTTP: on the same PC, or on another machine of your network. This page covers what that ComfyUI needs.

## ComfyUI itself

Any ComfyUI 0.3.x or newer you can reach at an address: a git clone, the portable build or the desktop app. In Afflatus, **Settings → ComfyUI**, enter its address (`http://127.0.0.1:8188` on the same machine) and press **Test**. It reads the version, the card and the node list; it never starts a render.

When ComfyUI is on **this** computer, also give Afflatus **ComfyUI's folder**: the one that holds `custom_nodes` and `models` (where `main.py` is on a manual or portable install; on ComfyUI Desktop, the base folder chosen when installing it). Afflatus usually finds it by itself, from the folders ComfyUI reports. With it, Afflatus:

- writes its node pack into `custom_nodes` (restart ComfyUI once after that);
- reads your model files' headers to tell which family each belongs to, so a renamed file is still found.

When ComfyUI is on **another** machine:

- start ComfyUI with `--listen` so it answers on the network;
- download the node pack from Settings → ComfyUI, unpack it into ComfyUI's `custom_nodes` (it makes `custom_nodes/afflatus-nodes/`) and restart ComfyUI. The pack also lets Afflatus read model headers through ComfyUI;
- set `PUBLIC_URL` on Afflatus to the address ComfyUI can reach it at, so the node pack can fetch downloads through it ([configuration](configuration.md)).

## Downloads

Each missing file in Settings → Models has a **Download** button. Who fetches it depends on where ComfyUI runs:

- **ComfyUI on this machine:** Afflatus downloads the file itself, into the folder ComfyUI lists first for that kind of model (ComfyUI's own list, `extra_model_paths.yaml` included). Two files download at a time. A cut connection is picked up again where it stopped, up to five tries in a row. The free space is checked before, the size (and Hugging Face's SHA-256) after. The file is written as `<name>.part` and renamed once complete, so ComfyUI never lists half a model.
- **ComfyUI on another machine:** Afflatus's node pack downloads it there. A file from Civitai or Hugging Face comes straight from them (0.12.0 or newer): Afflatus asks for a signed link with your key and hands the pack only that link. Any other link is fetched through Afflatus, so set `PUBLIC_URL` for ComfyUI to reach it. Restart ComfyUI after the pack is updated.
- **Otherwise,** ComfyUI-Manager does it (below). It fetches one file at a time, and it holds a file from anywhere but Hugging Face in memory until the end before writing it, so a large one can fail; Afflatus says so before it starts.

Most files on Civitai need an account: paste your Civitai API key in Settings → Models. Afflatus sends it to Civitai only, never to ComfyUI.

Without any of these, every missing file still gets a link to open in your browser.

### ComfyUI-Manager

Afflatus installs the node packs an imported workflow needs through ComfyUI-Manager, and falls back on it for downloads.

- **ComfyUI 0.3.7x and newer** have Manager built in, off until asked. In ComfyUI's folder, run `pip install -r manager_requirements.txt` with ComfyUI's own Python (the venv's, or `python_embeded\python.exe` in the portable build), then start ComfyUI with `--enable-manager`.
- **The desktop app** has it on already.
- **Older ComfyUI:** clone [ComfyUI-Manager](https://github.com/Comfy-Org/ComfyUI-Manager) into `custom_nodes`.

**Behind `--listen`**, Manager refuses downloads from a URL unless its `network_mode` is `personal_cloud`. Set it in `config.ini` and restart ComfyUI:

- `user/__manager/config.ini` for the built-in Manager;
- `custom_nodes/ComfyUI-Manager/config.ini` for the custom node.

A ComfyUI that listens on localhost only needs nothing.

## Node packs

Every built-in form runs on ComfyUI's own nodes first. Some forms and options need a custom node pack on top, and only where they are used. When one is missing, Afflatus names it on the form before you press Render, and in the queue if a render needs it, with how to install it (ComfyUI-Manager, or the repository to clone) and that ComfyUI must be restarted after.

| Pack | What it unlocks |
|---|---|
| **afflatus-nodes**, Afflatus's own (MIT, in [comfy-nodes](../comfy-nodes)) | MiniMax H3 clips that carry on from the clip before's own latent: seamless joins on the timeline, landings on the clip after, the H3 latent re-sample finish. Reading model headers through ComfyUI. Downloads into a ComfyUI on another machine (0.11.0). The lock (0.12.0), the watchdog of a rented pod (0.13.0), uploads to a pod (0.14.0). Face likeness figures: Face Match (0.16.0) and Face At (0.17.0), see below. The GPU's power for this PC's electricity (0.18.0). A pod's disk and room made on it (0.19.0) |
| [ComfyUI-Manager](https://github.com/Comfy-Org/ComfyUI-Manager) | Installing the packs an imported workflow needs; downloads when neither Afflatus nor its node pack can write ComfyUI's model folders |
| [Comfyui-MMH3-UltimateUpscale](https://github.com/bbaudio-2025/Comfyui-MMH3-UltimateUpscale) | H3's latent re-sample: the "Latent: re-sampled" upscale and the H3 finish route |
| [ComfyUI-DaSiWa-Nodes](https://github.com/darksidewalker/ComfyUI-DaSiWa-Nodes) | H3's step cache; the RTX upscaler and refiner node |
| [Nvidia_RTX_Nodes_ComfyUI](https://github.com/Comfy-Org/Nvidia_RTX_Nodes_ComfyUI) | RTX Video Super Resolution, as an upscale and a finish route (NVIDIA cards) |
| [ComfyUI-Impact-Pack](https://github.com/ltdrdata/ComfyUI-Impact-Pack) and [Impact-Subpack](https://github.com/ltdrdata/ComfyUI-Impact-Subpack) | Face refine (the face detailer) |
| [ComfyUI-KJNodes](https://github.com/kijai/ComfyUI-KJNodes) | The live preview of a video while it renders; SageAttention and torch compile |
| [ComfyUI-Detail-Daemon](https://github.com/Jonseed/ComfyUI-Detail-Daemon) | The detail boost option |
| [comfyui_controlnet_aux](https://github.com/Fannovel16/comfyui_controlnet_aux) | The ControlNet guide's pose and depth preprocessors |
| [ComfyUI-VideoHelperSuite](https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite) | Saving videos on older ComfyUI versions (newer ones save videos themselves) |
| [ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF) | GGUF model files |

The list is kept in [`packages/core/src/packs.ts`](../packages/core/src/packs.ts).

Models rather than packs: a **RIFE** model in `models/frame_interpolation` for 48 fps video and slow motion, and **SeedVR2**'s two files for the restoring upscale and finish.

### Face likeness figures

The face figures (the picture for motion transfer ranked by likeness, faces along a timeline, the drift warning) need InsightFace in ComfyUI's own Python, which the pack does not install: in ComfyUI's environment run `pip install insightface onnxruntime` (`onnxruntime-gpu` works too), then restart ComfyUI. Without it the figures are left out and everything else works. The first face scored fetches InsightFace's buffalo_l models into `models/insightface`; they are licensed for non-commercial research only. Afflatus's pod image has InsightFace already. For this PC's electricity, `pip install nvidia-ml-py` lets the pack read the GPU's power (else it asks `nvidia-smi`).

## Models

**Settings → Models** lists every model family with what is ready and what is missing, file by file, with the folder each goes in. A family turns on by itself once one of its models is found. With downloads on, each missing file gets a Download button; or paste a Civitai or Hugging Face address under "Download a model from a URL".

The default files of each family are ComfyUI's own repackaged releases on Hugging Face. The shipped presets name and link other people's models under their own licences; each asks you to accept its licence once before the first download. See [Model licences](../README.md#model-licences).
