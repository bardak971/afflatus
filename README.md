# studai

A self-hosted studio for pictures, videos and timelines, in front of your own [ComfyUI](https://github.com/comfyanonymous/ComfyUI).

**Status: early.** Two built-in recipes (SDXL words to picture, MiniMax H3 video with sound) and your own imported ComfyUI workflows work from the form to the library, with a queue and live progress. There is a first timeline editor: clips that carry on from each other, takes, and export as one video. SDXL and imported workflows have rendered on a real ComfyUI; the built-in H3 recipe and the timeline have only run against a pretend one so far. The design, including what is still to come (characters, more built-in models, the rest of the timeline), is in [docs/architecture.md](docs/architecture.md).

## What it will be

- A library of everything you make, a composer where you pick the model first, and a movie-maker style timeline for video.
- Works with any model family ComfyUI can run. Built-in recipes cover the common ones; your own ComfyUI workflows can be imported and used like any other model.
- Runs on one PC (SQLite, files in a folder, one process) or on a cluster (Postgres, S3).
- It connects to a ComfyUI you already run. It does not install or bundle ComfyUI.

## What exists today

| Part | Where | State |
|---|---|---|
| Recipe contract: inputs, graph builder, graph checker | `packages/core` | Tested |
| SDXL "words to picture" recipe, with hi-res fix | `packages/recipes` | Graphs checked against a ComfyUI node catalog. Rendered on a real ComfyUI, with hi-res fix and a LoRA |
| Things done to a picture you have. SDXL: redraw it, paint over a part, twice as large, fix the faces. FLUX.2 Klein: a picture from sentences and reference pictures, change a picture from an instruction, a variation of a picture, paint over a part, another shape, twice as large, fix the face (two faces, each from its own person's pictures). Remove the background | `packages/recipes`, the mask painter in the form, "Change this picture" in the viewer | Graphs checked against a ComfyUI node catalog. Each one rendered on a real ComfyUI, except the variation and the two-faces fix. The face fixes need the Impact Pack nodes |
| MiniMax H3 "video with sound" recipe: from words, a first and a last picture, a picture it passes through, people and places from reference pictures, a voice, carrying on from another clip, arriving at another clip | `packages/recipes` | Graphs checked against a ComfyUI node catalog. Rendered on a real ComfyUI: a plain clip, a clip that flows on, a redo fitted to the next clip, an opening picture with a picture on the way, a reference picture. A voice sample was not |
| Timelines: clips in order, each can flow on from the one before; takes; a join that went stale is marked and redone on request; stills, pictures a clip opens or ends on, a sound per clip, music, undo; export as one video, enlarged and with smoother motion if wanted | `apps/server`, the Timelines screens | Tested against a pretend ComfyUI, with real ffmpeg cuts. Two real H3 clips were joined, one redone to fit the other, and exported. Needs ffmpeg on the machine studai runs on |
| Importing your own ComfyUI workflow as a recipe (reading it, mapping its inputs, running it) | `packages/workflows`, the Workflows screen | Works from the screen against a pretend ComfyUI. Reads the file ComfyUI's editor saves (group nodes, switched-off parts, switches) or an exported one. One large community Wan 2.2 workflow was imported from its editor file and rendered on a real ComfyUI, with and without one of its switches |
| Getting a missing model file into ComfyUI, when turned on: from the address a workflow gives or from Civitai, saved by ComfyUI-Manager, with a progress bar | `apps/server/src/downloads.ts`, Setup and the import screen | Tested against a pretend ComfyUI-Manager and a pretend Civitai. Never run against the real ones |
| Dropping a file from the computer anywhere: add it to the library, use the settings stored in a picture, import the workflow a ComfyUI picture or video carries, put it on the open timeline | `apps/web/src/DropTray.tsx`, `apps/server/src/embedded.ts` | Tested with made-up files and scripted drags against a pretend ComfyUI |
| ComfyUI client and "what can this ComfyUI do" scan | `packages/comfy` | Tested against a fake ComfyUI. The read-only part was also run against a real one |
| Live progress, previews and the machine's load (CPU, memory, GPU, temperature) | `packages/comfy` | Tested against a fake ComfyUI. The load feed was also read from a real one |
| Server: settings, setup scan, queue (pause, cancel, retry, resume after a restart), library with thumbnails, drafts, live events, clean-up of unkept results; SQLite | `apps/server` | Tested on SQLite with a fake ComfyUI. The Postgres path is written and untested |
| People, places, styles, presets: written once, worked into any model's form (words, LoRAs, reference pictures, a voice) | `apps/server`, the People screen | Tested against a pretend ComfyUI |
| The prompt designer: a conversation with a language model of your choice (any OpenAI-style address) that writes and improves prompts, and plans a scene as clips | `apps/server`, the designer panel | Tested against a pretend language model only |
| Web app: Library, Create, Timelines, People, Workflows, Queue, Setup | `apps/web` | Checked by hand in a browser against the pretend ComfyUI. No automated tests yet |

## Try it without a GPU

```
corepack pnpm install
corepack pnpm build
corepack pnpm demo
```

Open `http://127.0.0.1:8720`. This is the real app with a pretend ComfyUI behind it: a render takes a few seconds and gives a coloured placeholder (a test pattern with a tone for a video, when ffmpeg is installed). The designer answers too, from a pretend language model that only repeats what it is told. It never contacts a real ComfyUI or a real language model, and keeps its data in `./data-demo`.

## Run it

Needs Node 22.16 or newer. No compiler and no other service. [ffmpeg](https://ffmpeg.org) is optional for pictures and single videos (without it, videos have no preview frame) and needed for timelines: joining clips and exporting are done with it. It is found on the PATH, or named by `FFMPEG` and `FFPROBE`.

```
corepack pnpm install
corepack pnpm build
corepack pnpm start
```

Open `http://127.0.0.1:8720`, go to Setup, and enter the address of your ComfyUI. Data is kept in `./data`.

While working on the web app, `corepack pnpm dev` (server) and `corepack pnpm dev:web` (Vite on port 8721, with hot reload) replace `build` and `start`.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8720` | Port to listen on |
| `HOST` | `127.0.0.1` | Address to listen on. Localhost only by default |
| `DATA_DIR` | `./data` | Where the SQLite database and files live |
| `DATABASE_URL` | empty | A `postgres://` address. Empty means SQLite |

## Develop

```
corepack pnpm test           # unit tests
corepack pnpm typecheck      # TypeScript
corepack pnpm check:graphs   # builds every recipe variant and checks it against reference/comfy-object-info.json
```

`check:graphs` needs no GPU and no ComfyUI. Give it a ComfyUI address to check against a live install instead; it only reads the node list.

Three more scripts talk to a ComfyUI, all read-only (they never queue a job or load a model):

```
corepack pnpm comfy:scan http://127.0.0.1:8188     # what is ready and what is missing
corepack pnpm comfy:load http://127.0.0.1:8188     # CPU, memory, GPU load and temperature of that machine
corepack pnpm catalog:save http://127.0.0.1:8188   # refresh the reference node list, with file names removed
```

## License

[AGPL-3.0](LICENSE).
