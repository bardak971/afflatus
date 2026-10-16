# Changelog

Every release of Afflatus, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/) (0.x: anything may still change between minor versions). The bundles and the image of each version are on the [releases page](https://github.com/bardak971/afflatus/releases).

## [Unreleased]

### Fixed
- **A pod whose start fails no longer bills on unseen:** a start that stopped at a step (a full volume, a write refused) exited, RunPod started it again, it failed at the same step, and so on with no watchdog, since the watchdog runs inside ComfyUI. It now stays up with its watchdog armed from the pod's settings, as a pod whose GPU fails does: Afflatus terminates it at once when it reads the failed step, and with Afflatus away the pod stops itself after the watchdog's minutes.
- **The watchdog's stop:** a stop RunPod refuses or does not carry out was asked again every 5 minutes forever. After 3 tries the watchdog terminates the pod instead (a network volume keeps its files); it says so in the console and in `GET /afflatus/alive` (`tries`, `end`).
- **InsightFace's face models:** a pod ended while they were being unpacked left a part of them on its volume, and every later pod on it gave no Face Match or Face At figure. They are fetched beside the models folder and moved in once whole, and a folder without both model files is fetched again.
- **The ComfyUI lock:** a ComfyUI locked through its lock file stops, naming the file and `AFFLATUS_LOCK=off`, if the lock cannot be put in front of its server (it ran open before; a pod's environment token already stopped it). A renewed token is in force at once, also on a disk whose clock ticks coarsely (FAT, exFAT, some network shares).

### Changed
- **Afflatus's pod image 0.1.13:** the node pack 0.20.0 and the fixes above, and the boot steps' count (`pip: ComfyUI-KJNodes (3/14)`) the 0.5.0 notes describe, which 0.1.12 did not have yet. A published image is built only with Manager's registry list in it (a pod of an image without it waits on billed time before Manager can install a pack by name), and a release checks that the pod image it deploys is built from its own pod files.

## [0.5.1] - 2026-10-16

### Added
- **Export CSV** on the Queue's **Costs** and **Render times** tabs: what the tab shows (its window and filters), every row, built by the server. Costs: one row per pod session (its boot split, files fetched, render, idle, its cost) and this month's volumes; Render times: one row per render (machine, GPU, model, size, steps, its time split, VRAM and temperature peaks, its cost). Standard CSV (comma, dot decimals, UTF-8, times in UTC), no prompts; cells that would read as a formula in a spreadsheet are guarded.
- **Busy outside Afflatus:** a ComfyUI running work queued from elsewhere (its own page, another tool) reads so on the machines pill, its card, the Queue and the status bar ("1 prompt running, 2 queued in ComfyUI") instead of idle. Afflatus sends it nothing meanwhile (another machine takes the job, or it waits in Afflatus's queue), does not unload its models, and does not call a render waiting behind that work stuck. A rented pod is not stopped by its idle time while that work runs; spending caps still stop it.
- **Outside Afflatus in Costs:** a pod's time on that work is recorded and shown as its own part of the session, no longer as idle; the idle advice and the CSV (`outside_s`) count it as used.
- **Create's stage:** a result picked while a render runs shows **Live preview** over it, with the render's step; it or Esc goes back to the live preview.
- **Binning an item a draft still uses** asks once, naming the drafts (each opens it): take the item out of them (its field goes back to empty) or delete them, then it goes to the bin. Several items, one question. The open draft follows on screen.

### Fixed
- **Settings › ComfyUI:** a locked ComfyUI's Access line is whole again in the Connection card: the lock, the token's end, **Copy**, **Renew** and **Unlock** (0.5.0 showed only the switch there, its token out of reach).
- **Spending caps on rented pods:** a cap is read before anything is asked of the pod's ComfyUI, and a render still queued in ComfyUI behind other work is not waited for at a cap (it could bill up to the cap's hour of grace).
- **Several items to the bin at once:** those something still uses (a timeline, the Prompt kit, a job to run) stayed out without a word; it is said now.

### Changed
- Settings › Interface › Progress: the tiles show the motion alone, the help says each by its place.

## [0.5.0] - 2026-10-16

### Added
- **Several ComfyUIs, one queue** (Settings › ComfyUI › Add a ComfyUI): a second GPU on its own port, another PC or a rented pod, up to 12. Each takes jobs from one shared line, a lane each on the Queue page, and every job goes to the machine that will finish it first: when it is free, plus the model load if it does not hold the model, plus the render at that machine's pace, learned from your renders (compared once it has 3 of the same settings). **Takes** (Everything / Pictures / Videos), pins (drag a waiting row onto a lane, or **Run on ▸**), **Use only X**, Pause all. With one ComfyUI nothing changes on screen.
- **Models per machine:** Settings › Models gets a tab per machine and an **All** grid of families against machines, each machine with its own family switches; a job goes only where its files are, and one pinned to a machine that lacks them lists them with **Download to X**.
- **Generate or render on a machine:** with several, the Generate button, New take, Render all and Render picked get a machine slice (Auto, or a machine with its waiting count, "holds this model" and its time); the pick is kept per draft or timeline. Ctrl+K: `generate on X`, `render missing on X`.
- **Load a model** (the status bar's model menu, a machine's menu, Ctrl+K `load a model`): a dialog with the open form's model first, then recent drafts' models, then any file, loaded with a one-step job so the next render samples at once.
- **The machines pill** in the status bar, with several machines or a rented pod: a dot per machine, the busiest's state and the GPU and VRAM of the one you pick; a click lists them, a right-click opens a machine's menu. Machine commands in Ctrl+K (pause, use only, unload, load, open ComfyUI, its log, its render times, its models).
- **Lock a ComfyUI to Afflatus** (Settings › ComfyUI, its Access line; node pack 0.12.0). ComfyUI has no login of its own: anything that reaches its address can run work on it, and ComfyUI-Manager installs whatever it is asked to, the way a botnet took over ComfyUIs left open on the internet in 2026. **Lock it** makes a token, locks the ComfyUI and checks it took (refused without the token, answering with it); from then on every call needs the token, Afflatus's own included, and the browser logs in once. Opening ComfyUI from Afflatus (a machine's menu, `open comfyui` in Ctrl+K, a workflow opened in ComfyUI) lands logged in, through a one-time code. Renew, Unlock, Copy token for other tools (only on the computer Afflatus runs on), and "No token needed from this PC" for tools on ComfyUI's own computer. The login cookie counts only from ComfyUI's own page, not from a page another program serves on another port of the same computer. A machine locked against Afflatus's token says "locked", not "offline", with a field to paste its token. An old ComfyUI-Manager (before 3.38) is pointed out. Nothing is locked until you press Lock it.
- **Rented GPUs on RunPod** (Settings › Rented GPUs, once your API key is in): your pods listed, each added as a machine as it is; Afflatus never starts one on its own (**Start…**, its rate said first). Running, it takes work like any machine; stopped, it takes none. A pod with the Afflatus node pack is locked from its first second. The demo has a pretend RunPod (`DEMO_RUNPOD=1`, key `demo-runpod-key`).
- **Deploy a GPU** (Ctrl+K, the machines pill): what RunPod has free now, by price, read every 15 s (Secure or Community Cloud, on demand), Afflatus's pod image (locked, with a watchdog) or RunPod's ComfyUI (not locked), its own disk or a network volume, what to do when it is idle, and the models it gets. Billed from the deploy; it is added as a machine at once. A pod not up within 20 min, or whose GPU fails on its host, is terminated. **Deploy again** repeats the last one, its rate asked first.
- **Hunt a GPU:** when the GPU you want is not free, RunPod is asked every 30 s and the best usable one within your price is deployed the moment it is free: best value (what a render costs on it, from your own renders there, or a guess), fastest, or cheapest an hour. This PC rests meanwhile, or keeps rendering; it gives up after the time you set. A status-bar strip says how it goes.
- **Models onto a pod:** the files the jobs planned there need come first, then the deploy's ticked files and a model set. A file comes from Civitai or Hugging Face only when it is proven to be the same bytes as this PC's copy (by SHA-256), through a signed link so your keys never leave this PC; otherwise it is uploaded from this PC. Node packs a job needs are installed through the pod's ComfyUI-Manager. The Queue page says what a pod is getting; the Deploy dialog says how long and what it costs, from your past deploys.
- **Model sets** (Settings › Models): named lists of model files (presets' and your own) to carry to a pod or a new PC, saved as a file without the models in it; **Get the missing** on any machine.
- **Network volumes** (Settings › Rented GPUs): make (Secure Cloud, where GPUs are in stock), grow, fill from a model set (the cheapest GPU there, terminated once the files are in, always ended), delete; what each holds; a volume no pod ran on for the days you set is flagged with what it costs.
- **What rented GPUs cost:** today and this month are RunPod's own bill (GPU and pod disks), with Afflatus's count where the bill is still to come; the balance and how long it lasts; storage (volumes, disks, a month as it stands). Daily and monthly **caps**: at a cap the pods stop once their render ends (an hour at most) and Start, Deploy and Hunt are refused. A render is not sent to a pod the balance would not see through, and a render stuck on a pod (silent 30 min past its forecast) fails instead of billing.
- **Notifications on Telegram and Discord** (Settings › Interface › Where and What), one way, beside the browser's: render done (off by default), render failed, render stuck, queue empty (with what rented GPUs cost), ComfyUI offline mid-render, pod stopped by Afflatus, spending cap reached, RunPod balance low, GPU found, hunt gave up; a small picture of what was made; secrets kept on the server.
- **Motion transfer** (Shift+M on a picture or a video, or the model in Create): a picture moved the way the people in a driving video move, its room, light and people kept. **SCAIL-2**: up to 20 s a job at 16 fps (RIFE ×2 on), several people paired left to right, biggest first or as found. On ComfyUI's own nodes (a recent ComfyUI), their files one click in Settings › Models.
- **The picture for motion transfer:** no picture yet? Under the Picture slot, 1 to 3 photos of who goes in are put into the driving video's frame and relit (Qwen Image 2.1), three at a time, ranked by face likeness (node pack 0.16 with InsightFace).
- **The timeline's source lane:** a long video dropped under the clips (or a video clip's **Motion transfer in windows…**) is made into motion-transfer clips window by window, each carrying on from the one before, all sharing one picture and one prompt; played on the timeline's playhead, its start and end dragged on its lane. The last window runs to the source's end (no short last clip); Delete on the source removes it with its clips, and Undo brings them all back. A clip of another model than the clip before it, added or switched, starts with a cut.
- **Transitions on cuts:** cross dissolve, dips to black and white, flash, wipes, slides, a circle and a zoom, centred on the cut (no clip moves), from a strip under the track or a join's panel; rendered in the export, played in the player, markers in the editor zip.
- **MiniMax H3 · Lip sync:** a new shot made around a recording, the mouth following it and the recording as its sound; its part chosen on its waveform, ending on the recording's own pause.
- **Export for a video editor:** the Export dialog's For switch (Video file / A video editor), or `export for resolve` in Ctrl+K. A zip of every clip's whole file with its in and out points, its sound, the music as heard (ducked), and project files for DaVinci Resolve and Premiere Pro (FCP 7 XML) and Kdenlive (OpenTimelineIO). Seamless joins stay seamless as plain cuts; nothing is rendered again.
- **Grain and face figures** along a timeline: grain against a cleaned copy (sharpness is now measured without it), and face likeness against the person's pictures (H3) or the motion transfer's picture, with a warning when a clip drifts.
- **Find models** (Settings › Models › Your models online, a model set, the Deploy dialog): Civitai (types, your families' base models, sort, period; adult models left out unless you turn on All of Civitai) and Hugging Face, as cards, picked into a tray and fetched where you opened it from.
- **Your models online:** every model file of this PC hashed once in the background (SHA-256), so a model is recognised on Civitai or Hugging Face by its bytes, not its name.
- **A Hugging Face token** (Settings › Models) for gated models, sent only to Hugging Face.
- **What each model is for:** a `?` beside the model in the form and in the model lists: what it makes, what it is best and weak at, the operation picked.
- **Image to video and Motion transfer submenus:** with several models that can do it, the menus list them, the one used last first.
- **Trim on a sound:** the viewer's Trim (T) opens a sound's whole waveform, pauses marked, ends snapping into them: copy, split or remove a range, with its loudness evened out if you like.
- **Remove sound** from a video: a copy without its sound beside it in the library, the video itself untouched; nothing encoded again, no GPU. In every place that lists a video's tools, beside Extract audio.
- **Renders say they are AI-made:** a PNG picture or a video downloaded from the library, a timeline export and the zip for a video editor carry a machine-readable mark when they come from a render (or a frame, cut or copy of one): IPTC's digital source type "trained algorithmic media" in a picture's XMP and an "AI-generated (Afflatus)" comment in pictures and videos. What you brought in is never marked. The library's own files stay as ComfyUI wrote them, and a marked video holds the same frames.
- **Progress style** (Settings › Interface › Progress): every progress bar and the Queue ring move one way of your choice: Same look, Glide (the default: the bar glides at the render's own pace), Steps (a tick per step, nothing moving in between) or Alive (a light along the bar, a dot round the ring); per browser, Steps when the system asks for less motion.
- **Queue › Costs:** where the rented GPUs' money went (each pod session split into rendering, booting, fetching files, idle and failed renders, adding up to its length and cost), spend per day by GPU with the day cap, renders by project, a render's cost by model and GPU, advice, and this PC's electricity from the GPU's power while it renders (Settings › ComfyUI › Electricity; node pack 0.18).
- **An optional password** (Settings › Interface › Access): off until you set one. A sign-in page, the devices you stay signed in on, sign out everywhere, a forgotten password reset by a code sent to Telegram or written to this computer's console and log (`reset-password`, `AFFLATUS_RESET_PASSWORD`). Behind a TLS proxy on another machine, `TRUST_PROXY` makes the cookie Secure.
- **A prompt found in Ctrl+K** (`"` or `prompt:`) opens what it made: a clip's take on its timeline with the clip selected, any other render in the viewer, else its draft.
- **Sizes count what an item keeps beside its file:** an H3 render's latent, a model's own frames; the Projects panel, a folder's size and the bin say the whole.
- **A pod's boot, seen:** a deployed pod says where its first start is, the same line on its card, the status bar's machines pill and its popover: `pulling image · 2m 14s · $0.016`, then `starting ComfyUI`, then its boot log's step (`pip: ComfyUI-KJNodes (3/14)`, `loading custom nodes`), each with its time and cost so far. Afflatus's pod image (0.1.12) keeps a boot log, every step and ComfyUI's own start, served behind the lock's token; the Queue's log tab shows it until ComfyUI answers. A start that fails is terminated at once, its last lines kept, instead of billing to the 20-minute limit.
- **Costs: what a boot cost.** Each pod session's boot is split into pulling the image, node packs, starting ComfyUI and failed starts, still adding up to its length and cost; advice when image pulls or node pack installs add up. Earlier boots stay whole.
- **Server figures in /metrics** (prom-client): event-loop lag, memory and garbage collection, and per machine the time Afflatus adds to a render (before its first step, filing, measuring); a Server row in the Grafana dashboard.


### Changed
- **Downloads straight from the source** into a ComfyUI on another machine (node pack 0.12.0): Afflatus asks Hugging Face or Civitai with your key, here, and hands the pack only the temporary signed link they answer with, so the file comes from their servers at their speed, never through this computer's upload, and your key never leaves it. A link that expires half way is sent again, and the download carries on from where it was.
- **MiniMax H3's voice sample:** the whole sample up to 15 s by default (was 8 s), its loudness evened out; a person's part of their sample is chosen on its waveform in the Prompt kit and sent with every render of them.
- **Video forms say what they run:** no Auto; H3 and Wan show their steps and shifts, a distilled H3 file starts on Turbo.
- **Settings:** ComfyUI, Rented GPUs and Models in two columns on a wide screen; Settings › Models' family panel says what each operation lacks.
- **A new timeline** is made in the folder that is open in the Studio: it lives and renders there.
- **Inputs:** a motion transfer's in the order they are used; a tab you click wins over the one brought forward for a missing input; "txt2vid" only when a clip starts from words alone.
- **Faster with several machines and while rendering:** the machine check keeps ComfyUI's node list and the recipes' checks (the queue answered in milliseconds instead of up to 3 s); forecasts kept until a render lands; a machine is free for its next job once a render's files are stored, its figures read after (one decode instead of eight); a picture goes up once per machine; the tab stays light while rendering (a third of the CPU it took), the Studio no longer keeps old tiles in memory, and the Queue's answer is paged.
- **Afflatus's pod image 0.1.12:** the node pack 0.19.1 (Face Match and Face At, the GPU's power, the pod's disk said and room made on it, the lock's fix below), and its boot log (below); InsightFace's face models are no longer in the image (their licence is for non-commercial research): the pod fetches them from InsightFace's own release at its start, and a volume keeps them.
- **Render times on several machines and rented GPUs:** a new pod is told the times of the earlier pods with its GPU (else another machine's at its GPU's pace, or the speed table's guess), not this PC's as they were; a GPU's pace counts from 3 renders compared with another's, and per model family; a first cold load reads the machine's own disk; each machine is judged by the model it holds; Finish and Render missing count the machines working side by side; Auto only among the machines that have the job's files.
- **Hunt a GPU:** a GPU's time is "from your renders" only from 3 of them (one render made a slow card look as fast as the rest); the GPU's pace is applied once; a guess rests on a rented card before a home one; the 40, 30 and 50 series and the RTX A4000/A4500 are in the speed table; each GPU says what a deploy bills besides its renders (the usual boot and idle, from your sessions).

### Fixed
- A form with a cast shows the voice sample the cast adds in its voice field, as it shows the cast's pictures.
- After a split or a remove, the viewer goes on to what it made instead of staying on the binned original.
- A part reaching the end of its video or sound keeps that end (a 5.04 s video was cut to 5.0).
- **Exports of long timelines** no longer fail on Windows (past about 48 clips with transitions); long timelines are exported in pieces, at about half the memory.
- **Downloads of render videos** are streamed: a file past 2 GB downloads (it failed), and memory stays flat.
- A stuck render on a rented pod fails after 10 minutes of silence with its GPU idle, instead of 30 minutes or more past a forecast that could be far off.
- **Render times:** a model's first finish was priced as a draft (94 min said for 5); a form far past anything rendered says no figure rather than a straight-line guess (6 h said for 4 min); Qwen edit, Make the picture, Fix face and Remove background learn from their own renders; a picture redrawn in tiles is no longer priced on its tiles twice; a warm render that had to load again no longer makes the next ones of that model look slow; the old Motion transfer renders recorded with 4096 frames are corrected.
- A rented pod's balance check counts the files still to fetch and a margin while the pod has no renders of its own.
- **Rented GPUs' money:** a pod's hourly rate counts its own disk while it runs, as RunPod bills it (the GPU's price alone was counted); the balance's runway counts volumes and stopped disks, the same on Costs and in Settings; a pod's idle clock is kept across a restart of Afflatus (each restart gave an idle pod a new idle period); the queue-empty cost counts the deploy's boot and files; a Start is counted from when the pod is seen, not from its last run; a cap acts on a pod still booting and terminates a deployed pod set to terminate (a stopped one went on billing its disk); after a restart, a pod reads checking rather than gone until RunPod is read; a render with no forecast is weighed at half an hour against the balance; Costs says what RunPod billed that is not split into sessions.
- **The queue:** an export or a cut waits again for the renders queued before it (it could start at once and leave out the new take); one 502/503/504 from a proxy in front of ComfyUI or RunPod's no longer fails a render that goes on; jobs pinned to a machine taken out go to any machine (and no longer hold an update); a render whose machine stopped answering waits for that machine before it is sent elsewhere; a finish or RIFE pass that hangs on a pod is held to the stuck limit.
- **Rented pods' files:** one RunPod read without the pod no longer drops its downloads and uploads; an upload starts again when the pod's ComfyUI restarts mid-way; a job's hires upscaler, detector or ControlNet is fetched with its model (thirteen SDXL renders failed on a pod without it); a job pinned to this PC no longer has its files fetched onto a pod; a deploy made while the queue is paused still gets the waiting jobs' files.
- **A pod is not idle while its files come:** its idle stop waits for the last file (never past five minutes without a byte), and every screen says it is getting files. A pod deployed or started after Pause all joins paused.
- **Queue › Costs** answers at once: it asked RunPod four times in a row (1.5 s on opening); the last figures stay on screen while another window loads.
- **Go back to the previous version** is refused while a rented GPU runs or a hunt is on, and says which stopped pods and volumes keep billing.
- **Security:** the backup zip leaves out keys and tokens (a copy with them only from this computer); downloads from a link you give are checked against addresses inside your network where they connect, however the address is written; the ComfyUI lock's "No token needed from this PC" needs a request from ComfyUI's own page or Afflatus's (node pack 0.19.1); the token no longer goes in the websocket's address; model names a ComfyUI lists are kept inside its models folder.
- **Exports in pieces** are the same as the whole export on ffmpeg 5 and 6 too (Docker, Ubuntu): two frames and the sound's last packet were lost.
- A job pinned to a pod still booting has its files fetched as soon as the pod answers, even with no page open; the pod no longer idled toward its terminate, billed, with the job waiting.

## [0.4.0] - 2026-10-12

### Added
- **Afflatus updates itself.** Once a day it asks GitHub for its latest release (one request, nothing about you in it; a switch in Settings → About). A new version shows as a dot on Settings, and About gives its notes. The Windows, Linux and macOS bundles install it in one click: signed (Ed25519) and checked, unpacked beside the running version, switched once the queue is done (a render is never cut), with the version before kept and **Go back** to it, the library as it was at the update. A version that does not start falls back to the one before. Docker and the sources get the notice and the command. Update and Go back only from the computer Afflatus runs on. From 0.4.0 the bundle is one `Afflatus` folder (`versions/` beside `data/`), and 0.4.0 started beside a 0.3.0 folder offers to bring its library over, moved rather than copied.
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
- **DaSiWa's model presets built in**: H3 Hybrid v3 / v3 int4 / Turbo v3 / v4 / v4 Turbo, Krea 2 DarkDesire, LTX DragonLeap and GoldenLace, Wan SnatchKiss; presets carry their author's links, and the download button shows on every preset.
- **Viewer keys** for Wipe, Swap, Mirror, Rename and Open.
- A person's voice sample from the computer is kept with them in the Prompt kit, like their pictures, not in the library.
- **Tests that draw the web's components** (menus, the command bar, the media slots, the update states) and checks in CI for import cycles, exports only tests use, and the shared helpers written out by hand again.

### Changed
- **Defaults brought to the model authors' settings** (their cards and ComfyUI's own templates): Krea 2's hires fix 1.5× at 0.35, Z-Image 8 steps and its hires fix 1.5× at 0.3, Qwen Image's hires pass on the Turbo steps when Turbo is on, few-step SDXL presets on sgm_uniform with short hires passes, Lightning / Hyper 2- and 4-step files read from their names, Animagine 4's CFG and tags, schnell's hires steps.
- **Wan Turbo runs Hybrid by default:** the first step on the high-noise model without the turbo LoRA, where the motion is decided (about a fifth more motion in a render pair, the picture the same).
- **MiniMax H3's latent re-sample** starts lighter: 0.15 in 2 steps (about sigma 0.66 at shift 11) in the form and in the timeline's Finish; 0.3 in 3 steps started near 0.82 and shifted colours.
- **Model downloads:** with ComfyUI on the same machine, Afflatus downloads the files itself into ComfyUI's model folders: two at a time, picked up again where they stopped after a cut (five tries), free space checked before and size and SHA-256 after, written as `.part` and renamed once complete. With ComfyUI on another machine, the node pack (0.11.0) does the same. ComfyUI-Manager is only the last resort.
- **One menu per kind:** a timeline, a draft, a folder and a project each have one list of actions, the same in the Studio's cards, the Projects panel, Ctrl+K and the drafts list (same order, names, keys, and one Delete question each); the right-click menus gain Render missing, Finish, Export and Fix all. The rail's pinned project keeps its short menu and gains Show in Projects.
- **Faster at scale:** the drafts list (about 20× on a large library), the families filter and the queue history through new indexes; a finished render reads only the library's first page instead of every page scrolled; `/api/setup` sends each model folder's list once (813 kB → 83 kB on a library of 362 LoRAs); repeated searches are kept for half a minute; a smaller first download of the page.
- **The designer has one look** in Create and the timeline (a slim header, the LLM and system prompt as one chip, earlier exchanges folded) and Start over in its header.
- **The queue goes offline while idle** when ComfyUI stops answering, and forgets the model it had loaded.
- ComfyUI's input and output folders are cleaned with any job, at most hourly: a Director picture no longer waits there for the next Director job.
- **Unload models** follows one rule everywhere: off while ComfyUI is offline or a job runs.
- **The forms read more evenly:** a switch, a chip row or a number box sits at its row's end with the name taking the rest; every "?" comes right after what it explains; long setting names wrap, ten are shorter; nested boxes' corners follow the outer one.
- **Prompt kit presets** are laid out as cells, getting the files first; they show the model's real names and its defaults, are found by author and line, keep their line in a preset file, and ask for the licence only while a file is still to fetch.
- **The bundle's folder:** from 0.4.0 one `Afflatus` folder holds the versions side by side and the library in `data/` (it was inside the version's folder).
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
- **Node pack 0.11.2:** H3 Tail Guide and MiniMax H3 Append Continuation, which Afflatus no longer uses, are marked deprecated (ComfyUI hides them from the node search; saved graphs that name them still load); they are removed in the release after 0.4.0.
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
- Every picture slot has its "?": the Keyframe, and the tool forms' Image and Mask.
- Compare: the wipe fits the stage.

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

[Unreleased]: https://github.com/bardak971/afflatus/compare/v0.5.1...HEAD
[0.5.1]: https://github.com/bardak971/afflatus/releases/tag/v0.5.1
[0.5.0]: https://github.com/bardak971/afflatus/releases/tag/v0.5.0
[0.4.0]: https://github.com/bardak971/afflatus/releases/tag/v0.4.0
[0.3.0]: https://github.com/bardak971/afflatus/releases/tag/v0.3.0
