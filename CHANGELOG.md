# Changelog

Every release of Afflatus, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/) (0.x: anything may still change between minor versions). The bundles and the image of each version are on the [releases page](https://github.com/bardak971/afflatus/releases).

## [Unreleased]

### Added
- **Hand detailer** (H): a one-click pass beside the Face detailer, the same tool with the hand detector, denoise 0.35, crop factor 2 and a hands prompt; in the form, picking a hand detector moves those settings to hand values (what you set yourself stays).
- **A keyframe for LTX 2.3:** a picture the clip passes through at a moment of its own, with its strength, in one pass and in two (a guide at each size); on its own it decides the shape.
- **NAG for Wan Turbo:** the negative prompt acts at CFG 1 (KJNodes' WanVideoNAG), on by default in Turbo, with its scale.
- **Hires fix for FLUX.2 Klein txt2img**, as the other families have it: an upscale model, then a light Klein pass, in tiles past about 2.5 megapixels.
- **Z-Image:** Z-Image Turbo and its fine-tunes as a built-in family, from ComfyUI's own template (8 steps of res_multistep at CFG 1): txt2img with hires fix, img2img, inpaint, outpaint, upscale and face detailer, its three files downloadable from Settings → Models; Z-Image Base starts on its own sampling (30 steps, CFG 4). Lumina 2 files are no longer taken for Z-Image.
- **Few-step SDXL checkpoints** (DMD2, LCM, Lightning, Hyper, Turbo) start on their own sampling, and a model's matching presets combine: an Illustrious DMD2 merge gets few steps and Illustrious's quality tags.
- **Official presets** in the Prompt kit for FLUX.2 Klein 4B, Qwen Image 2512 (with its Lightning LoRA), Qwen Image 2.1 and Wan 2.2 text to video (with lightx2v's 4-step LoRAs).
- **16:9 and 9:16 shapes** on every picture form, at each model's own size (SDXL 1344×768, FLUX.1 / Krea 2 / Klein 1360×768, Z-Image 1280×720, Qwen 2.1 1376×768), and Qwen Image 2.1's official 2K shapes.
- **Colour match to the first frame** (ComfyUI's ColorTransfer, one transform for the whole clip) for Wan, LTX 2.3 and MiniMax H3, off by default.
- **NAG for LTX 2.3** (KJNodes' LTX2_NAG): the negative prompt at CFG 1, off by default.
- Presets for Krea 2 RAW (52 steps, CFG 3.5) and for distilled FLUX.2 Klein files (4 steps, CFG 1).
- **SDXL inpaint with ControlNet Union ProMax's repaint mode**, when that ControlNet is there: the painted part fits the picture around it at a high denoise.
- **Z-Image's Fun ControlNet Union 2.1** as an optional file (Settings → Models): inpaint and outpaint are guided by it when it is there.
- **Colour match after Upscale 2×'s light pass** (every picture family, on by default): the pass no longer shifts the colours.
- **Sharpen after a video upscale (RCAS)**, KJNodes' contrast-adaptive sharpen, on the Wan, LTX and H3 forms and in the timeline's Finish; off by default.
- **Face and hand detectors** as downloads in Settings → Models; picking the hand one in a face detailer fixes hands.
- **Wan: the high-to-low handover worked out** from the steps and the shift (where the noise falls below the level the two models were split at), so it follows a changed shift or step count; a share typed in still overrides it.
- **Mirror on a pinned keyframe:** right-click a clip's pinned frame (on the track or in the Inspector) → Mirror ↔, or Ctrl+K `> mirror pin`; the picture is flipped as it is sent to ComfyUI, the library picture stays as it is, and the thumbnail shows it flipped with a ↔ mark. A frame carried on from the clip before, or one the clip after lands on, cannot be mirrored.
- **Ctrl+K: a kind typed first** ("draft", "timelines", or its start: "timel") lists that kind, newest first; the words after it narrow the list.
- **Drafts across models:** the stage, the lists and Ctrl+K say which models a draft was tried on; Duplicate wherever a draft shows.
- **DaSiWa's model presets built in** (with his agreement): H3 Hybrid v3 / v3 int4 / Turbo v3 / v4 / v4 Turbo, Krea 2 DarkDesire, LTX DragonLeap and GoldenLace, Wan SnatchKiss; presets carry their author's links, and the download button shows on every preset.
- **Viewer keys** for Wipe, Swap, Mirror, Rename and Open.
- A person's voice sample from the computer is kept with them in the Prompt kit, like their pictures, not in the library.

### Changed
- **Defaults brought to the model authors' settings** (their cards and ComfyUI's own templates): Krea 2's hires fix 1.5× at 0.35, Z-Image 8 steps and its hires fix 1.5× at 0.3, Qwen Image's hires pass on the Turbo steps when Turbo is on, few-step SDXL presets on sgm_uniform with short hires passes, Lightning / Hyper 2- and 4-step files read from their names, Animagine 4's CFG and tags, schnell's hires steps.
- **Wan Turbo runs Hybrid by default:** the first step on the high-noise model without the turbo LoRA, where the motion is decided (about a fifth more motion in a render pair, the picture the same).
- **MiniMax H3's latent re-sample** starts lighter: 0.15 in 2 steps (about sigma 0.66 at shift 11, what DaSiWa's tiled upscaler runs) in the form and in the timeline's Finish; 0.3 in 3 steps started near 0.82 and shifted colours.
- **Model downloads:** with ComfyUI on the same machine, Afflatus downloads the files itself into ComfyUI's model folders: two at a time, picked up again where they stopped after a cut (five tries), free space checked before and size and SHA-256 after, written as `.part` and renamed once complete. With ComfyUI on another machine, the node pack (0.11.0) does the same. ComfyUI-Manager is only the last resort.
- **One menu per kind:** a timeline, a draft, a folder and a project each have one list of actions, the same in the Studio's cards, the Projects panel, Ctrl+K and the drafts list (same order, names, keys, and one Delete question each); the right-click menus gain Render missing, Finish, Export and Fix all. The rail's pinned project keeps its short menu and gains Show in Projects.
- **Faster at scale:** the drafts list (about 20× on a large library), the families filter and the queue history through new indexes; a finished render reads only the library's first page instead of every page scrolled; `/api/setup` sends each model folder's list once (813 kB → 83 kB on a library of 362 LoRAs); repeated searches are kept for half a minute; a smaller first download of the page.
- **The designer has one look** in Create and the timeline (a slim header, the LLM and system prompt as one chip, earlier exchanges folded) and Start over in its header.
- **The queue goes offline while idle** when ComfyUI stops answering, and forgets the model it had loaded.
- ComfyUI's input and output folders are cleaned with any job, at most hourly: a Director picture no longer waits there for the next Director job.
- **Unload models** follows one rule everywhere: off while ComfyUI is offline or a job runs.
- Right-click menus take the keyboard focus (a screen reader follows them; Space acts like Enter, Home and End jump), and Shift+F10 opens a menu on its first row.

### Fixed
- **Advanced Output settings shown again:** Upscale 2×'s strength, SeedVR2's frames and the colour match were filed nowhere in the form; they are in the Output chapter's upscale group.
- **The preset menu** says which preset the form is on, and its search finds presets by their author and note.
- One-click passes on an edited copy (a mirror, a cut) use the render it came from: its checkpoint and settings, and its family's tool, instead of a default checkpoint.
- **Krea 2's hires, tiles and Upscale 2× passes** keep the model's own shift (mu 1.15, as Krea gives it for every size) instead of one extrapolated from the larger size, which started them with far more noise than asked for.
- Large downloads through ComfyUI-Manager stopping with "ComfyUI-Manager dropped the connection": Manager held the whole file in memory, and Windows refused past a few GB.
- **SDXL outpaint:** with xinsir's ControlNet Union ProMax it continues the picture in repaint mode, from the picture stretched rather than grey, without the frame or the seams it used to draw; the picture itself is put back at its own size instead of coming back redrawn and softened.
- **LTX 2.3:** the ×2 latent upscaler slot no longer takes the ×1.5 file, which the two passes would have made a clip at three quarters of the size from.
- **Outpaint for FLUX.1, Qwen Image and Z-Image:** the new part starts from the picture stretched rather than grey, a light seam pass goes over the join, and the picture itself is put back at its own size: no more line where the two meet, and no softened picture.
- **Model downloads say what went wrong:** a source that cannot be reached (refused, unknown host, a bad certificate) fails at once with "could not reach <host> (<code>)" instead of five tries ending in "cut at 1 MB"; a failure nobody read stays listed for a day and is written to the server's log. A source is fetched only from the internet (a pretend Civitai by its host and port), never on from https to http, and a `.safetensors` that is not one is refused before it is named. A node pack that answers nothing useful no longer leaves a download "downloading" for good. A second Afflatus started on the same data folder stops before touching it.
- **Node pack 0.11.1:** a download of unknown size is refused and one is never written past its size; at most two at once; a stopped download says so at once and can be asked for again straight away; `.part` files left by a ComfyUI stopped half way are removed at its next start; a sub-folder linked to another drive is refused instead of failing with a 500.
- **Form values the render refused:** a slider's ends (Wan's Resolution at its right end gave 1088 against a 1080 limit; it now goes to 1088 on its grid) and typed numbers step from their minimum; an imported workflow's setting whose saved value lies outside the range Afflatus gives it (Wan's `end_step: -1`) is accepted every time, not only on the first render, and workflows saved before are healed when built.
- **Stop during a render's uploads** stops it: no more uploads, no freeing of ComfyUI's memory and no prompt sent after it; ComfyUI is asked to interrupt only a prompt that is running.
- **Media fields** (picture, clip video, references, sound) all show a file being added and say why one was refused; a file of the wrong kind is refused in words.
- **Clip form edits** are kept when the page is reloaded at once, saved one at a time, and the browser asks before closing while a save has failed; Mirror on a pin just changed keeps its flip.
- A right-click menu left open no longer takes the keys of Ctrl+K opened over it.
- The timeline editor's header keeps every button reachable down to 800 px (Finish and Export become icons), and Settings' search stays reachable on a narrow window; the status bar fits at 500 px.
- Splitting a clip finished by SeedVR2, RTX or an upscale model no longer marks its second half "Mirror changed" (Render missing would have rendered it again).
- Removing a take whose video lies in a linked folder leaves the file in that folder instead of binning it (emptying the bin would have erased it from the disk).
- A library search with a control character in it no longer fails; a page on another port of the same machine can no longer make Afflatus build a backup; a live preview is only served as a picture or video.
- Load works on a form that has not got its pictures yet; Ctrl+Enter in Ctrl+K no longer starts a render; a dismissed download failure stays dismissed after a reload.
- Importing a preset file that is not one says so plainly; Copy link and copying a snippet say they did.

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
