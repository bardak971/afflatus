# Using Afflatus

A walk through the app once it runs and talks to ComfyUI (see the [install guides](../README.md#get-started) and [ComfyUI setup](comfyui-setup.md) first). Every setting has a `?` beside it with a plain explanation; this page is the map.

## The first launch

A new install opens on **Where you render**: it looks for a ComfyUI on this PC and renders on it in one click, its node pack put in for you; or takes a ComfyUI's address; or goes on with rented GPUs only, your RunPod key and spending caps asked there. It also says once that model lookups are on (your files' hashes sent to Civitai and Hugging Face to name them; nothing downloaded without asking). Settings › About › First launch shows it again.

## The Studio

The Studio is where pictures and videos are made and kept. On the left, the **Create** form (press **N** to open it; it is open on a first landing); on the right, the library.

- **A draft** is one form you are working on: a model, a prompt, its settings. Drafts are saved as you type and listed in the draft menu at the top of the form. A new draft is only kept once it holds something: a prompt, a picture, a name, someone from the Prompt kit, or a render.
- **The form** has one tab strip for every model family: Model · Prompt · Inputs · Sampling · Output · Advanced. Defaults come from ComfyUI's own templates and the models' authors, and what you change can be saved as your default for that model file. Right-click a setting's name to **pin** it to the top of the form, per model family.
- **The four MiniMax H3 forms** (Video with audio, Lip sync, Swap character, Motion transfer) share one skeleton: the same tabs, the same cards in the same order, **What happens** heading the Prompt card, a **Sound** card under Inputs (sound effects, music, the source's sound, the audio guide, loudness). A form only adds what its job needs: Swap's Mask, Motion transfer's Motion.
- **The LoRA list** shows every LoRA a render loads, with its file and weight: yours, and first those Afflatus adds by itself. Turbo's LoRA is a row while Turbo is on (its × turns Turbo off); what a model needs (LTX's distilled LoRA, SCAIL-2's) is a row without a ×. Six places in all, Turbo's counted.
- **Face refine and upscale models, per clip.** Output picks the model the faces are redrawn with (the fused turbo, any H3 reference model, or **Clip's own model**), the latent upscaler and SeedVR2's 3B or 7B; Finish picks them too.
- **Render** (or **Ctrl+Enter**) queues the render. The form shows how long it will take, learned from your own past renders, and a greyed Render says why over it ("Write what happens first.").
- **The library** shows the project you are working in: everything, or one folder, as a Stage (one large item) or a grid in three sizes, filtered by kind. Search reads prompts and names.

Renders start out *not kept*: keep the ones you want (the star, or **S**). What is not kept goes to the bin after a day, and the bin empties itself after a week, so the library holds what you chose. Settings › Storage sets both: 1, 3 or 7 days, or never; a week, 30 days, or until you empty it.

## Projects

Projects group drafts, timelines and folders. The project you work in is chosen at the top left; what you make lands in it, and the library, the drafts and the timelines all show that project. The **Inbox** holds what belongs to no project.

The **Projects** panel lists every project with its folders and drafts, what each holds, when it was started and its size on disk. Pin the projects you use most to the rail on the left. **Ctrl+V** pastes a screenshot, a copied image or copied video and audio files where you are: into an open picker or the slot with the focus, else into the library shown, else the project's. A folder can also be **linked** to a directory on disk: its files show up in the library where they are, without being copied, and an item filed into it is written there as a file with a readable name.

## A picture or a video, up close

Click any item to open it large. The side panel shows everything it was made with and what can be made from it:

- **Reuse** its settings with the same seed (**L**) or a new one (**Shift+L**), make a **Variation** (**V**), or turn a picture into a video (**M**).
- **Passes:** upscale, Face refine, remove background, inpaint, outpaint, edit by instruction, mirror, and more.
- **Compare** two items side by side with a wipe (**X**).
- **Copy** the picture (**Ctrl+C**) or the prompt as sent (**Shift+C**).

The same actions are in the **right-click menu** of every tile, and in the command bar.

## The Prompt kit

People, places, styles, snippets and presets, written once and used with every model:

- **A person** is a few reference pictures, how they look as tags (for SDXL-style models) and as a sentence (for the others), a voice sample (dropped, or recorded with the 🎙), a LoRA per model family when there is one, and outfits.
- **A place** is pictures and words; **a style** is LoRAs and words per model family; **a snippet** is a bit of text you tick on to add it to a prompt.
- **A preset** keeps a whole setup: the model, its form and who is in it. The official ones ship with the app; your own can be saved as a file and shared ([presets/README.md](../presets/README.md)).

Put people and a style into a draft or a whole timeline (**Cast and look**), and each model receives them the way it reads them. On the H3 forms the prompt comes in parts (In the source, How they look, What happens), with `@Name` for anyone in the kit and a Shot size; the prompt as sent shows greyed.

## Models

- **Settings › Models** lists every family, folded to a line that says what it lacks; open one for its files, the folder each goes in and its size. **Get the minimum** fetches what its first operation needs, **Everything** the rest. A **Download** says where the file goes ("→ models\loras", a menu when ComfyUI reads that folder from several places), then its state wherever it shows: In line · 3rd, Downloading 38 %, Here. The Downloads card (and the status bar's chip) holds the line, in an order you drag.
- **Settings › Model files** lists every model file in ComfyUI's folders on this PC: its name and picture where Civitai or Hugging Face match its hash, kind, base, size, how many Afflatus jobs loaded it and when last, what was made with it, what needs it, its extra copies. On top: the files Afflatus never used, the extra copies, the files with no match, the space by last use. **Delete** moves files to the Recycle Bin (or a `.afflatus-set-aside` folder beside the model folders), asking first about one a preset or a model set needs; **Put back** and Undo bring them back, and **Empty** erases them for good, listing what it erases. Drop model files onto the tab and each goes into its kind's folder. Below the table: Your models online, Newer versions on Civitai and Model sets.
- **Find models** (Ctrl+K `find models`, or from Settings) browses Civitai and Hugging Face filtered to your families, and gets a file onto this PC, a pod or into a model set. A version sold on Civitai says **Paid** or **Early Access · until <day>** and is asked about before it is picked.

Renders made straight in ComfyUI are not seen, so Model files says "not used by Afflatus" rather than "not used".

## Timelines

A timeline is a video made of clips. Open **Timelines** in the rail, start one, and drop pictures or videos from the library onto the track (or right-click a picture → **Timeline** → *Start a timeline from it*). The timeline's menu also has **Duplicate**.

- **A clip** is a form of its own. A picture dropped on the track becomes its first frame; a clip can also have a last frame and a keyframe in the middle.
- **The + on a join** puts a new clip between two. Its model list says beside each model how it would meet the clip before: seamless, carries on, or a cut.
- **The join panel** (click the dot between two clips) has two cards, **Seamless** and **Hard cut**, each saying what a switch does to the take before you click: Hard cut plays the take from its own first frame, no render. A seamless join shows how it holds (Join and Run-up end). MiniMax H3's forms carry on in the model's own latent, so the motion and the sound flow across as one shot; LTX and SCAIL-2 carry on from the clip before's frames, Wan through SVI. Where the family changes it is a hard cut, or a transition.
- **A cut at the join.** When a seamless H3 join cut to another shot anyway, the dot turns amber with what was measured, and the take says "cut at the join ×N" with **New take** and **Keep it as a hard cut** beside it.
- **The Source lane:** drop a long video and it is cut into windows, each a clip that carries on from the last: Swap character (someone of your cast, or a reference picture, in place of the person) or Motion transfer, each window's form yours to change. The source stays trimmable; windows past a shortened end are set aside with their takes.
- **The recording lane:** drop a voice or a song on the Audio row and it becomes Lip sync clips, cut at **Clip length** ± a window (at a pause, a timed lyric line, or the quietest moment). A click on its band opens it on the stage with its own panel: In and Out, its clips, **Opens from**, what its clips share, and Render. Each clip under it picks its form: Lip sync, or a form the song plays over. The song plays as one track across the clips.
- **Takes:** each render of a clip is a take. Render several at once (**Takes at once**), and pick the one that plays. Each take shows what it was made with (**Use this take's settings** puts them back) and its face figure against the person; the closest is marked.
- **Removing a clip** of a recording or a source cuts its part out, asked first; the stretch is set aside, back with a click.
- **What it measures:** hover a clip, or open its Takes tab, to see how clean its join is and how its brightness, sharpness and pace compare with the clips around it. **Needs a look** lists the joins that jump and the takes that would join more cleanly; the call stays yours.
- **Editing:** trims (with scene detection), split at the playhead (**S** or **Ctrl+B**), stills held on screen, undo and redo.
- **Sound:** each clip's own sound, an audio file, a recording from the 🎙, or muted; up to six **sound cues** pinned at moments of an H3 or LTX clip; a music track that ducks under voices.
- **Finish** brings every clip to its final size in one pass (SeedVR2, RTX Video Super Resolution, an upscale model, or for H3 a re-sample of the draft's latent), with Face refine where there is a person. A finished take plays in place of its draft, with the same timing.
- **Export** makes one video, with colour matched across the cuts. **For the web** makes a copy under 10 or 25 MB; the editor export is a zip for DaVinci Resolve, Premiere Pro or Kdenlive.

## Workflows

**Workflows** imports a ComfyUI workflow file (the one the editor saves) and turns it into a form. The importer puts forward what the workflow's author put forward, turns switches into toggles, finds where LoRAs go, and names the node packs and model files it is missing, with a button to install them through ComfyUI-Manager.

## The queue

**Queue** shows a lane per machine: what is rendering (with a live preview, speed and seed), what waits (each row saying which machine it goes to, when, and what holds it), and what finished or failed and why. Each job goes to the machine that will finish it first; **Run on** pins one. **Render times** breaks the GPU's time down by model and phase over any period, and flags jobs that were slower than usual or ran out of video memory. **Costs** splits RunPod's bill by day, GPU, project, pod session and render, and says what would have cost less. When a row waits, [troubleshooting](troubleshooting.md#a-job-that-waits) says what it means.

**Rented GPUs.** **Deploy a GPU…** (the status bar, Settings › Rented GPUs, the command bar) lists RunPod's stock ranked by **$ / render** for the renders waiting: each GPU's time on those forms from your own renders, at its price, plus its share of a deploy's boot, fetch and idle; within 10 % the faster GPU goes first, and a GPU you never rendered on is a guess counted 30 % dearer. The **hunt** waits for a GPU to come free and deploys it. A pod stops itself after the idle time you set, or when Afflatus goes quiet (its watchdog), and the spending caps (Settings › Costs) hold at every deploy.

## The command bar

**Ctrl+K** opens a bar that finds anything across projects (drafts, renders, timelines, folders, people, settings) with a preview, and runs commands. **Tab** shows what can be done with the row you are on. The first character sets a mode:

| Starts with | What it holds |
|---|---|
| `>` | commands: render, queue, split, deploy, stop all pods, get missing files… |
| `/` | settings, flipped from the bar |
| `=` | a calculator for frames, seconds and sizes on the model's own grid |
| `!` | the queue and the downloads |
| `?` | keyboard shortcuts |
| `@` | cast someone of the Prompt kit (optional) |

Keys find renders anywhere: `video:`, `lora:`, `model:`, `prompt:`, `in:`, `since:3d`, `-kept`. `civitai:` and `hf:` search the sites; a pasted Civitai or Hugging Face link is read into its files. All of it: [the command bar](command-bar.md).

The `?` at the bottom right opens the sheet of every keyboard shortcut, with a search.

## Settings

Twelve tabs: ComfyUI · Rented GPUs · Costs · Models · Model files · Prompts · Interface · Notifications · Sign-in · Agents (MCP) · Storage · About. See [configuration](configuration.md) for what each holds and for the environment variables. When something does not work, see [troubleshooting](troubleshooting.md).

Settings › Agents (MCP) makes the tokens an AI client drives Afflatus with: see [agents (MCP)](mcp.md).
