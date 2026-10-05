# Afflatus

A self-hosted studio for pictures, videos and timelines, in front of your own [ComfyUI](https://github.com/comfyanonymous/ComfyUI).

You keep running ComfyUI where your GPU is. Afflatus is the place you work in: a library of everything you make, a form per model with the right settings already in it, a prompt designer, and a timeline that turns clips into one video. It runs on one PC as a single process with a folder of data, or in a container on a server, and talks to ComfyUI over HTTP.

## What it does

- **Built-in forms** for the common model families, each with its defaults taken from ComfyUI's own templates and the models' authors: SDXL (Illustrious, NoobAI, Pony and the rest), FLUX.1 and Kontext, FLUX.2 Klein, Krea 2, Qwen Image and Qwen Image 2.1, MiniMax H3 (video with sound), Wan 2.2 and LTX 2.3. Text to picture, picture to picture, inpainting, outpainting, upscaling, face fixes, reference pictures, video from a first and a last frame, continuation of a clip.
- **Your own ComfyUI workflows**, imported from the file the editor saves and used like any other form.
- **A timeline**: clips that carry on from each other, several takes per clip, joins made in the model's latent for MiniMax H3 (through a small node pack Afflatus installs into ComfyUI), stills, music, a trim with scene detection, and an export as one video.
- **A library** with folders and projects, where every file keeps the settings it was made with, and where a model file is recognised from its weights, not only its name.
- **A prompt designer**: a conversation with a language model of your choice (any OpenAI-style address, local or not) that writes in each model's own idiom, with the model's rules and one example as its guide, and checks what it wrote against them.
- **People, places, styles and presets**, written once and worked into any model's form; presets that ship with the files they need and say what is missing, and fetch them through ComfyUI-Manager when you allow it.
- **Settings that look after the machine**: which models are ready and what is missing, downloads from Civitai and Hugging Face, newer versions of your models, the start-up checks for the tools Afflatus needs.

Nothing leaves your computer unless you ask for a download or a lookup. There is no account and no password: Afflatus is meant to be reached on your own machine or network, behind whatever you already use to reach the rest of it.

## Run it

Each release ships ready to run. Unpack, start, open `http://127.0.0.1:8720`, and give it the address of your ComfyUI in Settings.

| Platform | How |
|---|---|
| Windows | Unzip `afflatus-<version>-win-x64.zip`, double-click `Afflatus.bat`. ffmpeg is inside. |
| Linux | `tar xzf afflatus-<version>-linux-x64.tar.gz` and run `afflatus.sh`. ffmpeg is inside. |
| macOS (Apple Silicon) | `tar xzf afflatus-<version>-darwin-arm64.tar.gz` and run `afflatus.sh`. Install ffmpeg once with `brew install ffmpeg`. |
| Docker | `docker run -p 8720:8720 -v afflatus-data:/data ghcr.io/bardak971/afflatus:latest`, or `docker compose up -d` with the [compose.yaml](compose.yaml) of this repository. ffmpeg is in the image. |

The releases are on the [releases page](https://github.com/bardak971/afflatus/releases); the image is `ghcr.io/bardak971/afflatus`, tagged like the release and `latest`, for `linux/amd64` and `linux/arm64`. Your data (library, settings, timelines) lives in a `data` folder next to the launcher, or in the `/data` volume. Updating is unpacking the next release over the old one, or pulling the next image; the data stays.

**ComfyUI** is not bundled and is not installed by Afflatus. It needs a ComfyUI of 0.3.x or newer, reachable at an address you give it. When ComfyUI's folder is on the same computer, Afflatus also installs its node pack there (for MiniMax H3 continuations in the latent) and reads model files from the disk to tell what they are; when ComfyUI is elsewhere, copy the node pack from [comfy-nodes](comfy-nodes) into its `custom_nodes` folder by hand; model files are then told by their names (a download of the pack from Settings, and the detection through the pack, are the next step).

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

A release is a tag: `git tag v0.1.0 && git push --tags` runs the tests, builds the image and the three bundles, and publishes a GitHub release with them ([.github/workflows/release.yml](.github/workflows/release.yml)). The staging and packing scripts are in [scripts/release](scripts/release).

Step by step, per way of running it: [Windows, Linux and macOS](docs/install-desktop.md) · [Docker](docs/install-docker.md) · [Kubernetes with the Helm chart](docs/install-cluster.md) · [from the sources, and contributing](docs/develop.md). The design notes are in [docs](docs) too: the architecture, the prompting research behind the designer's guides, and the plans of the larger parts.

## License

[AGPL-3.0](LICENSE). The node pack for ComfyUI in [comfy-nodes](comfy-nodes) is MIT and vendors the MIT continuation nodes by ttulttul; the ffmpeg builds in the Windows and Linux bundles are the LGPL builds by BtbN.
