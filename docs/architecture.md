# Architecture

How Afflatus is put together, as built. For the conventions and the checks, see [develop.md](develop.md).

## The shape

One Node process serves the API, the live events and the built web app, on one port. It talks to one ComfyUI over HTTP and its websocket, and never runs a model itself. TypeScript throughout, a pnpm monorepo:

```
apps/server           Fastify: routes, queue, timelines, storage, database, designer (LLM), ffmpeg
apps/web              React 19, Vite, TanStack Query, zustand, Tailwind 4
packages/core         the recipe contract, the input types, graphs, frame grids, the graph checker
packages/recipes      the built-in recipes, one folder per family (sdxl, klein, flux, krea2, qwen, h3, wan, ltx…)
packages/comfy        the ComfyUI client: submit, wait, the progress monitor, uploads, capabilities
packages/workflows    the importer: a ComfyUI editor file read into a recipe
comfy-nodes/          Afflatus's node pack for ComfyUI (Python): H3 latents, model headers
presets/              the presets that ship with Afflatus
reference/            comfy-object-info.json, the node catalog the graph checker builds against
chart/, Dockerfile    the Helm chart and the image
```

## Families and recipes

Everything Afflatus makes is a **recipe** of a **family**.

- A **family** is one model architecture: its model slots and how to find their files, which LoRAs fit, its size and frame grid (H3: multiples of 32, frames on `17k + 5` at 24 fps), how its prompts are written, and the rules a written prompt is held to (`lint`).
- A **recipe** is one operation of a family: text to picture, inpaint, upscale, image to video, a clip that carries on. It declares its inputs, its output, the nodes and model slots it needs, its timeline traits, what a finish made with it needs of its draft (`finishing`), and a `build(input, ctx)` that returns a ComfyUI graph. It also ships `variants`, sample inputs the graph checker builds. Frame counts are rounded onto a recipe's `traits.frameGrid` by one set of helpers (`packages/core/src/frameGrid.ts`).

