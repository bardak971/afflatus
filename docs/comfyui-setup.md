# Setting up ComfyUI for Afflatus

Afflatus does not bundle or install ComfyUI. It talks to yours over HTTP: on the same PC, or on another machine of your network. This page covers what that ComfyUI needs.

## ComfyUI itself

Any ComfyUI you can reach at an address: a git clone, the portable build or the desktop app. The **first launch** looks for one on this PC and renders on it in one click, its node pack put in for you; or takes its address; or goes on with rented GPUs only. Later, in **Settings › ComfyUI**, enter its address (`http://127.0.0.1:8188` on the same machine) and press **Test**. It reads the version, PyTorch, the card and the node list; it never starts a render.

Recent families need a recent ComfyUI. When yours is too old for some, Settings › ComfyUI has a **Too old for** row naming them and the version they need (MiniMax H3 0.30, its Motion transfer 0.35, LTX 2.5 0.32, Qwen Image 2.1 0.37…), with the line to update it (**Copy what to run** when its folder is on this PC). A form whose missing nodes are ComfyUI's own says "update ComfyUI", never a pack to look for.

When ComfyUI is on **this** computer, also give Afflatus **ComfyUI's folder**: the one that holds `custom_nodes` and `models` (where `main.py` is on a manual or portable install; on ComfyUI Desktop, the base folder chosen when installing it). Afflatus usually finds it by itself, from the folders ComfyUI reports. With it, Afflatus:

- writes its node pack into `custom_nodes`, then offers **Restart ComfyUI** on the pack's row (through ComfyUI-Manager, once nothing renders; without Manager, restart it the way you started it);
- reads your model files' headers to tell which family each belongs to, so a renamed file is still found;
- downloads model files into ComfyUI's folders itself, and lists them in Settings › Model files.

When ComfyUI is on **another** machine:

- start ComfyUI with `--listen` so it answers on the network;
- download the node pack from Settings › ComfyUI, unpack it into ComfyUI's `custom_nodes` (it makes `custom_nodes/afflatus-nodes/`) and restart ComfyUI. The pack also lets Afflatus read model headers through ComfyUI;
- set `PUBLIC_URL` on Afflatus to the address ComfyUI can reach it at, so the node pack can fetch downloads through it ([configuration](configuration.md)).

## Downloads

Each missing file in Settings › Models has a **Download** button, and a family that lacks files has **Get the minimum** (what its first operation needs, with the size) beside a quiet **Everything**. Who fetches it depends on where ComfyUI runs:

- **ComfyUI on this machine:** Afflatus downloads the file itself, into ComfyUI's own `models/<folder>` (then its older name, such as `unet`, then the other places ComfyUI lists, `extra_model_paths.yaml` included). The place is shown beside each Download ("→ models\loras"); when ComfyUI reads that folder from several places, a menu picks one, kept per folder and machine (Settings › Models › Downloads › Places chosen, with Reset). Two files download at a time. A cut connection is picked up again where it stopped, up to five tries in a row. The free space is checked before, the size (and Hugging Face's SHA-256) after. The file is written as `<name>.part` and renamed once complete, so ComfyUI never lists half a model.
- **ComfyUI on another machine, or a rented pod:** Afflatus's node pack downloads it there. A file from Civitai or Hugging Face comes straight from them: Afflatus asks for a signed link with your key and hands the pack only that link. From node pack 0.44.0, a file of 256 MB or more comes over 8 connections at once (a 21 GB Civitai model in about a minute and a half on a pod, where one connection took a quarter of an hour), or one connection when the site does not answer parts; it is checked against the SHA-256 Civitai lists before ComfyUI sees it. Any other link is fetched through Afflatus, so set `PUBLIC_URL` for ComfyUI to reach it. Update the pack from Settings › ComfyUI, then restart ComfyUI.
- **Otherwise,** ComfyUI-Manager does it (below), into `models/<folder>`; there is no place to choose. It fetches one file at a time, and it holds a file from anywhere but Hugging Face in memory until the end before writing it, so a large one can fail; Afflatus says so before it starts.

Most files on Civitai need an account: paste your Civitai API key in Settings › Models › Civitai & Hugging Face, with a Hugging Face token for gated files. Afflatus sends the key to Civitai only (never to the storage it redirects to), never to ComfyUI. A version sold on Civitai (Early Access, Buzz) is marked **Paid** or **Early Access · until <day>** in Find models and the command bar, and asked about before it is picked; its download is refused until you unlock it on its page.

Downloads wait in one line per machine: the status bar's chip ("2 ↓ · 8 waiting") and the Downloads card in Settings › Models list it, in an order you drag to change, and a waiting line is asked again in order after a restart. A pod whose node pack is older than 0.36.9 puts a file in the first place ComfyUI lists.

Without any of these, every missing file still gets a link to open in your browser.

### ComfyUI-Manager

Afflatus installs the node packs a render or an imported workflow needs through ComfyUI-Manager, and falls back on it for downloads.

