# Developing Afflatus

## Run it from the sources

Needs Node 22.16 or newer (24 is what the releases ship) and ffmpeg on the PATH. pnpm comes through corepack.

```
corepack pnpm install
corepack pnpm build        # the web app, served by the server
corepack pnpm start        # http://127.0.0.1:8720
```

While working on it:

```
corepack pnpm dev          # the server, restarted on change
corepack pnpm dev:web      # the web app on 8721 with hot reload, its /api proxied to 8720
```

Without a GPU, `corepack pnpm demo` runs the real app against a pretend ComfyUI and a pretend language model, with its own data in `./data-demo`: a render takes a few seconds and gives a coloured placeholder. The web app for the demo is built with `vite build apps/web --outDir dist-demo`.

## The parts

| Folder | What |
|---|---|
| `packages/core` | The recipe contract: inputs, the graph builder, the graph checker, what a model file says about itself |
| `packages/recipes` | The built-in forms per model family (SDXL, FLUX.1, Klein, Krea 2, Qwen, MiniMax H3, Wan 2.2, LTX 2.3), each with its prompting guide |
| `packages/comfy` | The ComfyUI client, the scan of what a ComfyUI can do, the monitor, a pretend ComfyUI for the tests, the architecture detector |
| `packages/workflows` | Reading a ComfyUI workflow file and running it as a form |
| `apps/server` | Fastify: the library, the queue, the timelines, the designer, the settings, the downloads; SQLite through Node's own `node:sqlite` |
| `apps/web` | React: Studio, Timelines, Prompt kit, Workflows, Queue, Settings |
| `comfy-nodes/afflatus-nodes` | The ComfyUI node pack (MIT): H3 latent save/load and continuation, the header route |
| `presets/` | The presets that ship, with the files they need |
| `scripts/release` | Staging and packing a release |

## Checks

```
corepack pnpm test           # vitest; the video tests need ffmpeg
corepack pnpm typecheck
corepack pnpm check:graphs   # every recipe variant built and checked against reference/comfy-object-info.json
```

The tests never touch a real ComfyUI: a pretend one answers in-process. `reference/comfy-object-info.json` is a ComfyUI node catalog with the model file names removed; refresh it with `corepack pnpm catalog:save http://127.0.0.1:8188`, which refuses to save if a file name is still in it.

Three read-only scripts talk to a ComfyUI: `comfy:scan <url>` (what is ready), `comfy:load <url>` (the machine's load), `catalog:save <url>`.

## Conventions

- Every label, note and message in the app is written for a power user of A1111 and ComfyUI: the real words, the long explanation behind the `?`.
- A form's defaults come from ComfyUI's own templates and the model authors' recommendations, and say where they come from.
- Nothing is sent anywhere unless the user asked for a download or a lookup; every such switch is off until turned on.
- A recipe's graph is checked against the node catalog in the tests; the recipe tests never need a GPU.

## Releasing

A release is a tag:

```
git tag -a v0.2.0 -m "Afflatus 0.2.0"
git push origin v0.2.0
```

[release.yml](../.github/workflows/release.yml) then runs the tests, builds the image for amd64 and arm64 and pushes it to GHCR tagged `0.2.0`, `0.2`, `latest` and by commit, builds the three bundles on Windows, Linux and macOS runners, and publishes a GitHub release with them and their checksums. The version the app shows comes from the tag. [ci.yml](../.github/workflows/ci.yml) runs the types, the tests and the staging on every push.

To build what a release holds on your own machine: `node scripts/release/stage.mjs` stages the app under `release/app`, and `node scripts/release/bundle.mjs --platform win-x64` (or `linux-x64`, `darwin-arm64`) packs it with a Node runtime and ffmpeg into `release/dist/`. The Docker image builds with `docker build -t afflatus .`.

## Licence

AGPL-3.0. The node pack is MIT and vendors MIT nodes by ttulttul; the ffmpeg builds in the Windows and Linux bundles are BtbN's LGPL builds.
