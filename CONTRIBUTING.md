# Contributing to Afflatus

Thanks for wanting to help. Bug reports, fixes, new model families, better defaults and docs are all welcome. For anything larger than a fix, open an issue first so we can agree on the shape before you spend the time.

## Setting up

You need Node 22.16 or newer (the releases ship 24), and [ffmpeg](https://ffmpeg.org) on the `PATH`. pnpm comes through corepack.

```
corepack pnpm install
corepack pnpm dev          # the server on 8720, restarted on change
corepack pnpm dev:web      # the web app on 8721 with hot reload, its /api proxied to 8720
```

**No GPU?** `corepack pnpm demo` runs the real app against a pretend ComfyUI and a pretend language model, with its own data in `./data-demo`. A render takes a few seconds and gives a coloured placeholder. That covers most of the UI, the queue, the importer and the timeline editor.

## Checks

Run these before opening a pull request. CI runs the same ones.

```
corepack pnpm typecheck
corepack pnpm test           # vitest; the video tests need ffmpeg
corepack pnpm check:graphs   # every recipe variant built and checked against reference/comfy-object-info.json
corepack pnpm build && corepack pnpm check:player   # the timeline player, frame by frame in headless Chrome
pytest -q comfy-nodes/afflatus-nodes/tests          # the node pack, when you touched it
```

The tests never touch a real ComfyUI: a pretend one answers in-process. A recipe test never needs a GPU.

## Where things are

| Folder | What |
|---|---|
| `packages/core` | The recipe contract: input types, the graph builder, the graph checker |
| `packages/recipes` | The built-in forms, one folder per model family, each with its prompting guide |
| `packages/comfy` | The ComfyUI client, the capability scan, the progress monitor, the pretend ComfyUI |
| `packages/workflows` | The importer: a ComfyUI workflow file read into a form |
| `apps/server` | Fastify: library, queue, timelines, designer, settings, downloads, SQLite or Postgres |
| `apps/web` | React: Studio, Timelines, Prompt kit, Workflows, Queue, Settings |
| `comfy-nodes/afflatus-nodes` | The ComfyUI node pack (Python, MIT) |
| `presets/` | The presets that ship |

[docs/architecture.md](docs/architecture.md) explains how the parts fit, and [docs/develop.md](docs/develop.md) covers releases and the bundles.

**Adding a model family** is mostly a folder in `packages/recipes/src/`: a `family.ts` (model slots, how to detect files, the prompting guide) and recipes that build a graph from the form's inputs. Take the defaults from ComfyUI's own templates and the model authors' recommendations, and say where each comes from. The web app never names a family; only a new input type touches it.

## Conventions

- **Comments** are plain, full sentences that say *why*, not what.
- **UI wording** uses the real terms a ComfyUI or A1111 user knows (CFG, denoise, sampler, LoRA, latent). The plain explanation goes in the `?` tooltip beside the setting.
- **No hard-coded card figures.** Never write "needs 12 GB" or decide anything from a VRAM threshold. Speed and fit are learned from the user's own renders.
- **Every route validates its input with zod.**
- **ffmpeg and other tools** are called with `execFile` and an argument array, never through a shell.
- **Nothing is sent anywhere** unless the user turned on a download or a lookup.
- **Line endings:** keep each file's own. A whole-file diff from line endings will be asked to be redone.

## Other people's files

- **Never commit other people's ComfyUI workflows, models, LoRAs or renders.** The importer's corpus is local and gitignored; test fixtures are made by hand for the test.
- Check your diff for private paths, addresses and names before pushing.

## Pull requests

- One change per pull request, with what it does and why.
- Include a test when you fix a bug or add a recipe.
- For a UI change, a screenshot (dark theme, from `pnpm demo` is fine).
- Add a line under `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for anything a user would notice.

## Licence

Afflatus is under [AGPL-3.0](LICENSE). By contributing, you agree that your contribution is licensed under AGPL-3.0, or under MIT for the node pack in `comfy-nodes/`.

Please also read the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems go through [private reporting](SECURITY.md), not issues.