The web app never names a model family (the command bar's calculator falls back to H3's grid when no video draft is open; the Image tools are left out of the per-model lists by core's `TOOLS_FAMILY`). It renders a recipe's `inputs`, each one of a closed set of types (`prompt`, `model`, `loras`, `size`, `number`, `toggle`, `choice`, `seed`, `image`, `clip`, `references`, `audio`). A new recipe picks from that list; a new input type is the only change that touches the web app.

The **registry** (`apps/server/src/registry.ts`) holds the built-in recipes and one recipe per imported workflow. A recipe made from a workflow says so (`imported`), for the screens that send its problems to Workflows; nothing reads its kind off its id.

**Imported workflows** (`packages/workflows`) are the no-code way to add a model. The importer reads the file ComfyUI's editor saves the way ComfyUI's front end does when it queues: group nodes and subgraphs opened, reroutes followed, values matched to inputs, notes left out. It guesses the form (prompts, seed, size, pictures, the output), turns the author's switches into toggles, finds where LoRAs go, and says in notes what it could not read. The result is a workflow and its mapping, stored in the `workflows` table and exportable.

**Capabilities** (`packages/comfy/src/capabilities.ts`) read ComfyUI's node list and model folders and answer per recipe: ready, or missing what. Settings → Models, the Create shelf and the queue all read that one answer. The **graph checker** builds every variant against `reference/comfy-object-info.json` in CI, and against the live node list before a job is sent.

## The queue

One ComfyUI, so one job at a time, in order (`apps/server/src/queue*.ts`). Jobs live in the database: a restart loses nothing.

- A job is claimed with a conditional update, so a cancel that landed first wins.
- The runner is generic: it resolves the input assets, uploads them to ComfyUI, calls `recipe.build`, checks the graph, submits, waits, and stores the outputs the recipe names. It has no per-family branches: what it does for one recipe and not another, the recipe declares (a finish's draft latent, `finishing`; the node that cuts a kept latent and the grid it is cut on, `traits.latentTrim` and `traits.frameGrid`).
- After a restart, a job ComfyUI already has is waited on again by its prompt id. Queued jobs wait while ComfyUI is away and expire by how long it has been away, not by their age.
- ComfyUI's memory is freed only when the next job needs another base model.
- Jobs can wait on others (`depends_on`): "render clips 2-5" renders each clip after the one it continues.
- Tool jobs share the same queue: trims, copies and exports (ffmpeg), slow motion and the finishing passes (RIFE, SeedVR2 and the like, on ComfyUI).
- Every render's times are kept (`render_stats`, folded by day into `render_days`); the "how long" forecast (`forecast.ts`, one figure for the form's Output line, its Generate button, the command bar, the editor and the queue's rows) and `/metrics` read them.

## Storage and the database

- **Database:** Kysely over Node's built-in `node:sqlite` (one file, `afflatus.db`, in `DATA_DIR`), or Postgres when `DATABASE_URL` is set. One schema, one migration set (`db.ts`), applied at start.
- **Files:** `DATA_DIR/files`, behind one `Storage` interface with keys made by the server (a key never leaves the folder). **Linked folders** are directories of the disk shown as library folders, read and written through the same interface.
- **Assets** are one table for pictures, videos and sounds. `generations` says how each was made (recipe, inputs, what was resolved at render time), `generation_inputs` which assets it used and in which role: the lineage.
- **Expiry** has one place (`sweep.ts`): a result nobody kept goes to the bin after a day, the bin is erased after a week.
- **Drafts** are saved on the server as they are typed: the recipe, the inputs, the designer's conversation.
- **Backups** are one zip of the database and every file, streamed while the app runs.

## Timelines

A timeline is `timelines`, `clips` and `takes` rows: a clip has several takes and one plays. Each take remembers what it was joined onto (the take before and the moment, or the take after); a join is fresh while those two takes play and still meet there, and stale otherwise. Nothing re-renders on its own: the editor marks the join.

- A recipe's **traits** say what the timeline may ask of it: a start or end frame, carrying on from the clip before (its frames, or only its last frame), landing on the clip after, sound.
- The frames a clip shares with the clip before belong to the earlier clip. A continuation is rendered that much longer and says so; the player and the export skip them.
- **MiniMax H3 joins in the latent**, through the node pack: every render keeps its sampled latent beside the video, a continuation starts from the clip before's own last tokens, and the two are decoded as one piece, so the join plays as a plain cut.
- A **finished take** (SeedVR2, RTX, an upscale model, or H3's latent re-sample) stands for its draft: same frames, same timing, same links.
- Undo and redo are snapshots per timeline (`timeline_history`, `timeline_future`).
- The **export** is a queued ffmpeg job: the parts joined, the colour matched across the cuts, the music under it.

## Live updates

One server-sent-events stream (`events.ts`) to every open page. Most events only say what changed (`queue`, `library`, `timeline`, `models`…) and the page refetches; `progress` carries the running job's figures, so the queue screen moves without asking; `system` carries the load of ComfyUI's machine. On connect the server sends `hello` with its version.

## Around the edges

- **No login.** The server listens on localhost unless `HOST` says otherwise, and refuses requests whose `Host` is not one of its own names (`hostCheck.ts`: loopback, `HOST`, `PUBLIC_URL`, `ALLOWED_HOSTS`), which stops DNS rebinding. `/api/health` and `/metrics` answer any name, for probes and scrapers.
- **Outbound requests** (model downloads, Civitai and Hugging Face lookups, the designer's LLM) are made only when turned on, and model downloads go through ComfyUI-Manager on the GPU machine.
- **The designer** is any OpenAI-style endpoint. It writes prompts by the family's guide and answers in a checked shape.
- **The node pack** (`comfy-nodes/afflatus-nodes`) saves and loads H3 latents, guides and decodes continuations, and lets Afflatus read model file headers through ComfyUI when it cannot reach ComfyUI's disk.
