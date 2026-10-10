# Using Afflatus

A walk through the app once it runs and talks to ComfyUI (see the [install guides](../README.md#quick-start) and [ComfyUI setup](comfyui-setup.md) first). Every setting has a `?` beside it with a plain explanation; this page is the map.

## The Studio

The Studio is where pictures and videos are made and kept. On the left, the **Create** form (press **N** to open it); on the right, the library.

- **A draft** is one form you are working on: a model, a prompt, its settings. Drafts are saved as you type and listed in the draft menu at the top of the form. A new draft is only kept once it holds something: a prompt, a picture, a name, someone from the Prompt kit, or a render.
- **The form** has one tab strip for every model family: Model · Prompt · Inputs · Sampling · Output · Advanced. Defaults come from ComfyUI's own templates and the models' authors, and what you change can be saved as your default for that model file.
- **Generate** (or **Ctrl+Enter**) queues the render. The form shows how long it will take, learned from your own past renders.
- **The library** shows the project you are working in: everything, or one folder, as a Stage (one large item) or a grid in three sizes, filtered by kind. Search reads prompts and names.

Renders start out *not kept*: keep the ones you want (the star, or **S**). What is not kept goes to the bin after a day, and the bin empties itself after a week, so the library holds what you chose.

## Projects

Projects group drafts, timelines and folders. The project you work in is chosen at the top left; what you make lands in it, and the library, the drafts and the timelines all show that project. The **Inbox** holds what belongs to no project.

The **Projects** panel lists every project with its folders and drafts, what each holds, when it was started and its size on disk. Pin the projects you use most to the rail on the left. A folder can also be **linked** to a directory on disk: its files show up in the library where they are, without being copied, and an item filed into it is written there as a file with a readable name.

## A picture or a video, up close

Click any item to open it large. The side panel shows everything it was made with and what can be made from it:

- **Reuse** its settings with the same seed (**L**) or a new one (**Shift+L**), make a **Variation** (**V**), or turn a picture into a video (**M**).
- **Passes:** upscale, face detailer, remove background, inpaint, outpaint, edit by instruction, mirror, and more.
- **Compare** two items side by side with a wipe (**X**).

The same actions are in the **right-click menu** of every tile, and in the command bar.

## The Prompt kit

People, places, styles, snippets and presets, written once and used with every model:

- **A person** is a few reference pictures, how they look as tags (for SDXL-style models) and as a sentence (for the others), a voice sample, a LoRA per model family when there is one, and outfits.
- **A place** is pictures and words; **a style** is LoRAs and words per model family; **a snippet** is a bit of text you tick on to add it to a prompt.
- **A preset** keeps a whole setup: the model, its form and who is in it. The official ones ship with the app; your own can be saved as a file and shared ([presets/README.md](../presets/README.md)).

Put people and a style into a draft or a whole timeline (**Cast and look**), and each model receives them the way it reads them.

## Timelines

A timeline is a video made of clips. Open **Timelines** in the rail, start one, and drop pictures or videos from the library onto the track (or right-click a picture → **Timeline** → *Start a timeline from it*).

- **A clip** is a form of its own. A picture dropped on the track becomes its first frame; a clip can also have a last frame and a keyframe in the middle.
- **Takes:** each render of a clip is a take. Render several at once (**Takes at once**), and pick the one that plays.
- **Carry on:** a clip can continue from the one before, so the motion and the sound go on across the cut. For MiniMax H3 the join is made in the model's own latent.
- **What it measures:** hover a clip, or open its Takes tab, to see how clean its join is and how its brightness, sharpness and pace compare with the clips around it. The timeline lists the joins that jump and the takes that would join more cleanly; whether that take is the better clip is yours to judge, and each row can be hidden.
- **Editing:** trims (with scene detection), split at the playhead (**S** or **Ctrl+B**), stills held on screen, undo and redo.
- **Sound:** each clip's own sound, an audio file, or muted; a music track that ducks under voices.
- **Finish** brings every clip to its final size in one pass (SeedVR2, RTX Video Super Resolution, an upscale model, or for H3 a re-sample of the draft's latent). A finished take plays in place of its draft, with the same timing.
- **Export** makes one video, with colour matched across the cuts. **For the web** makes a copy under 10 or 25 MB.

## Workflows

**Workflows** imports a ComfyUI workflow file (the one the editor saves) and turns it into a form. The importer puts forward what the workflow's author put forward, turns switches into toggles, finds where LoRAs go, and names the node packs and model files it is missing, with a button to install them through ComfyUI-Manager.

## The queue

**Queue** shows what is rendering (with a live preview, speed and seed), what waits (grouped by the model it loads, in an order you can change), and what finished or failed and why. **Render times** breaks the GPU's time down by model and phase over any period, charts it, and flags jobs that were slower than usual or ran out of video memory.

## The command bar

**Ctrl+K** opens a bar that finds anything across projects (drafts, renders, timelines, folders, people, settings) with a preview, and runs commands. **Tab** shows what can be done with the row you are on. A prefix narrows it:

| Prefix | What it holds |
|---|---|
| `>` | commands: queue, cancel, reuse, split, empty the bin… |
| `#` | places: projects and folders, to work in or open |
| `/` | settings, flipped from the bar |
| `=` | a calculator for frames, seconds and sizes on the model's own grid |
| `!` | the queue |
| `"` | your earlier prompts |
| `?` | keyboard shortcuts |

The `?` at the bottom right opens the sheet of every keyboard shortcut, with a search.

## Settings

ComfyUI's address and folder, the model families and what each has ready or missing, the optional prompt designer, the interface and its theme, the command bar, storage and backups. See [configuration](configuration.md) for each tab and for the environment variables. When something does not work, see [troubleshooting](troubleshooting.md).
