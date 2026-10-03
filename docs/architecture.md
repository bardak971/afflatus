# afflatus: architecture and scope proposal

Draft 1, 2026-10-01. Nothing here is built. This is the shape to agree on before any code. Sections 2 (the core idea), 7 (UI) and 9 (open questions) are where your input matters most.

## 1. Decided so far

| Topic | Decision |
|---|---|
| Name | `afflatus` (working name, see open question 1) |
| License | AGPL-3.0 |
| Users | Single user. Every table still carries an `owner_id` from day one, so multi-user later is a feature, not a rewrite |
| Noctown | Independent. No shared code path, no "generation service" role |
| Scope | Images and videos, with a timeline, for whatever ComfyUI can run. Adding a model family must not mean touching the UI or the queue |

The last row is the requirement that drives the whole design. Noctown's Studio cannot meet it: its routes, queue payloads, job runner and UI each know the three families by name (`klein?:` on the image payload, `useModel(lane, "video", "ref2va")`, `isKleinCheckpoint`, LoRA kinds `"image" | "klein" | "h3" | "other"`). Adding Wan there would mean edits in about ten files.

## 2. The core idea: families and recipes

Everything the app can make is described by two things.

A **family** is one model architecture: SDXL (which covers Illustrious, NoobAI and Pony), FLUX.2 Klein, MiniMax H3, Wan 2.2, LTX 2.3. A family knows:

