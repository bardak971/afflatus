<h1 align="center">Afflatus</h1>

<p align="center">
  A self-hosted studio for pictures, videos and timelines, in front of your own <a href="https://github.com/Comfy-Org/ComfyUI">ComfyUI</a>.
</p>

<p align="center">
  <a href="https://github.com/bardak971/afflatus/releases"><img alt="Release" src="https://img.shields.io/github/v/release/bardak971/afflatus?include_prereleases&color=4c8bf5"></a>
  <a href="LICENSE"><img alt="Licence: AGPL-3.0" src="https://img.shields.io/badge/licence-AGPL--3.0-4c8bf5"></a>
  <a href="https://github.com/bardak971/afflatus/pkgs/container/afflatus"><img alt="Docker image" src="https://img.shields.io/badge/docker-ghcr.io%2Fbardak971%2Fafflatus-4c8bf5"></a>
</p>

https://github.com/user-attachments/assets/9e85650c-22e3-4760-8702-def37fc205d6

<p align="center"><sub>Everything in this video was made in Afflatus, the logo included. The snowboard film at the start: Krea 2 key frames, a MiniMax H3 chain, one Finish pass. <a href="https://github.com/user-attachments/assets/b6105eed-b0c0-4cbf-8c7b-d802b07bf342">Watch the film on its own</a>.</sub></p>

ComfyUI keeps running where your GPU is. Afflatus is the place you work in: a library of everything you make, a form per model with the right settings already in it, and a timeline that turns clips into one video. One process and a folder of data, on your PC or in a container on a server, talking to ComfyUI over HTTP.

## Why Afflatus

- **Your ComfyUI, your models.** Nothing is bundled and nothing runs in the cloud. Afflatus drives the ComfyUI you already have, with its node packs and model folders.
- **A library that remembers.** Every picture and clip keeps the exact settings it was made with: open any of them, change one thing, render again.
- **Forms with sensible defaults.** One per model family (SDXL, FLUX.2 Klein, Krea 2, Qwen Image, MiniMax H3, Wan 2.2, LTX 2.3…), with defaults taken from ComfyUI's own templates and the models' authors, and the operations each family has: txt2img, img2img, inpaint, outpaint, upscale, face detailer, edit by instruction.
- **Timelines with seamless joins.** MiniMax H3 clips carry on from the clip before's own latent and are decoded as one piece with it, so motion and sound carry on across the cut. Then one **Finish** pass brings the whole video to its final size.
- **Anyone's workflow as a form.** Import a ComfyUI workflow file: Afflatus reads it, puts the author's own controls on a form, and names the node packs and models it is missing.
- **It measures what it makes.** Every take is scored: how clean its join is, how its brightness, sharpness and pace compare with the clips around it. The timeline points out the joins that jump and the takes that would join more cleanly; which take makes the better clip stays your call.
- **It learns your machine.** Render times are measured on your own renders, broken down by model and phase, so each form tells you how long the next one will take before you press Generate.

## Quick start

