# Afflatus

A self-hosted studio for pictures, videos and timelines, in front of your own [ComfyUI](https://github.com/comfyanonymous/ComfyUI).

ComfyUI keeps running where your GPU is. Afflatus is the place you work in: a library of everything you make, a form per model with the right settings already in it, a prompt designer, and a timeline that turns clips into one video. It runs as a single process with a folder of data, on the PC itself or in a container on a server, and talks to ComfyUI over HTTP.

Afflatus is 0.2 and written for one person at a time. It is used every day on one machine; it has not yet been run on many.

## What you need

- **A ComfyUI**, 0.3.x or newer, that you can reach at an address. Afflatus does not bundle or install it. The desktop and portable builds work as well as a clone.
- **ComfyUI-Manager**, if you want Afflatus to download missing models into ComfyUI for you. ComfyUI has had it built in since 0.3.7x, off until asked: in ComfyUI's folder run `pip install -r manager_requirements.txt` with ComfyUI's own Python (the venv's, or `python_embeded` in the portable build), then start ComfyUI with `--enable-manager`. The desktop build has it on already. When ComfyUI listens on the network (`--listen`), Manager refuses downloads from a URL unless its `network_mode` is `personal_cloud`: set it in `user/__manager/config.ini` (the built-in Manager) or `custom_nodes/ComfyUI-Manager/config.ini` (the custom node) and restart ComfyUI. A ComfyUI that listens on localhost only needs nothing. Without Manager, missing models still get links that open in your browser.
- **Nothing else** on Windows and Linux: ffmpeg is in the bundle. On macOS, `brew install ffmpeg` once.
- Any card ComfyUI runs on. Afflatus assumes nothing about it: how long a render will take, and what the card can hold, it learns from your own renders and tells you on the form once it knows.

## Get started

1. Take the bundle for your system from the [releases page](https://github.com/bardak971/afflatus/releases), unpack it, start it (`Afflatus.bat` on Windows, `afflatus.sh` elsewhere), and open `http://127.0.0.1:8720`.
2. **Settings → ComfyUI.** Enter your ComfyUI's address (`http://127.0.0.1:8188` when it runs on the same machine) and press Test. It reads the version, the card and the node list; it never starts a render.
3. On the same page, give it **ComfyUI's folder** when it is on this computer (the one with `main.py`). With it, Afflatus writes its small node pack into ComfyUI's `custom_nodes` and reads your model files from the disk to tell what each one is. Restart ComfyUI once after that. When ComfyUI is on another machine, download the node pack from that page and unpack it into `custom_nodes` yourself.
4. **Settings → Models.** Every model family lists what is ready and what is missing, file by file, with the folder each goes in. Turn on "Download missing models" to get a Download button on each (this is where ComfyUI-Manager is needed; the page says so if it is not there), or paste a Civitai or Hugging Face address in "Download a model from a URL". Most files on Civitai are hidden without an account: paste your Civitai API key on the same page, under "Search Hugging Face and Civitai"; Afflatus fetches the file itself and hands it to ComfyUI-Manager, which needs no key. A family turns on by itself once one of its models is found.
5. **Settings → Designer**, if you want the prompt designer: any OpenAI-style address (LM Studio, Ollama or llama.cpp on this machine, or a service) and a model name. "Test it" tells you how fast it answers, whether it thinks before answering, and whether it reads pictures.
6. Press **Create** in the Studio, pick a model and an operation, write, Generate. The result lands in the library beside the form; its settings stay with it for good.

Step by step, per way of running it: [Windows, Linux and macOS](docs/install-desktop.md) · [Docker](docs/install-docker.md) · [Kubernetes with the Helm chart](docs/install-cluster.md) · [from the sources](docs/develop.md).

## What it does

**Studio** is the library and the place things are made. Folders and projects, a search over prompts and names, filters by kind, model and LoRA, and the Create shelf on the left: a form per model family with its defaults taken from ComfyUI's own templates and the models' authors, and the operations each family has (text to picture, picture to picture, inpainting, outpainting, upscaling, a face detailer, references of a person, variations). Several results at once with the seed kept, moved up or down, or random. Every file keeps the settings it was made with; a right-click on any tile gives everything that can be done with it, and the viewer opens it large with a compare mode for two takes side by side.

**Timelines** are videos made of clips that follow each other. A clip is a form of its own with several takes; the next clip can carry on from the one before, so the motion and the voices continue across the cut (for MiniMax H3 the join is made in the model's own latent, through the node pack, and the editor measures how clean each join came out). Pictures are held as stills or open a clip; a sound goes under a clip or under the whole video; a trim with scene detection; an export as one video with its colour matched across the cuts. The Media tab in the editor opens your whole library over the stage to drag from. A picture, a video or a selection in the Studio becomes a timeline in one click.

**Prompt kit** holds what you write once and use everywhere: people with their reference pictures, places, styles, snippets, and presets. A preset is an operation with its settings and the files it needs; the ones that ship with Afflatus say what is missing and fetch it through ComfyUI-Manager when you allow it.

**Workflows** are your own ComfyUI graphs, imported from the file the editor saves and used like any other form, with the inputs you mark as the form's fields.

**Queue** shows what is rendering with a live preview, what waits, what finished and what failed and why, with the model loads and the times per step kept as statistics; from those, each form says how long its render will take before you press the button.

**Settings** look after the machine: which models are ready, downloads, newer versions of your models on Civitai, the language model, the prompting guides the designer follows per family, appearance, storage and backups, and the start-up checks for the tools Afflatus needs.

### The model families

| Family | Models | Operations |
|---|---|---|
| SDXL | any SDXL checkpoint: Illustrious, NoobAI, Pony, Juggernaut XL and the rest | text to picture, redraw, paint over, outpaint, upscale, face detailer |
| FLUX.2 Klein | the 4B base and its fine-tunes | picture, edit by instruction, variation, paint over, outpaint, upscale, face detailer |
| Krea 2 | | picture, redraw, paint over, upscale, face detailer |
| FLUX.1 | dev and Kontext | picture, edit, redraw, paint over, outpaint, upscale, face detailer |
| Qwen Image | 2512, and Qwen Image Edit | picture, edit, redraw, paint over, outpaint, upscale, face detailer |
| Qwen Image 2.1 | | picture, edit |
| MiniMax H3 | video with sound: text, a first frame, first and last frames, references, a clip that carries on | the timeline's native model |
| Wan 2.2 | | video |
| LTX 2.3 | | video |
| Image tools | SeedVR2, background removal | upscale and restore, remove the background |

The default files of each family come from ComfyUI's own repackaged releases on Hugging Face, so the download buttons point there. The Models page recognises a model file from its weights, not only its name, so a renamed file is still placed with its family.

### Node packs it uses

Everything above runs on ComfyUI's own nodes, plus:

- **Afflatus's node pack**, written into ComfyUI by Settings or unpacked by hand: MiniMax H3 clips that continue from the clip before's own latent, and the reading of model files through ComfyUI. MIT, in [comfy-nodes](comfy-nodes).
- **ComfyUI-Manager**, for downloads, as above, and for the node packs an imported workflow needs: the import lists what your ComfyUI lacks, pack by pack, with one button that has Manager install them and another that restarts ComfyUI once they are in.
- Optional, each used only when present and said so in Settings when missing: the **Impact pack** for the face detailer, a **RIFE** model in `models/frame_interpolation` for 48 fps videos, **SeedVR2** for the restoring upscale, the **MiniMax H3 pack by DaSiWa** for the step cache, the re-sampled latent upscale and RTX Video Super Resolution (NVIDIA's own node does for the last), and **KJNodes** for the live preview of a video while it renders.

## Running it

| Platform | How |
|---|---|
| Windows | Unzip `afflatus-<version>-win-x64.zip`, double-click `Afflatus.bat`. ffmpeg is inside. |
| Linux | `tar xzf afflatus-<version>-linux-x64.tar.gz` and run `afflatus.sh`. ffmpeg is inside. |
| macOS (Apple Silicon) | `tar xzf afflatus-<version>-darwin-arm64.tar.gz` and run `afflatus.sh`. Install ffmpeg once with `brew install ffmpeg`. |
| Docker | `docker run -p 8720:8720 -v afflatus-data:/data ghcr.io/bardak971/afflatus:latest`, or `docker compose up -d` with the [compose.yaml](compose.yaml) of this repository. ffmpeg is in the image. |
| Kubernetes | The Helm chart in [chart](chart); see [the guide](docs/install-cluster.md). |

The image is `ghcr.io/bardak971/afflatus`, tagged like the release and `latest`, for `linux/amd64` and `linux/arm64`. Your data (library, settings, timelines) lives in a `data` folder next to the launcher, or in the `/data` volume. Updating is unpacking the next release over the old one, or pulling the next image; the database migrates itself at start. A backup is one zip from Settings → Storage.

When Afflatus runs on another machine than ComfyUI (a server with ComfyUI on your PC), ComfyUI must listen on the network (`--listen`), and Afflatus needs `PUBLIC_URL` set to the address ComfyUI can reach it at, so that ComfyUI-Manager can fetch downloads through it.

Nothing leaves your computer unless you turn on a download or a lookup. There is no account and no password: Afflatus listens on localhost unless told otherwise, and is meant to be reached on your own machine or network, behind whatever you already use to reach the rest of it.

### From the sources

Needs Node 22.16 or newer and [ffmpeg](https://ffmpeg.org) on the PATH (or named by `FFMPEG` and `FFPROBE`). Without ffmpeg the library and the designer work; trims, exports, joins and video previews do not.

```
corepack pnpm install
corepack pnpm build
corepack pnpm start
```

To try it without a GPU, `corepack pnpm demo` runs the same app against a pretend ComfyUI and a pretend language model, with its own data in `./data-demo`: a render takes a few seconds and gives a coloured placeholder.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8720` | Port to listen on |
| `HOST` | `127.0.0.1` | Address to listen on; the image listens on all |
| `DATA_DIR` | `./data` | Where the database and the files live |
| `PUBLIC_URL` | empty | The address ComfyUI reaches Afflatus at, when they are on different machines |
| `ALLOWED_HOSTS` | empty | Extra host names Afflatus answers to, when it is reached by a name of your own |
| `DATABASE_URL` | empty | A `postgres://` address instead of SQLite. SQLite is the supported one; Postgres is written and not yet exercised |
| `FFMPEG`, `FFPROBE` | from the PATH | The tools' paths |

## Develop

```
corepack pnpm dev            # the server, restarted on change
corepack pnpm dev:web        # the web app on port 8721, with hot reload
corepack pnpm test           # the tests (ffmpeg needed for the video ones)
corepack pnpm typecheck
corepack pnpm check:graphs   # builds every recipe variant and checks it against reference/comfy-object-info.json
```

Three scripts talk to a ComfyUI, all read-only: `comfy:scan <url>` (what is ready), `comfy:load <url>` (the machine's load), `catalog:save <url>` (refresh the reference node list, with model file names removed).

A release is a tag: `git tag v0.2.0 && git push --tags` runs the tests, builds the image and the three bundles, and publishes a GitHub release with them ([.github/workflows/release.yml](.github/workflows/release.yml)). The staging and packing scripts are in [scripts/release](scripts/release). How the parts fit, the conventions and the checks are in [docs/develop.md](docs/develop.md); the design notes are in [docs](docs) too: the architecture, the prompting research behind the designer's guides, and the plans of the larger parts.

## License

[AGPL-3.0](LICENSE). The node pack for ComfyUI in [comfy-nodes](comfy-nodes) is MIT and vendors the MIT continuation nodes by ttulttul; the ffmpeg builds in the Windows and Linux bundles are the LGPL builds by BtbN. The shipped presets in [presets](presets) point at other people's models under their own licences, accepted once before a download; nothing of theirs is bundled.