- its **model slots** and how to find the files (for H3: diffusion model, text encoder, video VAE, audio VAE, optional turbo LoRA);
- which LoRAs fit it;
- its geometry rules (SDXL: multiples of 8; Klein: multiples of 16 near 1 MP; H3: multiples of 32, frames on `17k + 5` at 24 fps; Wan: multiples of 16, frames on `4k + 1`; LTX: multiples of 32, frames on `8k + 1`);
- how its prompts are written (tags, sentences, or H3's sectioned layout) so the prompt designer can follow it.

A **recipe** is one thing you can do with a family: text to image, image to image, inpaint, upscale, fix face, image to video, first and last frame to video, continue a clip, reference to video. A recipe declares its inputs, its outputs, what it needs installed, and a function that builds the ComfyUI graph.

```ts
interface Recipe<In> {
  id: string;                 // "h3.image-to-video"
  family: string;             // "h3"
  title: string;
  output: "image" | "video" | "audio";
  inputs: InputSpec[];        // what the composer renders
  needs: Requirement[];       // node classes and model slots
  traits?: VideoTraits;       // what the timeline may ask of it
  build(input: In, ctx: BuildContext): BuiltGraph;
  variants: Variant<In>[];    // sample inputs the graph checker builds in CI
}
```

### 2.1 Inputs are a closed vocabulary

The composer does not know any family. It renders a recipe's `inputs`, each of which is one of a small set of slot types:

| Slot type | Renders as | Examples |
|---|---|---|
| `prompt` | text area, in the family's style (tags, sentences, or sections) | SDXL tags; H3 description / soundscape / music |
| `negative` | text area | SDXL, Klein |
| `model` | file picker limited to the family's slot | checkpoint, Klein fine-tune |
| `loras` | list with weights and trigger words, filtered to the family | all families |
| `size` | aspect and resolution picker that follows the family's grid | 832×1216; 576p short edge |
| `duration` | seconds, snapped to the family's frame grid | 5 s → 125 frames on H3 |
| `image` | library picker, with a role | source, start frame, end frame, mask |
| `references` | several pictures, videos or audio clips, each with a role | Klein person / place / clothing; H3 pictures, videos, voice |
| `number`, `toggle`, `choice` | labelled control | steps, CFG, turbo, step cache, smooth to 48 fps |
| `seed` | seed field with "random" | all |

A new recipe picks from this list. A new slot type is rare and is the only time UI code changes.

Built so far: `prompt`, `model`, `loras`, `size`, `number`, `toggle`, `choice`, `seed`, `image`, `clip`, `references` (several pictures, each saying what it shows: a person, a place, clothes, an object, a look) and `audio` (a sound, or a video with sound: a voice). Not built: `negative` and `duration` as types of their own (they are a `prompt` and a `number`). A `clip` input is a video of the library that the new clip joins onto, with a moment in it: `role: "previous"` (the new clip carries on from there) or `"next"` (it arrives there). The recipe says how many frames it takes (`frames: [22, 5]`, best first) and at what speed; the server cuts them with ffmpeg, with their sound, and hands the recipe that small file plus its facts (`BuildContext.media`). A recipe never sees the whole video.

### 2.2 The timeline talks to traits, not to models

A video recipe states what it can do:

```ts
interface VideoTraits {
  startFrame: boolean;              // can open on an image
  endFrame: boolean;                // can land on an image
  continues: "clip" | "frame" | false;  // from the previous clip's last frames, or only its last frame
  endAnchor: boolean;               // a redo can be made to end where the next clip begins
  sound: boolean;                   // generates audio
  grid: FrameGrid;                  // fps and valid frame counts
}
```

How a join works, as built:

- **The shared frames belong to the earlier clip.** A clip that carries on is rendered longer by the frames it was given, and says so in its result (`BuiltGraph.overlap.headMs`). The timeline skips them when it plays and when it exports, so the clip keeps the length that was asked for.
- **A fitted redo** is given the first frames that play of the next clip, pins them at its own end, and reports them as `overlap.tailMs`.
- **Each take remembers what it was joined onto**: the take before it and the moment, or the take after it and the moment. A join is fresh while the two takes that play are those two and still meet at that moment. Another take, or a trim at the join, makes it stale. Nothing is re-rendered on its own: the editor marks the join and offers "Redo it" or "Keep as a cut".
- **The frame of a timeline** (`BuildContext.canvas`) is set by the first clip rendered and wins over the shape a recipe would pick.
- A recipe with `continues: "frame"` is given the last frame that plays of the clip before as its opening picture (saved once as a picture of the library).

The timeline uses the best option the chosen recipe offers. H3 gets what Studio has today: a 22-frame tail with sound anchored at frame 0, and redos fitted at both ends. A family with only a start-frame input (Wan 2.2 image to video) still continues a timeline, from the previous clip's last frame: the pose carries over, the motion does not. Clips in one timeline may use different families. Stills and imported clips sit in the same timeline.

**Sound is its own layer.** A clip has a picture and, separately, a sound; each has takes. That makes three things possible without touching the picture: mute a clip, replace its sound with an audio file, and regenerate only its sound. The third needs a recipe that takes a video and returns audio, so it depends on the model:

- LTX 2.3 has a node (`LTXVAudioVideoMask`) that regenerates audio in a time range while keeping the video. Not tested.
- H3 generates picture and sound together; the node catalog shows no way to redo only its sound.
- No video-to-audio model (the MMAudio kind) is installed on the owner's ComfyUI. One can be added as a workflow recipe.

A timeline-wide music track (an audio file, or a music recipe: the catalog has MiniMax Music3 and ACE-Step nodes) uses the same layer idea.

### 2.3 Three ways to add something

1. **A built-in recipe, in TypeScript.** Full power: computed frame counts, any number of references or LoRAs, prompt layouts, optional speed-up nodes that switch off when missing. SDXL, Klein and H3 are ported from Noctown this way.
2. **A workflow recipe, with no code.** This is how a user adds a model family nobody has written a recipe for. See 2.3.1.
3. **Community packs** (a folder with a manifest and a module, loaded at start). Deferred: it means running third-party code, which needs thought.

#### 2.3.1 Workflow recipes

The user builds and tests a workflow in ComfyUI as usual and imports its file into afflatus: the file ComfyUI's editor saves (preferred), or one saved with "Export (API)". An import screen then turns it into a recipe:

- **It guesses the obvious inputs** from the graph: the text encoders feeding the sampler's positive and negative, the sampler's seed, the latent's width, height and length, the image loaders, the save or video-combine node. The user confirms or corrects.
- **Any other node input can be exposed as a control.** Its type, range, step and options are read from ComfyUI's node catalog, so a `steps` input becomes a number field with the right limits and a `sampler_name` input becomes a dropdown, with no typing by the user.
- **LoRAs:** the user marks where the model enters the sampler; Afflatus inserts a LoRA loader per chosen LoRA at that point, so the count is free. A node that is itself a list of LoRAs (rgthree's Power Lora Loader) is taken as the list: its LoRAs start in Afflatus's, and the user's list replaces them.
- **Switches** (editor files only): parts of a workflow that its author made switchable (bypassed or muted nodes behind a switch node) become on/off switches on the form. The recipe keeps every node, and takes out what is off when it builds, the way ComfyUI's front end does. An exported file only has what was on when it was exported.
- **The author's own panel:** settings shown on the front of a group node are the ones ticked to begin with, under the names the author gave them.
- **Roles for the timeline:** an image input can be marked "start frame" or "end frame", and a video input "previous clip". The recipe gets the matching timeline traits. The frame grid comes from the length input's step in the node catalog.
- **The result is two files** (the workflow and its mapping), which can be exported and shared, so one person's Wan or Hunyuan recipe works for anyone with the same nodes and models.

A workflow recipe gets everything the app offers to built-in ones: the composer form, the queue, progress and previews, the library, lineage, presets, the setup check (its nodes and model files are read from the workflow), and a place in the timeline.

What it cannot do, because these need logic rather than filling in values:

- a variable number of reference pictures (the workflow has as many as it was built with);
- a prompt assembled from several fields into a model-specific layout (H3's sections);
- a clip made longer by exactly the frames it shares with the previous one;
- nodes that switch on only when installed.

Those exist only in built-in recipes.

Reading the editor's file means doing what ComfyUI's browser front end does when it queues (there is no service for it): opening up group nodes, following reroutes, matching the bare lists of values to inputs, leaving out notes. Afflatus follows that code for what it covers and says, in the import screen, what it could not read with certainty. Nodes that draw their own fields in the browser are the weak spot: their values cannot always be matched to inputs.

### 2.4 Requirements, the setup page and the graph checker

Each recipe lists the node classes and model slots it needs. One **capabilities** module reads ComfyUI (`/object_info`, the model lists, LoRA metadata) and answers, per recipe: ready, or missing what, and where to put it. Three things read that one answer:

- the **setup page** (what works on this install and what is missing);
- the **composer** (recipes that are not ready are shown disabled with the reason, never as an error after queueing);
- the **queue** (checks again just before submitting).

Model files are found by pattern first (as Noctown does), and every slot can be set by hand on the setup page. That replaces the file-name regexes spread through `comfy.ts`.

The **graph checker** is ported first. Every recipe ships `variants`; CI builds each one and validates it against `reference/comfy-object-info.json` (node exists, required inputs present, links point at real outputs). No GPU needed. The same check runs against the live node list before a job is submitted, so a renamed node after a ComfyUI update produces a clear message.

### 2.5 What is not ported

Noctown's image engine speaks A1111's dialect because Noctown ran on A1111 first: sampler names are mapped, `<lora:name:1>` tags are parsed out of prompts, checkpoints are addressed by file stem. Afflatus uses ComfyUI's own names and takes LoRAs as structured input. Reading an image's embedded settings (A1111 or ComfyUI metadata) stays as an import feature.

## 3. Shape of the system

One Node process serves the API and the built web app. TypeScript throughout, pnpm monorepo:

```
packages/core       types, the recipe contract, slot types, zod schemas
packages/recipes    one folder per family: sdxl, klein, h3, wan, ltx, workflow
packages/comfy      ComfyUI client: submit, wait, websocket monitor, uploads, capabilities
apps/server         Fastify: routes, queue, storage, database, designers (LLM), ffmpeg
apps/web            React 19, Vite, TanStack Query, zustand, Tailwind 4
deploy/             Dockerfile, docker-compose.yml, Helm chart
reference/          comfy-object-info.json
```

**Why TypeScript.** The parts that cost the most debugging in Noctown (graph builders, ComfyUI client, queue, graph checker) are about 4,000 lines of working TypeScript, so they are ported rather than rewritten. The recipe contract is shared by the server and the web app, which only works if both speak one language. The alternatives considered:

- *Go:* a single binary is attractive for PC users, but it means rewriting everything, and no shared types with the UI.
- *Python, as a ComfyUI extension:* installs through ComfyUI-Manager with nothing else to run, but the app would die whenever ComfyUI crashes or restarts, and it cannot run on a cluster while the GPU PC is off. That rules out the resumable queue and the cluster mode.

**ComfyUI: connect, do not bundle.** Afflatus always talks to a ComfyUI server by URL; that is the only code path, and it is what cluster mode needs anyway. It does not install or ship ComfyUI (Python, PyTorch, CUDA builds, custom nodes): that is a distribution's job and other tools already do it. What it does instead:

- the setup page says exactly which nodes and model files each recipe is missing, and can install them through ComfyUI-Manager when the user asks;
- optional, later, for PC mode: given the path of an existing ComfyUI install, Afflatus can start it, stop it, restart it after a crash and show its log;
- optional, at release: the compose file can include a ComfyUI container for people starting from nothing.

| | PC mode | Cluster mode |
|---|---|---|
| Start | `pnpm start` or `docker compose up` | Helm chart, Argo CD |
| Database | SQLite file in `./data` | Postgres |
| Files | `./data/files` | S3 (MinIO) |
| Chosen by | no `DATABASE_URL`, no `S3_*` set | those variables set |
| Replicas | one process | one pod, `Recreate` strategy (two pods ran jobs twice in Noctown) |

**SQLite driver.** Node's built-in `node:sqlite`, not `better-sqlite3`. The latter failed to install on the owner's PC (no prebuilt binary for Node 24, and compiling needs Visual Studio's C++ tools). A public app that promises "one command, nothing else to install" cannot depend on a compiler.

**Database.** I recommend Kysely rather than Drizzle. Drizzle needs a separate schema definition per dialect (`pg-core` and `sqlite-core`), so every table and migration would be written twice. Kysely has one set of table types, one migration set written in its schema builder, and a dialect picked at start. JSON is stored as text in both. CI runs the server tests against both databases. The schema is about a dozen tables, so this stays cheap.

**Storage** is one interface (`put`, `get`, `stream` with range support, `delete`) with a local-folder and an S3 implementation.

**Live updates.** One server-sent-events stream carries job progress, previews and "the library changed". The 1-second queue polling and the page-wide re-render it caused go away.

**Auth.** Off when the server listens on localhost only. A single password (a setting) is required when it listens on the network. No accounts.

## 4. Data model

Images, videos and audio stop being three unrelated tables.

| Table | Holds |
|---|---|
| `assets` | One row per file: kind (image / video / audio), file key, thumbnail or poster, size, duration, fps, has sound, folder, origin (generated / uploaded / imported / frame grab), `kept_at` (null = expires after 24 h) |
| `generations` | How an asset was made: recipe id and version, the inputs as submitted, what was resolved at render time (model files, the seed actually used, the prompt as sent), GPU time |
| `generation_inputs` | Which assets a generation used, and in which role (start frame, reference: person, mask, previous clip). This is the lineage: "made from" and "used in" |
| `jobs` | The queue: recipe, inputs, status, priority, `depends_on`, attempts, the ComfyUI prompt id and what is needed to resume waiting after a restart |
| `timelines` | Name, folder, canvas size |
| `clips` | A position in a timeline and its active take |
| `takes` | An asset at a clip position, on the picture layer or the sound layer, plus (for picture) how many of its opening frames overlap the previous clip. A clip points at one active take per layer |
| `folders` | Nested, as today |
| `presets`, `snippets` | Saved input sets per recipe; reusable prompt fragments |
| `drafts` | Unfinished work, saved as it is typed: what it is for (something new, an existing asset, a timeline clip), the recipe, the inputs so far, the designer chat |
| `people` | Identity packs: a named set of pictures and a voice clip of one person |
| `model_notes` | Per model file: trigger words, Civitai link, your edits |
| `settings` | ComfyUI URL, LLM endpoint and key, Civitai key |

What this fixes, compared with Studio:

- **One place for settings.** A clip's settings live in the generation's `inputs`, typed by the recipe. Studio keeps them in three places (the row's params, the queue payload, the composer state); "end on image" alone exists in four, and LoRAs are encoded three different ways.
- **A timeline is a real thing.** Studio has no timeline or take table. A timeline is "the videos sharing a `reelId`" (which is the first clip's id), a take is "rows sharing an index", and the active take is whichever row has the latest timestamp. Consequences there: deleting a clip leaves an index gap that breaks fitted redos, importing a clip in the middle leaves the next clip trimming 22 frames it no longer shares, and deleting the first clip's start image deletes the whole timeline. With `clips` and `takes` rows, the active take is a stored pointer and the overlap belongs to the take.
- **Lineage has foreign keys.** Studio keeps "made from these photos" as ids inside JSON.
- **Assets know their own size and name.** Studio re-probes the PNG for its size and uses the prompt field as the display name of imports.
- **One expiry rule.** "Unsaved things expire after 24 h" is enforced by one sweep reading `kept_at`. Studio bumps a `savedAt` field from five different places.
- **Paged lists.** Studio's galleries use fixed limits (120 images, 500 videos) with no paging.

Timeline export becomes a queued job on its own lane (ffmpeg, no GPU) instead of running inside a web request.

## 5. Queue

Ported from `gpuQueue.ts` with its lessons kept:

- claim a job atomically so a cancel that landed first wins;
- resume by ComfyUI prompt id after a restart;
- expire queued jobs by how long the GPU has been away, not by job age;
- free ComfyUI's memory (`/free`) whenever the next job loads a different model. The recipe reports which models it loads, so the queue no longer hard-codes "image", "video", "scene";
- chains (`depends_on`) for long videos and "render all": a clip waits for the clip it continues;
- store the seed the render used.

The job runner becomes generic: resolve input assets, upload them to ComfyUI, call `recipe.build`, check the graph, submit, wait, store the outputs the recipe named. It has no per-family branches.

Kept from Studio: priorities (images before waiting videos), cancel, Wake-on-LAN, Prometheus metrics. One ComfyUI at first; the lane structure stays so a second GPU can be added later.

## 6. ComfyUI client

Ported nearly as is, since it is the part that cost the most debugging: one client id per process, preview method per prompt, the KJNodes animated preview, error messages extracted rather than echoed, "lost job" detection and retry, timeouts that count only while the job runs.

## 7. UI and UX

This is a concept to react to, not a spec. The next step for it is wireframes.

### 7.1 What is wrong with Studio's UI today

From a full read of `studio.tsx`, `video-dialog.tsx` and `components/studio/*`:

- **The model, the biggest choice, is the most hidden.** Switching to Klein means: open the settings drawer, find the checkpoint select, pick from an option group. The form then changes shape and the LoRAs are wiped without a word.
- **Four tabs, three different "go" buttons.** Generate in a footer, "Make the scene" inside the scene panel, Render inside the video composer.
- **Create and Edit share one prompt.** Clicking "img2img" on a tile overwrites what you were writing in Create, with no undo.
- **Reference pictures exist three times** (photo mode: 4, scene maker: up to 6, video: 6 plus 3 videos), each with its own UI, and each pick opens and closes a modal. Four references are four round trips.
- **Timeline actions are scattered.** Picking a take is on the timeline only; quick regenerate and export are only inside the "Play all" viewer.
- **Splitting is silent.** It is on by default at 5 s, so a longer clip becomes several without saying so.
- **Long video needs three areas at once:** the composer tab, the right column on the right tab, and settings made beforehand on another tab.
- **Feedback comes from seven places** (error line, scene error, inline notices, toasts, GPU pill, progress bar, live tile).
- **Tile actions are hover-only**, so they are hard to discover and do not work on touch.
- **The whole page re-renders every second during a job**, and the gallery has no paging.
- Sizes, limits and option lists for SDXL and H3 are written into about thirty places in the UI.

### 7.2 Principles

1. **The model comes first.** The composer opens with two choices: what to make (image or video) and with what (the recipe and its model). The rest of the form follows from the recipe. Switching keeps what still applies (prompt, aspect, seed) and sets aside what does not (another family's LoRAs), restoring it if you switch back.
2. **One composer, one button.** Creating, editing, scene edits, animating and filling a timeline clip all use the same composer, with the primary button in the same place.
3. **Every piece of work is its own draft.** A new image, an edit of image X and a redo of clip Y each keep their own prompt and settings, and survive a reload. Starting an edit never touches another draft.
4. **Start from what you have.** Selecting an asset shows the actions that accept it: edit, inpaint, upscale, animate, use as reference, add to a timeline. That list is computed from the recipes installed, and it is shown as visible buttons.
5. **One reference tray.** One component for every recipe that takes references: pick several in one go, drag from the library, drop files from disk. Its limits and roles come from the recipe.
6. **One place for jobs.** A queue strip, visible everywhere, holds progress, the live preview, errors and cancel. An error belongs to its job.
7. **Nothing happens silently.** If a clip will be rendered as several, the composer says "this renders as 2 clips" before you queue it.

### 7.3 Layout

Three workspaces and two utilities:

| Place | What it is |
|---|---|
| **Library** | Home. The grid of images, videos, timelines and audio, paged. A folder tree at the side that items can be dragged onto. Search and filters built from each asset's recipe and models, so they work for every family |
| **Composer** | A panel that docks beside the library or the timeline. Recipe picker on top, the recipe's form, the reference tray, the prompt designer and snippets as a side sheet of the same panel, one Generate button. Results appear next to it as they render |
| **Timeline editor** | Its own workspace. Player on top; below it one track of clips drawn at their real length; the selected clip's takes directly under it; pick, redo, quick redo, delete, import and export all here. The composer docks at the side for the selected clip. A plan from the designer lands as empty clip slots you can edit before "Render all", which replaces the separate long-video panel |
| **Viewer** | One asset, large. Its settings, its lineage ("made from", "used in") and its actions |
| **Queue** and **Settings** | The job strip described above; the per-recipe readiness page from section 2.4 |

### 7.4 Timeline editor: decided on 2026-10-01

- The library is home; a timeline is an item in it that opens into the editor.
- The editor is a movie-maker style track, not Studio's row of cards: clips drawn at their real length on a time ruler, with pictures, videos and sounds dragged in from the library.
- A join that no longer matches is marked and refitted on click. Nothing is re-rendered automatically.
- "Continue from this frame": cut a clip at the playhead and continue from there.
- In scope: trim, reorder, stills held for a few seconds, a sound per clip, one music track. Out of scope: several video layers, titles and text, transition effects.
- The prompt designer opens on demand from the composer; it is not a permanent column.
- The owner has never used a video editor, so it must be understandable without that background: plain labels ("Picture", "Sound", "flows into the next clip"), no editing jargon.

Agreed after the first mockup (2026-10-01):

- Clips show their own frames as a small filmstrip.
- Takes open directly under the selected clip as thumbnails; hovering one previews it.
- The "no longer matches" marker opens a box that explains why and offers "Redo it (time estimate)" or "Keep as a cut".
- The clip panel leads with the prompt. Settings fold into one summary line that opens the full set. Every option Studio's video composer has today is kept: length, split, resolution, turbo, steps, smooth to 48 fps, step cache, live preview, seed, voice clip (pick, upload, from a video), LoRAs with strength and trigger words, references, end image. The controls shown are the recipe's, so another model shows its own.
- An empty timeline opens on two choices: start from a picture, or describe a scene and let the designer plan the clips.
- Undo for every timeline edit, a time estimate on the render button taken from past renders, zoom and "fit all".
- **Pictures pinned to a moment** live on the timeline: drop a picture on a clip's start (opens on it), end (ends on it) or anywhere between (passes through it). Only what the clip's model supports is offered: H3 and LTX all three, Wan start and end.
- **Cast and places** are set once on the timeline (person, place, clothing) and used by every clip unless a clip overrides them.
- **Identity packs** (a saved set of pictures and a voice clip of one person, reusable anywhere) are accepted for this app, reversing the earlier "no" in Noctown.

- **Options are never limited to the owner's card.** A recipe offers its full range (for example 1080p video). The app reads the card's memory from ComfyUI and marks heavy choices ("slow on your 12 GB card", "probably too big"); it does not hide them.
- **Hi-res fix for pictures** with its full settings (enlarge by, upscaler, redraw strength, second-pass steps), as in Studio.
- **"Enlarge afterwards" for videos:** render small, then upscale at the end, the video counterpart of hi-res fix. It is a finishing step that works on any clip whatever model made it, like frame smoothing. Decided: for a timeline it is an option of the export (size as rendered, 1.5× or 2×, smooth motion, include the music), so drafts stay small and only the final cut is enlarged. A single clip made in Create keeps its own "Enlarge afterwards" setting. The first version is a per-frame upscale model; a redraw pass by the video model is a later, per-model addition.
- The workflow screen is named "Import a ComfyUI workflow" and sits under "Workflows" in the navigation.

Agreed on 2026-10-01 after the full set of screens ("very nice"):

- **Queue screen** with a Pause button ("I need the GPU"): the running job finishes, nothing new is sent to ComfyUI until resumed. Failures say why in plain words and offer a retry that fixes the cause (for example "Try again at 576p").
- **Settings screen:** ComfyUI address and card, what is ready and what is missing with install buttons, the designer's language model, storage, notifications, password.
- **A timeline has one shape** (wide, tall, square). A clip of another shape is marked and shown with bars, with "Fill the frame" as the alternative.
- **Volume** per clip and for the music; **fade in and out** and "quieter while people talk" for the music.
- **Loop:** one click makes a clip end on its own opening picture.
- **The designer looks at the picture** when the configured language model can read pictures; otherwise it works from text and says so.
- **Look and mood** for a whole timeline, next to cast and places, applied by the designer to every clip it writes.
- **Bin:** deleted things and unkept results are kept 7 days before they are removed.
- **Storage clean-up:** space used by kind, and "move takes that never play to the bin".
- **Notifications** from the browser when a render finishes or the queue is empty. No outside service.
- **Hardware monitor:** a bar with processor, memory, disk, GPU load, GPU memory and GPU temperature of the machine ComfyUI runs on, on the Queue screen and in short form in the bottom strip. The numbers come from a monitor extension's once-a-second broadcast when one is installed (the DaSiWa nodes, or ComfyUI-Crystools); without one, only GPU memory is shown, from ComfyUI itself.
- **Drafts:** every unfinished piece of work is saved on the server as it is typed, with its settings, references and designer chat. In a timeline each clip is its own draft. In Create, drafts are listed and can be reopened. This is the data model's `drafts` table: owner, target (new, an asset, a clip), recipe, inputs, chat, updated time.

**Built so far of the editor** (checked against a pretend ComfyUI; the built-in H3 recipe has not rendered on a real one yet):

- The list of timelines, and the editor: media shelf (pictures, videos, sounds, by folder, or from the computer), the player, the selected clip's panel, the track.
- The track is to scale: a time ruler, a playhead to click or drag, zoom and "Fit all", clips as wide as they are long with their own frames as a filmstrip, a title, drag to reorder, drag an edge to shorten.
- Takes under "Takes" in the clip's panel: hover to preview, click to make one play.
- Joins: "Flows on from clip N" or a cut; a stale join is marked, with "Redo it" and "Keep as a cut". "Continue from this frame" cuts the clip on screen and adds one that continues from there. "Render all" renders what is missing or stale, in order, each clip waiting for the one it flows on from.
- Pictures: dropped between clips, a picture is held on screen (a still), and can be turned into a video clip; dropped on a clip, it becomes the picture the clip opens or ends on. "Make it loop".
- Sound: each clip plays its own sound, a sound file, or nothing, at its own volume. One music track under the whole video, with volume, fades and "quieter while people talk" (applied in the export).
- One shape per timeline; a clip of another shape is shown with bars or fills the frame.
- Undo for every change to the timeline (what is typed in a clip's form in one go is one step).
- Export in the queue: one MP4, as rendered or enlarged 1.5× or 2× with ffmpeg, with or without the music.

- Cast and places for the whole video (and a clip's own), look and mood, voices and reference pictures, time estimates on the buttons, the designer per clip, "describe a scene" planned as clips, typed lengths, timelines listed in the library.

Not built yet: a picture in the middle of a clip, smooth motion as an export option, splitting long clips.

Clickable mockups, eight boards on one canvas (timeline editor, empty timeline, library, create, models and workflows, import a workflow, queue, setup): https://claude.ai/artifact/AHKbDqpagHJQJvMBT2KcPE

### 7.5 Presets, styles and characters (agreed 2026-10-01)

Everything a model, a style, a character or a preset brings can be changed in Create for the draft at hand. A changed value is highlighted, shows what it was, and can be put back with one click; "Reset all" puts everything back. The saved piece is not altered unless the user chooses "Save for this model" (or the equivalent for a style, a character or a preset). A character or a style can be switched off for one draft, an outfit picked, and any LoRA's strength changed, whoever added it. "See what is sent" shows the final prompt, coloured by where each part came from.

Noctown has two ideas here. A **preset** is one bundle: checkpoint, sampler, steps, CFG, size, hi-res settings, negative prompt and LoRAs, with per-generation overrides (a field you change is highlighted, the others keep following the preset). A **character** is two tag lists, identity and outfit, that only work on tag models; on Klein the character control disappears and a person picture is used instead; the voice comes from a separate sample.

The weaknesses: a preset mixes four unrelated things, so "this checkpoint's best settings" cannot be combined with "this style"; it is SDXL-shaped; and a character has to be rebuilt by hand for each model family.

Afflatus splits the bundle into four pieces that combine:

| Piece | Holds | Belongs to |
|---|---|---|
| **Model settings** | What makes one checkpoint work: sampler, scheduler, steps, CFG, clip skip, quality tags, negative prompt, default shape, hi-res settings | One model file. Picking the model brings them along |
| **Style** | A named set of LoRAs with strengths and trigger words, plus optional prompt words. Several can be stacked | One family |
| **Character** | Everything that keeps one person consistent, in every form a model may need: reference pictures, a voice clip, a LoRA per family with its trigger words, the appearance as tags and as a sentence, and named outfits | The library ("People"), any family |
| **Preset** | A whole setup saved under a name: model, styles, characters and the remaining settings. One click to load, with Noctown's override behaviour kept | One recipe |

The point of the character is that it is written once and used everywhere. Adding "Her" to a prompt uses her LoRA and tags on Illustrious, her reference pictures and sentence on Klein, and her references and voice on MiniMax H3. It is the same entry the timeline's "Cast and places" uses. Places work the same way (a picture plus words).

Characters and styles are stored on a generation as references, not as pasted text, so the library can answer "everything made with Her" and "everything in the Film look". The composer shows what each one adds, and the final prompt can be opened and read before rendering.

In the recipe contract this is a `cast` input and a `styles` input. Each recipe states how it takes a person (LoRA and words, or reference pictures, or both); a resolver on the server turns the chosen characters and styles into LoRAs, prompt text and reference uploads before the graph is built.

**Built** (2026-10-01): people, places, styles and presets are documents in one table (`entities`), edited on the People page. `compose()` on the server is the one place that turns "her, in the summer dress, film look" into what a recipe takes: words in the prompt (tags or sentences, whichever the recipe's prompt is written in), LoRAs for that model family, reference pictures and a voice for the recipes that take them. A recipe never hears about people. Picking them is the same bar everywhere ("Characters and styles" in Create, "Cast and places" on a timeline), with "See what is sent". Model settings per checkpoint were built earlier (section on per-model settings). Not built: overriding a character's pieces per draft with highlight and reset; the designer writing a person's words from their pictures.

### 7.6 The designer (built 2026-10-01)

A conversation with any language model that has an OpenAI-style address (set in Settings; on the user's computer or elsewhere). It writes the text inputs of whatever recipe is in use and answers with the full new text of the boxes it changes, or one question, or a plan of clips; in labelled lines, not JSON. Each family can say how its prompts are written (`Family.guide`); without one, a general guide for tags or for sentences is used. It is told the clip's length, the clip it continues, who is in it, the look and mood, the LoRAs' trigger words, and it is shown the opening picture when the language model can read pictures. Nothing it proposes goes into a form until "Use it" is pressed. Snippets (bits of text kept under a name) sit next to it.

### 7.7 Carried over because it works

The proposal cards with Apply in the designers, the snippet browser, the missing-models resolver, the inpaint mask editor, the gapless reel player, and the capability flags that grey out what the install cannot do.

## 8. Scope and order of work

Proposed milestones. Each ends in something you can use.

| # | Milestone | Contains | GPU needed |
|---|---|---|---|
| 0 | Skeleton | Both run modes, settings, ComfyUI client, capabilities and setup page, queue with live events, library, the recipe contract, graph checker in CI, one recipe (SDXL text to image) | Only for the last step |
| 1 | Workflow recipes | Import an API-format workflow, the mapping wizard, exposed controls, LoRA insertion, export and share. **Wan 2.2 is added this way, from the owner's own workflow, with no Wan code in the app.** That is the test of the promise: whatever is awkward here is awkward for every user | Yes |
| 2 | Video and timeline | H3 built-in recipes (start, end, both, continue, references, voice). The timeline editor: clips, picture and sound takes, fitted redos, plan and render all, import, export. Wan clips from milestone 1 sit in the same timeline | Yes |
| 3 | Images | SDXL: image to image, hi-res, inpaint, fixes. Klein: photo mode with references, edits, reframe. Lineage in the viewer | Yes |
| 4 | More families | Whatever milestone 1 showed a workflow recipe cannot do well enough for Wan becomes a built-in Wan recipe. LTX 2.3 after it | Yes |
| 5 | Designers and helpers | Prompt designers (any OpenAI-compatible LLM), tag checker, Civitai lookups and downloads | No |
| 6 | Release | Docker image, compose file, Helm chart, install docs, per-feature ComfyUI requirements, screenshots, neutral default snippets. Far off; not planned in detail yet | No |

Workflow recipes moved from fourth to first after the skeleton because user-added models are a core promise, not an extra: building them early forces the composer, queue and timeline to be generic before three built-in families can hide shortcuts.

Scene maker, mid-clip keyframes and the vision pass for designers fit after milestone 2 as recipes or designer features; their order is yours.

**Where this stands (2026-10-01).** Milestones 0 to 3 and the designer of milestone 5 are built; almost all of it has only run against the pretend ComfyUI (see `README.md` for what was rendered for real). Built since this table was written, and how:

- **A picture a clip passes through** is an `image` input with `role: "mid"` and `at` (the id of the number input that holds its moment). The timeline pins it by dropping a picture on the middle of a clip.
- **A painted mask** is an `image` input with `role: "mask"` and `of` (the id of the picture input it is painted over). The form paints it; it is stored as a hidden library item (origin `mask`); at submit the server reads which part was painted into `MediaFacts.box`, and the recipe redoes that part only.
- **A choice among files the user has** (an upscale model, a face finder) is a `choice` with `prefer`: regexes that pick the starting value among what ComfyUI offers (`pickChoice`), in the form and again at submit. With none offered, the recipe is not ready.
- **`Recipe.advice(input, card)`** says what is slow or probably too much on the card ComfyUI runs on, next to the choice that makes it so. It never removes an option.
- **Families `klein` and `tools`**: FLUX.2 Klein's files are found by name like H3's; `tools` holds what needs no picture model (removing a background).
- **Every recipe that takes one picture and gives a picture back** is offered by the viewer's "Change this picture", built-in or imported: nothing there is listed by hand.
- **Civitai lookups** are off unless turned on in Settings; then only a file name is sent, on a click.
- **Downloads into ComfyUI** are a second switch, also off. ComfyUI-Manager does the saving; it is handed a one-time address on Afflatus, which streams the file through and counts the bytes. Afflatus stores nothing and a Civitai key never reaches ComfyUI. ComfyUI has to be able to reach Afflatus (`PUBLIC_URL` when the address the page was opened at is not it).
- Dropped by the owner: a password, starting ComfyUI, waking the GPU computer.

## 9. Open questions

Answered on 2026-10-01: Kysely for the database; Wan 2.2 is the first family after the ported ones; the public release is far off and not a concern now; sound as its own layer in the timeline is wanted if it allows regenerating only the audio (section 2.2).

Still open:

1. **Name.** `afflatus` is free on npm and on your GitHub account. About fifteen GitHub projects are called Afflatus and all are study or student tools, so the name reads as "study AI" to a newcomer and will be hard to search for.
2. **ComfyUI: connect, do not bundle** (section 3), with an optional launcher for an existing local install later. Proposed, not yet confirmed.
3. **The UI concept in section 7:** wireframes are the next step once the direction is agreed.

Also answered on 2026-10-01: the timeline comes before the full image set (milestone order as in section 8).

## 10. What this draft rests on

Read in full by me: `comfy.ts`, `gpuQueue.ts`, `shared/src/sd.ts`, `check-comfy-graphs.ts`, the handover, the Studio backlog note. Read by two review agents and reported back: the route files, the database schema, the designers, the ffmpeg services, and the whole Studio UI. Their findings are from reading code, not from running it. Checked in the node catalog dump (2026-09-28): the Wan, LTX and H3 node inputs quoted above, and that Wan 2.2 and LTX 2.3 model files are listed.

Not verified: how last-frame continuation looks on Wan or LTX; that LTX's `LTXVAddGuide` gives clip-level continuation comparable to H3's; how well automatic input detection works on imported workflows. Each needs a render, which needs your OK.