1. **Download** the bundle for your system from the [releases page](https://github.com/bardak971/afflatus/releases), unpack it and start it (`Afflatus.bat` on Windows, `afflatus.sh` on Linux and macOS). Your browser opens on `http://127.0.0.1:8720`.
2. **Settings → ComfyUI:** enter your ComfyUI's address (`http://127.0.0.1:8188` on the same machine) and press Test. Give it ComfyUI's folder too, so it can install its node pack.
3. **Settings → Models** shows what is ready and what is missing for each model family. Then press **Create** in the Studio.

Full guides: [Windows, Linux and macOS](docs/install-desktop.md) · [Docker](docs/install-docker.md) · [Kubernetes](docs/install-cluster.md) · [ComfyUI setup](docs/comfyui-setup.md) · [from the sources](CONTRIBUTING.md)

Then: [using Afflatus](docs/guide.md) · [configuration](docs/configuration.md) · [troubleshooting](docs/troubleshooting.md)

> [!WARNING]
> **There is no login.** Whoever can reach Afflatus's port can use your library, your settings and your GPU. It listens on localhost unless told otherwise. Never publish it to the internet as it is: put a reverse proxy with its own authentication in front. See [SECURITY.md](SECURITY.md).

## A tour

### Studio

<img src="docs/media/studio.webp" alt="The Studio: a draft's form beside the project's library" width="100%">

The library and the place things are made. Folders and projects, search over prompts and names, filters by kind, model and LoRA. The Create shelf holds a form per model family; results land beside it and keep their settings for good. Right-click any tile for everything that can be done with it, or open it large and compare two takes side by side.

### Projects

<img src="docs/media/projects.webp" alt="The Projects panel: projects, their folders and drafts, with what each holds, when it started and its size" width="100%">

Work is grouped in projects, each with its folders, drafts and timelines, and an Inbox for what belongs nowhere yet. The panel shows what each one holds, when it was started and what it weighs on disk. Whatever a draft or a timeline makes lands in its folder. Renders you do not keep go to the bin after a day and the bin empties itself after a week, so the library holds what you chose and nothing piles up.

### Prompt kit

<img src="docs/media/kit.webp" alt="A person in the Prompt kit: reference pictures, tags and a sentence, a LoRA per model, outfits" width="100%">

People, places, styles and snippets, written once and used with every model. A person is a few reference pictures, how they look as tags and as a sentence, a LoRA per model when there is one, and outfits. Put them in a draft or a whole timeline and each model gets them the way it reads them: tags for SDXL, a sentence and reference pictures for Krea 2 or MiniMax H3. Presets keep a whole setup.

### Command bar

<img src="docs/media/bar.webp" alt="The Ctrl+K bar finding a draft and a render, with a preview" width="100%">

**Ctrl+K** finds anything across projects (drafts, renders, timelines, people, settings) with a preview of each, and runs commands from the keyboard: queue and reorder jobs, flip a setting, bring back an earlier prompt, work out frames and seconds.

### Timeline

<img src="docs/media/timeline.webp" alt="The timeline editor with a seamless MiniMax H3 chain" width="100%">

Videos made of clips that follow each other. A clip is a form of its own with several takes, and the next clip can carry on from the one before, so motion and sound continue across the cut. For MiniMax H3 the join is made in the model's own latent and decoded as one piece, and the editor measures how clean each join came out. Trims with scene detection, ranges, undo and redo, pictures held as stills, a music track that ducks under speech, and an export as one video with its colour matched across the cuts.

### What it measures

<img src="docs/media/insight.webp" alt="A clip's takes with their join figures, and its look against the clips before and along the run" width="100%">

Generation is only half the job. Every take is measured: how clean its join with the clip before is, its run-up, and its brightness, sharpness and pace against the other clips. The timeline points out the joins that jump and which takes would join more cleanly; whether that take is the better clip is yours to judge. Nothing is guessed: the figures come from the frames.

### Finish

<img src="docs/media/finish.webp" alt="The Finish dialog" width="100%">

Brings every clip of a timeline to its final size in one go: SeedVR2 (restore and enlarge), RTX Video Super Resolution, an upscale model, or for H3 a re-sample of the draft's own latent that keeps the motion and the seamless joins. A finished take stands in for its draft: same frames, same timing.

### Workflows

<img src="docs/media/import.webp" alt="Importing a ComfyUI workflow" width="100%">

Your own ComfyUI graphs, imported from the file the editor saves and used like any other form. The importer puts forward what the workflow's author put forward, turns their switches into toggles, finds where LoRAs go, and installs missing node packs through ComfyUI-Manager.

### Queue

<img src="docs/media/queue.webp" alt="Render times in the queue" width="100%">

What is rendering, with a live preview; what waits, what finished, what failed and why. Render times break the GPU's time down by model and phase, chart upscale speeds, and flag jobs that ran out of video memory.

### Settings → Models

<img src="docs/media/models.webp" alt="Settings: what each model family has ready or missing" width="100%">

What each family has ready and what is missing, file by file, with the folder each goes in and a Download button through ComfyUI-Manager. Model files are recognised by their weights, not only their names.

Also in the app: an optional **prompt designer** that writes prompts by each family's guide through any OpenAI-style language model (LM Studio, Ollama, llama.cpp or a service).

## What you need

- **ComfyUI** 0.3.x or newer, reachable at an address: a clone, the portable build or the desktop app. Afflatus does not install it.
- **ComfyUI-Manager**, if you want Afflatus to download missing models for you. It is built into recent ComfyUI and needs turning on: see [ComfyUI setup](docs/comfyui-setup.md#comfyui-manager-for-downloads).
- **ffmpeg**: in the Windows and Linux bundles and the Docker image. On macOS, `brew install ffmpeg` once.
- **Any card ComfyUI runs on.** Afflatus assumes nothing about it and learns speed and fit from your own renders.

### Model families

| Family | Models | Operations |
|---|---|---|
| SDXL | any SDXL checkpoint: Illustrious, NoobAI, Pony, Juggernaut XL… | txt2img, img2img, inpaint, outpaint, upscale, face detailer |
| FLUX.2 Klein | 4B base and its fine-tunes | txt2img, edit by instruction, variation, inpaint, outpaint, upscale, face detailer |
| Krea 2 | Turbo and its fine-tunes | txt2img, img2img, inpaint, upscale, face detailer |
| FLUX.1 ¹ | dev, Kontext | txt2img, edit, img2img, inpaint, outpaint, upscale, face detailer |
| Qwen Image ¹ | 2512, Qwen Image Edit | txt2img, edit, img2img, inpaint, outpaint, upscale, face detailer |
| Qwen Image 2.1 | | txt2img, edit |
| MiniMax H3 | video with sound | text, first frame, first and last frames, references, continuation: the timeline's native model |
| Wan 2.2 | | video |
| LTX 2.3 | | video |
| Image tools | SeedVR2, background removal | restore and upscale, remove the background |

¹ Built from the model cards and not yet run against the models.

The default files of each family are ComfyUI's own repackaged releases on Hugging Face. Some forms and options need a custom node pack on top of ComfyUI's own nodes; when one is missing, Afflatus says which and how to install it. The [list of node packs](docs/comfyui-setup.md#node-packs) says what each one unlocks.

### Model licences

The models are other people's work under their own licences, which you accept when you download them, not Afflatus. The shipped presets name and link models and bundle nothing; each shows its licence and asks you to accept it once before the first download. Read them: several are community licences with a revenue ceiling for commercial use and an acceptable-use policy, and **MiniMax H3's licence does not grant its use in the European Union, the United Kingdom, South Korea or the United States** (its "Excluded Territories"). It also asks that machine-made content shown in public be disclosed as such.

## Running it

| Platform | How |
|---|---|
| Windows | Unzip `afflatus-<version>-win-x64.zip`, double-click `Afflatus.bat` |
| Linux ² | `tar xzf afflatus-<version>-linux-x64.tar.gz`, run `afflatus.sh` |
| macOS, Apple Silicon ² | `tar xzf afflatus-<version>-darwin-arm64.tar.gz`, run `afflatus.sh`; `brew install ffmpeg` once |
| Docker | `docker run -p 127.0.0.1:8720:8720 -v afflatus-data:/data ghcr.io/bardak971/afflatus:latest`, or the [compose.yaml](compose.yaml) ([guide](docs/install-docker.md)) |
| Kubernetes | the Helm chart in [chart/](chart) ([guide](docs/install-cluster.md)) |
| From the sources | Node 22.16+ and ffmpeg: `corepack pnpm install && corepack pnpm build && corepack pnpm start` |

² The Linux and macOS bundles are built by the release workflow but have not yet been started on a real machine. Reports welcome.

Your data (library, settings, timelines) lives in the `data` folder next to the launcher, or in the `/data` volume. To update, unpack the next release over the old one or pull the next image; the database migrates itself at start. A backup is one zip from Settings → Storage. Environment variables (port, host, data folder, allowed host names, Postgres) are listed in [Configuration](docs/configuration.md).

To try it without a GPU: `corepack pnpm demo` runs the real app against a pretend ComfyUI, with its own data in `./data-demo`.

## Status

Afflatus is 0.x and made for one person at a time. It is used every day on one machine and has not yet run on many. Expect rough edges, and expect things to change between minor versions. What changed in each release is in the [changelog](CHANGELOG.md).

## Contributing

Bug reports, fixes and new model families are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the setup, the checks and the conventions, and the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems go through [private reporting](SECURITY.md).

## Licence and credits

Afflatus is under [AGPL-3.0](LICENSE). Its node pack for ComfyUI in [comfy-nodes](comfy-nodes) is MIT.

- [ComfyUI](https://github.com/Comfy-Org/ComfyUI), which does all the rendering.
- The node pack vendors the MIT continuation nodes of ttulttul's [ComfyUI-Minimax-H3-Continuation](https://github.com/ttulttul/ComfyUI-Minimax-H3-Continuation), with one small change (a guarded import).
- The authors of the node packs listed in [ComfyUI setup](docs/comfyui-setup.md#node-packs).
- The shipped presets point at the official model releases (Krea, MiniMax, Wan, Lightricks) on Hugging Face; each names its maker and its licence. Nothing of theirs is bundled.
- The ffmpeg builds in the Windows and Linux bundles are the LGPL builds by [BtbN](https://github.com/BtbN/FFmpeg-Builds).
- Every release carries `THIRD_PARTY_NOTICES.txt`: the npm packages and fonts it ships, with their licences.
