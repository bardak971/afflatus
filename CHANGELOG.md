# Changelog

Every release of Afflatus, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/) (0.x: anything may still change between minor versions). The bundles and the image of each version are on the [releases page](https://github.com/bardak971/afflatus/releases).

## [Unreleased]

### Added
- **A keyframe for LTX 2.3:** a picture the clip passes through at a moment of its own, with its strength, in one pass and in two (a guide at each size); on its own it decides the shape.
- **NAG for Wan Turbo:** the negative prompt acts at CFG 1 (KJNodes' WanVideoNAG), on by default in Turbo, with its scale.
- **Hires fix for FLUX.2 Klein txt2img**, as the other families have it: an upscale model, then a light Klein pass, in tiles past about 2.5 megapixels.
- **Few-step SDXL checkpoints** (DMD2, LCM, Lightning, Hyper, Turbo) start on their own sampling, and a model's matching presets combine: an Illustrious DMD2 merge gets few steps and Illustrious's quality tags.

### Fixed
- **SDXL outpaint:** with xinsir's ControlNet Union ProMax it continues the picture in repaint mode, from the picture stretched rather than grey, without the frame or the seams it used to draw; the picture itself is put back at its own size instead of coming back redrawn and softened.
- **LTX 2.3:** the ×2 latent upscaler slot no longer takes the ×1.5 file, which the two passes would have made a clip at three quarters of the size from.

## [0.3.0] - 2026-10-10

### Added
- **Seamless MiniMax H3 chains.** A continuation starts from the clip before's own latent, and the whole chain is decoded as one piece at the joins, so a join plays as a plain cut. Grid-length joins, latent cuts, fades and a smooth hand-over in the player. Needs node pack 0.10.0.
- **Finish from the draft's latent** for H3: a re-sample that keeps the motion and the seamless joins, beside SeedVR2, RTX Video Super Resolution and upscale models. Upscale metrics per finish.
- **Music ducking** under speech, with a depth in dB, heard the same in the player and in the export.
- **Built-in passes** found across real workflows: detail boost (Detail Daemon), tiled redraw, SageAttention and torch compile, ControlNet guide (pose, depth), Redux look.
- **Workflow importer** built from a corpus of 233 real workflows: forms start with what the workflow's author put forward, a suggester for the rest, missing node packs installed through ComfyUI-Manager with ComfyUI restarted from the card. Every imported graph is checked against ComfyUI's own API export.
- **Projects:** a tree in the rail, Name · Created · Size columns, unused takes, Move to another project from the folder menu. Everything made in a timeline lands in its folder.
- Renders get a name when they are made.
- **The command bar (Ctrl+K):** everything across projects (drafts, renders, timelines, folders, people, settings) with a preview, and commands from the keyboard: go to any screen, queue, cancel and reorder jobs, reuse a render with or without its seed, split a clip, flip a setting, bring back an earlier prompt, empty the bin or put it all back, and a calculator for frames, seconds and sizes on the model's own grid (`=`). Prefixes narrow it: `>` commands, `#` places, `/` settings, `!` queue, `"` prompt history, `?` keys.
- Projects in the rail (pinned ones as buttons, moved with Alt+arrows) and folders in a breadcrumb; the Bin as a place of its own.
- **Mirror** a picture (horizontally or vertically), from the viewer or the right-click menu: a new kept copy beside it.
- **For the web** on export: a copy at most 10 or 25 MB, 1280 px on the long side, 30 frames a second.
- The Designer as a side panel, in Studio and for each clip of a timeline.
- Keyboard: a searchable sheet of every shortcut; S or Ctrl+B splits a clip at the playhead; L / Shift+L reuse a render with the same or a new seed.
- Queue: the running job's live speed, elapsed time and seed; waiting jobs grouped by model, with the model each one loads.
- Settings → Appearance: play videos and sound on hover (per browser).
- The timeline player is checked frame by frame in headless Chrome in CI, and the export in the tests.

### Changed
- The presets that ship are on the official model releases (Krea 2 Turbo, MiniMax H3, Wan 2.2 image to video, LTX 2.3 distilled), fetched from the publishers' Hugging Face pages. Community fine-tunes are shared as preset files instead (Save as a file, Import); `presets/README.md` says how.
- Krea 2 runs on the shared flow recipes, like the other picture families.
- **Studio Dark with the coral accent** is the default theme; the light themes were redone so they read.
- One list of actions per kind of media, the same in the grid, the viewer and the command bar; menus stay inside the window.
- Clicks change the screen at once (keep, rename, move, bin, put back) and overlays open and close without waiting.
- **A blank draft is no longer saved:** a new form is written once it holds something (a prompt, a picture, a name, someone from the kit, a render). No more "No prompt yet" drafts in the lists.
- Faster at scale: the library and the Queue's history hold up at thousands of items, and the first load is lighter.
- A missing node pack is named on the form and in the queue, with how to install it.
- A clip added brings the whole timeline into view; the zoom goes down to 2 px a second for long videos.

### Fixed
- Timeline splits, landings and undo; videos are cut from their files.
- Queue, migrations, bin and backup fixes from a full code review.
- The web app: error boundaries, fewer refetches, contrast, drafts and the Create form.
- A hand-trimmed clip that carries on from the one before lands on the model's own frame grid, so the join stays seamless.
- A failed render says where it failed; a render lost in a restart is not rendered twice; Undo after a take lands in order.
- Linked folders never lose a row to a bad read, a rename or a split.
- The workflow importer reads the output's real frame rate, start and end pictures by their wiring, and duplicate node ids.
- Typed values in steps of 0.01 (denoise) are no longer rounded to the slider's step.

### Security
- Cross-site and unmarked writes are refused (every write needs a JSON body, a file upload or the `X-Afflatus` header).
- Uploads are marked, linked folders and outbound fetches hardened, hostile workflow files refused.
- A stored LLM key stays on the server; frame and cross-site read protection; PNG text and ffmpeg inputs are bounded.

## 0.2.1 - 2026-10-06

### Added
- The workflow import screen as three steps, a model guess from the loaders' files, and a form strip that folds.
- Missing node packs installed through ComfyUI-Manager, with ComfyUI restarted from the card; each missing file gets a source (Manager's list, the author's notes, the author's other models).
- A favicon of its own.

### Changed
- The README rewritten for a newcomer.
- ComfyUI-Manager: the Settings card and the docs say it is built into ComfyUI (`manager_requirements.txt`, `--enable-manager`), and that behind `--listen` it needs `network_mode = personal_cloud`.
- The first run against a bare ComfyUI says why nothing is on and offers the SDXL base model as a start.

### Fixed
- Helm chart: the probes call the pod as `localhost`, so the host check no longer keeps the pod from getting ready.
- A seed fed by a link no longer shifts the values after it in an imported workflow.

## 0.2.0 - 2026-10-05

### Added
- Timelines in the Studio, and the library over the timeline editor's stage.
- A forecast of each render's time, learned from your own renders.
- Compare two takes side by side; rename anything.
- Timeline joins: take-over point, sound hand-over, player pre-roll and colour matching across the cuts.
- Continuity figures per take (run-up end, look).

## 0.1.0 - 2026-10-05

The first release: the Studio and its library, a form per model family, timelines, the prompt kit, imported workflows, the queue, the node pack, the Docker image, the Helm chart and the desktop bundles.

[Unreleased]: https://github.com/bardak971/afflatus/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/bardak971/afflatus/releases/tag/v0.3.0