- **ComfyUI 0.3.7x and newer** have Manager built in, off until asked. In ComfyUI's folder, run `pip install -r manager_requirements.txt` with ComfyUI's own Python (the venv's, or `python_embeded\python.exe` in the portable build), then start ComfyUI with `--enable-manager`.
- **The desktop app** has it on already.
- **Older ComfyUI:** clone [ComfyUI-Manager](https://github.com/Comfy-Org/ComfyUI-Manager) into `custom_nodes`.

**Behind `--listen`**, Manager refuses downloads from a URL unless its `network_mode` is `personal_cloud`. Set it in `config.ini` and restart ComfyUI:

- `user/__manager/config.ini` for the built-in Manager;
- `custom_nodes/ComfyUI-Manager/config.ini` for the custom node.

A ComfyUI that listens on localhost only needs nothing.

## Node packs

Every built-in form runs on ComfyUI's own nodes first. Some forms and options need a custom node pack on top, and only where they are used. When one is missing, Afflatus names it under the option before you press Render. The job then waits on its Queue row with **Install and restart** (through ComfyUI-Manager, ComfyUI restarted once nothing renders there) or **Run without**; a machine set to **Always** (Settings › ComfyUI › Missing node packs) installs it by itself. What cannot come is done without and said on the job; a job is never refused for an option. Afflatus's pod image has these packs built in, and a pod gets the ones its jobs need before them.

| Pack | What it unlocks |
|---|---|
| **afflatus-nodes**, Afflatus's own (MIT, in [comfy-nodes](../comfy-nodes)) | MiniMax H3 and LTX clips that carry on in the clip before's own latent: seamless joins, landings on the clip after, the H3 latent re-sample finish. Reading model headers through ComfyUI. Downloads into a ComfyUI on another machine or a pod, 8 connections at once for big files (0.44.0). The lock, a rented pod's watchdog, uploads to a pod, its disk. The face figures (Face Match, Face At); Face Crop to Frame and Face Backdrop for LTX 2.5's reference pictures; Follow Colours; Room Tone; the Free Text Encoder that lets go of H3's text encoder before sampling (0.43.0) |
| [Comfyui-MMH3-UltimateUpscale](https://github.com/bbaudio-2025/Comfyui-MMH3-UltimateUpscale) | H3's latent re-sample: the Latent re-sample upscale route and the H3 finish route |
| [ComfyUI-H3-FaceRefine](https://github.com/Carasibana/ComfyUI-H3-FaceRefine) | Face refine on the video forms, on a take and in Finish |
| [ComfyUI-Impact-Pack](https://github.com/ltdrdata/ComfyUI-Impact-Pack) and [Impact-Subpack](https://github.com/ltdrdata/ComfyUI-Impact-Subpack) | Face and hand refine on pictures; SAM's face outline for the video Face refine |
| [Veda-on-ComfyUI](https://github.com/veda-sparse/Veda-on-ComfyUI) | Veda sparse attention on the H3 forms (Advanced) |
| [ComfyUI-DaSiWa-Nodes](https://github.com/darksidewalker/ComfyUI-DaSiWa-Nodes) | H3's step cache; the RTX upscaler and refiner node |
| [ComfyUI_Nvidia_VFX_Nodes](https://github.com/Comfy-Org/ComfyUI_Nvidia_VFX_Nodes) | RTX Video Super Resolution, as an upscale and a finish route (NVIDIA RTX cards; DaSiWa's pack does it too) |
| [ComfyUI-LTX2.5-MSR](https://github.com/liconstudio/ComfyUI-LTX2.5-MSR) | LTX 2.5's reference pictures and voice sample (its MSR LoRA is a Download) |
| [comfyui_controlnet_aux](https://github.com/Fannovel16/comfyui_controlnet_aux) | The DWPose skeletons that hold H3 · Motion transfer to its source; the ControlNet guide's pose and depth preprocessors |
| [ComfyUI-KJNodes](https://github.com/kijai/ComfyUI-KJNodes) | Used when there: the live preview of a video while it renders, fp16 accumulation, SageAttention; asked for by the RCAS sharpen after an upscale |
| [ComfyUI-Detail-Daemon](https://github.com/Jonseed/ComfyUI-Detail-Daemon) | The detail boost option |
| [ComfyUI-VideoHelperSuite](https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite) | Used when there for video output; without it, ComfyUI's own Save Video |
| [ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF) | GGUF model files |
| [ComfyUI-Manager](https://github.com/Comfy-Org/ComfyUI-Manager) | Installing the packs a render or an imported workflow needs; downloads when neither Afflatus nor its node pack can write ComfyUI's model folders |

The list is kept in [`packages/core/src/packs.ts`](../packages/core/src/packs.ts).

Models rather than packs: a **RIFE** model in `models/frame_interpolation` for 48 fps video and slow motion, **SeedVR2**'s files (the 3B or the 7B, picked per clip) for the restoring upscale and finish, and **SAM** for Face refine's outline. Settings › Models lists them with a Download, as any model.

### Face likeness figures

The face figures (the picture for motion transfer ranked by likeness, the face on every take, the drift warning) need InsightFace in ComfyUI's own Python, which the pack does not install: in ComfyUI's environment run `pip install insightface onnxruntime` (`onnxruntime-gpu` works too), then restart ComfyUI. Without it the figures are left out and everything else works. The first face scored fetches InsightFace's buffalo_l models into `models/insightface`; they are licensed for non-commercial research only. Afflatus's pod image has InsightFace already. For this PC's electricity, `pip install nvidia-ml-py` lets the pack read the GPU's power (else it asks `nvidia-smi`).

## Models

**Settings › Models** lists every model family with what is ready and what is missing, file by file, with the folder each goes in, each family folded to a line that says what it lacks. Each missing file gets a Download button; or paste a Civitai or Hugging Face address under "Download a model from a URL". **Settings › Model files** lists the files already on the disk, with what Afflatus did with each ([the guide](guide.md#models)).

"Search Hugging Face and Civitai" and "Download missing models" are on for a new install, and the first launch says once what that does: your model files' hashes are sent to Civitai and Hugging Face to name them, and nothing is downloaded without asking you first, with its size. An install from before keeps them as they were. The switch covers only what Afflatus asks on its own (missing files, your files matched by hash, newer versions); a search, a link pasted or a Download you press asks the sites whatever it says.

The default files of each family are ComfyUI's own repackaged releases on Hugging Face. The shipped presets name and link other people's models under their own licences; each asks you to accept its licence once before the first download. See [the built-in models](../README.md#the-built-in-models).
