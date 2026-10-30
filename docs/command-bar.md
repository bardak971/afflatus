# The command bar

One bar, from anywhere in the app, that reaches everything Afflatus holds and does: press **Ctrl+K**, type a few letters, press Enter. It works like Alfred or Raycast: keyboard first, fuzzy, ranked by what you use, with a key that switches the mode and a list of actions behind every result.

Status: built (`apps/web/src/bar/`, the index in `apps/server/src/commandIndex.ts`). The first mock is the "Command bar — Afflatus" canvas (three boards: the bar, the keys, the settings).

## What it finds

Everything is searched together: an index of the timelines, drafts, projects, folders, workflows and Prompt kit (all of them), with the library's items asked of the server as you type (all of them, the bin too):

| Kind | Enter does | Shown as |
| --- | --- | --- |
| Timeline | open it in the editor | name · clips · length · exported · project |
| Draft | open it in the Studio | name · recipe · renders · last used |
| Render or item | open it in the viewer | its name (`Harbor walk · c2 · t3`, `Night market 04`) · kind · size · when; an item in the bin is found too, listed after the rest and said "In the bin" |
| Project | work in it (an archived one: unarchive it) | name · timelines · items · size; the Inbox is listed with them, worked in the same way |
| Folder | open it in the library | name · project · items · size |
| Workflow | Try it (a new draft on it) | name · output · whether it can be built |
| Prompt kit entry | open it in the Prompt kit | name · person, place, style, preset or snippet · built in |
| Place to go | go there | the screens, each tab of Settings, Queue › Render times, Queue › ComfyUI log, the Bin (every project's), Open Projects, Keyboard shortcuts |
| Command | run it | what it does · what it touches · estimate |
| Setting | flip it, run it, or open its page | name · Settings › page · its value |

A kind typed first lists that kind, newest first: `draft`, `timelines`, `projects`, `folders`, `renders`, `workflows`, or the start of one from four letters (`timel`). The words after it narrow the list (`timeline pier`, `draft krea`); what the words find elsewhere (the New draft command) still comes after.

With nothing typed, the bar shows **Recent** (the last timelines, drafts, renders and commands you used) and a few **Suggested** rows that fit the moment: pause the queue while something runs (resume it when paused), bin unused takes when a timeline has some, reconnect to ComfyUI when it is offline, the selected clip's split and takes, group by model when it saves loads, and "N failed in the queue" (Enter types `!`).

## Keys

| Key | Does |
| --- | --- |
| Ctrl+K | opens the bar from anywhere; again, or Esc, closes it (changeable in Settings) |
| ↑ ↓ | move through the results |
| Enter | the result's first action (open, run, flip); when it cannot run now, the footer says why ("unavailable: ComfyUI is offline") |
| Ctrl+Enter | its second action (run at the top of the queue, show in Projects, apply a preset in the Studio…) |
| Tab | the result's whole list of actions; Tab or Esc goes back |
| Shift | shows or hides the preview |
| Esc | clears what is typed, then closes |

Outside the bar, **Ctrl+V** pastes images, videos and audio files from the clipboard (a screenshot, a copied image, files copied in Explorer or Finder) where you are: the open picker (added and picked), the media slot with the focus (as a drop on it), the library shown (into its folder), else the project's library. A file the library already holds is used, not added twice. Text boxes keep the browser's own paste.

A row whose action has a key in the app shows it on its right, read from the key table (`apps/web/src/keys/table.ts`): split (S or Ctrl+B), the previous and next take (Alt+[ and Alt+]), Render (Ctrl+Enter), rendering the clip selected in the open editor (Ctrl+Enter), Keyboard shortcuts (?), and in a render's Tab list the viewer's keys (U, F, B, I, E, R, M, P, C, G, V, L, Shift+L, S, D…). A key is shown only where pressing it does that thing. The status bar has a small chip with the bar's shortcut that opens it with the mouse.

## Modes: the first character

| Starts with | Searches | Example |
| --- | --- | --- |
| (nothing) | everything | `hw` → Harbor walk; `queue` → Go to Queue |
| `>` | commands, then the places to go to | `> render clips 3-5`, `> seed 1234`, `> settings` |
| `/` | settings, switches flip in place | `/ hover` → Play videos on hover; `/ tokyo` → Dark theme |
| `=` | the calculator | `= 7s 24fps`, `= 1152x2048` |
| `!` | the queue | `!` → running, waiting, failed; Tab → Run next, Remove from queue, Retry… |
| `?` | keys: the rows of the Keyboard shortcuts sheet, with its search (a key first, then words) | `? split` → Split at the playhead · Timeline editor; Enter opens the sheet on that row |
| `@` | cast (optional, see below) | `@ada` → add to the selected clip, or the open draft |

`"` and `#` typed first write the render search's `prompt:` and `in:` (below): the prompts that were rendered, and the projects and folders, now mix with the other keys.

## Searching renders: keys

Anywhere in plain search, `key:value` words find renders: the library's own list query (`/api/assets`, every project's unless `in:` says where), read by fixed rules in `apps/web/src/bar/search.ts` and turned into rows in `searchRows.ts`. Keys and words mix in any order; the words left look in a render's name and its prompt.

| Key | Finds | Example |
| --- | --- | --- |
| `image:` `video:` `sound:` | that kind | `video: harbor` |
| `prompt:` | renders whose prompt holds the words; its values are the last prompts rendered (`"` typed first) | `prompt:"red bicycle"` |
| `lora:` | made with a LoRA (part of its name); its values are the library's LoRAs, the most used first | `lora:warm` |
| `model:` | a model family (`klein`, `h3`) or a model file | `model:wan` |
| `draft:` | made from a draft | `draft:harbor` |
| `in:` | in a project, a folder or the Inbox (`#` typed first) | `in:showcase` |
| `since:` | made since: `today`, `yesterday`, `3d`, `2w`, `1m`, a date | `since:3d` |
| `sort:` | `newest`, `oldest`, `name`, `size` | `sort:size` |
| `kept` / `-kept` (`expiring`) | kept, or not | `image: -kept` |
| `bin` | in the bin | `bin video:` |

- **A key's name begun** (`lo`) offers the keys it fits; Enter or Tab writes it. **A key's value being typed** (`lora:da`) lists its values; Enter writes one, Tab lists what can be done with it: a LoRA added to the open draft with its trigger words, its renders alone, its words copied; a model family loaded or a new draft on it; a place opened (Ctrl+Enter runs the first of these).
- **The results:** "Renders · N" (N counted by `/api/assets/count`), each with a render's usual actions. With a `prompt:`, the prompts that hold the words follow; Tab on one has "Its renders".
- **Nothing found:** "No render has all of these", then each key taken off with how many it would find ("Without since:today · 4 renders"); Enter takes it off. A value that names nothing ("No lora called “zzz”") says so, Enter taking it off.
- **A model's name among plain words** (`red bicycle klein`) is read as `model:klein` (a dashed chip): that model's renders with the words come first, what the words find as before after them.
- **Chips:** the keys are tinted in the input (a key typed, a guessed model dashed, a key left out with `-`, one that finds nothing underlined). A `-` before a key other than kept is not read yet: its chip says so.

## Civitai and Hugging Face

With "Search Hugging Face and Civitai" on (Settings › Models); off, a pasted link says so and leads there. Every download from the bar is asked first, with its size, its folder and the ComfyUI it goes to: a stray Enter is easy, and a model is gigabytes.

- **A pasted link** (a Civitai model page or version, a Hugging Face repository or file) is read into its files (`/api/browse/link`), a row each: name and version, type, base, size, the folder it goes in (asked when the source does not say), "you have it". Enter downloads it onto this PC; with several ComfyUIs, Ctrl+Enter onto the next (a rented pod's), else it opens Find models on the link. Tab: each ComfyUI, Find models, its page, its trigger words copied.
- **Downloads in `!`**, after the jobs: how far each is ("25 % of 48 MB"), its folder and file, its machine. Under way: show the downloads, cancel it (one waiting its turn: take it out of the line). Failed or stopped: Try again (as it was first asked, `POST /api/downloads/:id/again`; not after a restart of Afflatus), dismiss. Done: dismiss, and its place on disk (Show in folder, Copy path, as below). `> remove waiting downloads` takes every file waiting its turn out of the line, as its Remove all waiting (listed in `!` after the jobs while one waits).
- **A LoRA or model file in `lora:` and `model:`**, and a finished download: Tab has its place on disk as Find models › Yours shows it (`POST /api/model-files/where`, the same answer and cache): Show in folder for each place when the bar is open on the computer Afflatus runs on (the file named, never its path sent), else Copy path; with ComfyUI on another machine, a LoRA's folder and name are copied.
- **A LoRA or model file in `lora:` and `model:`** says "newer on Civitai: v2" when the daily check or `> model updates` found one; Tab fetches it (asked) or opens its page, and "Its page" opens the file's own page when Afflatus knows it.
- **`> model updates`** asks Civitai now and opens Settings › Model files on the list of newer versions.
- **`civitai:` and `hf:`** anywhere search the site, with Find models' own filters as keys: `type:lora` (lora, checkpoint, vae, upscaler, controlnet, textencoder, unet, dora, locon), `base:klein` (one of your families), `sort:new` (downloads, rated, liked, new; on Hugging Face downloads, liked, trending, new), `period:week`, `by:someone` (one creator's, Civitai's user or Hugging Face's user or organisation), `kind:loras` (Hugging Face: comfyui, loras, all), and `new`, `all` bare. A key's values are listed while it is typed. The first row opens Find models on the same search, every filter set as the bar asked (Ctrl+Enter does it from any row); then the first 20 models found. Enter on one opens it in Find models; Tab: Add to Picked (its newest version's file, a Hugging Face repository's asked when it has several), download onto this PC (asked), its page, more by its creator. A filter that names nothing is said on a row.
- **`> picked`**: the files picked in Find models or the bar, how many and their size; Enter downloads them onto this PC (asked, with the list and the total), Ctrl+Enter opens them in Find models, Tab also clears them.
- **`> get missing files`**: the open form's missing model files looked up (their own address, the file of exactly that name on Hugging Face, an exact match on Civitai), then asked with the total and the ones found nowhere, and downloaded onto this PC.

## Actions behind a result (Tab)

- **A render:** the viewer's own actions: view · show in its folder · use in this draft · keep · download · variation · reuse (same seed, new seed) · PNG info · i2v · the quick passes (Upscale 2x, Face refine, Hand refine, Remove background) and the tools that open in a form (Inpaint, Edit, Outpaint) · mirror · Extend · save frame (the first frame) · extract audio · copy the seed · add to a timeline · open in ComfyUI · move to a project · rename · move to the bin (in the bin: put back, and "show in the bin"). Trim and Compare need the viewer on screen and are left to it.
- **A timeline:** open · show in Projects · render all · export… · finish… · fix all · bin unused takes · rename · move to another project · delete.
- **A draft:** open · show in Projects · render again · duplicate · rename · move to another project · delete.
- **A project:** work in it · show in Projects · pin to the rail · new folder inside · import a folder here · rename · archive · delete. An archived one: unarchive first. The Inbox: work in it · show in Projects.
- **A folder:** open · show in Projects · rescan (a folder of the disk) · new folder inside · import a folder here · rename · move · delete or unlink.
- **A workflow:** Try it · Edit · Export · Open in ComfyUI · Remove.
- **A Prompt kit entry:** open in the Prompt kit; a preset: apply in the Studio (Ctrl+Enter); a snippet: copy its text; a person: add to the selected clip or the open draft.
- **A queue job:** running: open queue · stop · copy the seed; waiting: open queue · run next · remove from queue; failed: open queue · render again · retry with shorter stretches or at a smaller size (after running out of memory) · open its draft · dismiss.

The actions are the ones the app already has (the viewer, the Projects panel, the Queue page, the Workflows screen, the Prompt kit, the timeline editor's buttons). The bar calls the same hooks and the same routes, and names each action as the screen does; it adds no behaviour of its own.

## Commands (`>`)

Plain words read by fixed rules, never an LLM. Each command shows what it will do before Enter: what it touches, how many, and an estimate where one exists. A command still missing its figures (named with "…") completes the bar on Enter or Tab.

- On the open timeline (else the one last opened from the bar): `render clips 3-5`, `render all`, `delete clip` (the selected one, as Del), `export`, `finish`, `fix all`, `bin unused takes`. Ctrl+Enter on a render renders and moves its jobs to the top of the queue, in their order (the queue's "Run next").
- On the clip selected in the editor: `split`, `previous take`, `next take`, `mirror pin` (one row per pinned frame, as its right-click menu's Mirror ↔; `mirror pin off` turns it off). `clip 3` selects clip 3 of the open timeline and puts the playhead on its start (it opens the timeline the bar aims at first).
- Also on the selected clip: `transition dissolve` (any of the ten kinds by its name or a word of it; `transition` alone lists them, `transition off` makes a plain cut), on the cut into the clip, as its join's choice in the column; `slow motion` or `slow motion 4x`, a new take, as its menu; `motion transfer in windows`, a video brought in put on the source lane.
- On the open draft: `render draft`, `seed 1234`, `steps 30`, `cfg 4`, `size 576x1024`, `length 5s`, `preset <name>`, `save as preset <name>`.
- Models: `load <model>`, `unload models` (as the Queue page's button: not while a render runs), `new draft <model>`, `import workflow`.
- Rented GPUs and money: `stop all pods` (every pod that runs or starts, asked first: their GPUs stop billing, their disks go on), `spending` or `costs` (with RunPod, today and this month against the caps, the balance and how long it lasts; Enter opens Queue › Costs, Ctrl+Enter the caps in Settings › Costs). `find models [words]` opens Find models on the words, to download onto this PC; `model updates` asks Civitai for newer versions of your models now; `picked` and `get missing files` (see Civitai and Hugging Face).
- Making things: `new timeline [name]`, `new folder <name>` (at the top of the project you work in), `new project <name>`, `new person|place|style|preset|snippet <name>` (opened in the Prompt kit), `link folder [path]`.
- The queue: `pause queue`, `resume queue`, `remove waiting`, `retry failed`, `dismiss failed`, `group by model`, `empty bin`, `put all back` (both as the bin's own buttons, off while it is empty).
- Elsewhere: `view last render`, `reconnect` (ComfyUI asked again, as Settings' Test again), `undo` (the open editor's last change, as its Ctrl+Z; elsewhere the move or bin the newest banner offers to undo), `redo` (the same for what Undo took back, as Ctrl+Shift+Z), `rename <name>` (the open timeline, else the open draft).
- Afflatus itself: `check ffmpeg` (every start-up check run again, as About's On this computer › Check again), `get ffmpeg` (offered only when the ffmpeg check fails with a way to put it right, as About's Get ffmpeg: the download from the computer Afflatus runs on, its progress in About; on macOS Homebrew's line copied), `check for updates`, `update` (when a newer version is out, as About's Update), `go back` (to the version kept, asked first), `test notification [telegram|discord]`, `sign out` (this browser, with a password set) and `sign out everywhere` (asked first).

A command that cannot be undone (empty bin, delete) asks first, as the app does elsewhere.

## Calculator (`=`)

The figures video work needs, using the family's real grid from the recipe contract (H3: sizes on 32, frames on `17k + 5` at 24 fps):

- `= 7s 24fps` → 175 frames (7.29 s) on the H3 grid; Enter copies the number.
- `= 121f 24fps` → 5.04 s.
- `= 1152x2048` → 2.4 MP · 9:16.
- `= 9:16 1mp` → 768×1344 (snapped to the family's grid).
- With a timeline or draft open, a render estimate: **learned from `render_stats` (forecast.ts) or not shown**. No card or VRAM figure is ever written into the bar.

## Optional parts (Settings › Interface › Command bar)

Off until turned on, each with its own switch:

- **Prompt snippets.** Type `;name` in any prompt field and it expands (`;cine` → "Live-action, cinematic, gritty…"). These are the Prompt kit's own snippets: the name typed is the snippet's name in lower case with dashes ("Cine look" → `;cine-look`). Settings links to Prompt kit › Snippets, and "Snippet from the open prompt" opens the kit's New snippet with the prompt filled in.
- **Cast with `@`.** Adds a person of the Prompt kit to the clip selected in the open timeline editor (its own cast; one that followed the timeline's gets a copy of it with the person added), with "Add to the open draft" second when a draft is open too. When the clip cannot take a person (a still, no model, a model with no references, voice or prompt, a full cast), the row says why and the person goes to the open draft. The row's line says where it goes.

Always on, with a switch for each where it makes sense: the shortcut, "Learn what I use" (ranking by frequency and recency, kept in this browser), the preview, and "Forget what I used" (asked first; also found with `/ forget`).

Left out on purpose: dropping files on the bar. The app already takes drops for the library, references and workflow import. The LLM designer stays out of the bar.

## Performance

The bar has to open and answer within one frame. Budgets: **open < 50 ms**, **a keystroke to its results < 16 ms**, no network request per keystroke (the library's items are asked for once the typing stops, below).

- **The code** is its own chunk, loaded lazily (as the Projects panel is) and fetched once the app is idle, so the first Ctrl+K never waits for a download.
- **The index** comes from one small route, `GET /api/command-index`: per entry only `id`, `kind`, `label`, `sub` (project or folder), `updatedAt` and a few figures. No thumbnails or full rows. It holds every timeline, draft, project, folder, workflow and Prompt kit entry, but not the whole library: of its items only the 30 newest (what Recent falls back on) and up to 100 the bar used lately (named in `?items=`, from the learned ranks). Its size follows the projects and timelines, not the library: a few tens of KB, gzipped. It is a React Query entry, refreshed by the live events the app already gets (`library`, `timeline`, `queue`, `entities`, `models`) and by a change of the drafts or workflows lists, not on a timer.
- **The library's items** are asked for as you type, 80 ms after the typing stops: `GET /api/command-items?q=` looks through every item and the bin by name and answers with at most 200 (those that hold the words as typed first, the shorter names first, then the newest). The ones found are ranked with the index; those found before stay while the next answer comes. An item opened from the bar is kept in the list until the index is read again.
- **Matching** happens in memory over labels lower-cased once, when the index arrives: substring first, then word initials (`hw` → Harbor walk), then the letters in order. Score = match quality + the learned rank. 10 000 entries take well under 5 ms; past 30 000 the match moves into a Web Worker, with the same API.
- **Rendering**: at most 50 rows, grouped; a longer list scrolls virtually. A row is text and an icon; there are no thumbnails in the list.
- **Preview**: only the selected row's, after it has stayed selected 80 ms (arrowing fast loads nothing). Video plays muted from the existing thumbnail or proxy, never the full file.
- **Ranking**: open counts with a decay, in `localStorage` under `afflatus.bar.rank`, read and written in `try/catch`; it never blocks the bar.
- **Commands and the calculator** are parsed on each keystroke by small pure functions in `apps/web/src/bar/`. They are tested like `tree.ts`.

## The look

An overlay over the current screen, not a dock: the page behind it dims and blurs. The bar sits high in the centre, about 700 px wide, and grows to about 1080 px when the preview opens on its right.

- **Input:** large (20 px).
- **Results:** one row per result, with a tinted icon tile for its kind (timeline orange, render blue, draft and project accent, command yellow, queue teal), the name with the matched part in the accent, and one line of detail. The selected row is filled with the accent wash.
- **Footer:** the keys as keycaps in the Keyboard shortcuts sheet's notation (↑ ↓ move · Enter · Ctrl+Enter · Tab actions · Shift preview), and the mode characters as caps with their names (> commands · " prompt: · # in: · / settings · = calc · ! queue · ? keys).
- **Theme:** the app's own tokens, so it follows the theme.

## Built, in order

1. The bar, Ctrl+K, the index route, matching, recents and ranking; go to anything; settings with switches in place.
2. Tab actions and the Shift preview.
3. `>` commands and `!` queue.
4. The calculator.
5. The optional parts: snippets, prompt history, `@` cast. (Prompt history became `prompt:` with the render search, 7.)
6. Coverage (Batch F): the places to go to, workflows and the Prompt kit in the index, the commands of the Queue page, the editor, the Workflows screen and the kit, the viewer's actions on a render, the Queue page's fixes on a failed job.
7. The render search: keys anywhere (`image:` `lora:` `prompt:` `in:` `since:`…), their values listed, chips in the input, the counts of what nothing matched; `"` and `#` fold into `prompt:` and `in:`, and the Prompt history switch is gone. Mock: the "Ctrl+K render search" canvas.
8. Civitai and Hugging Face, part 1: a pasted link read into its files and downloaded after asking (this PC or another ComfyUI), the downloads in `!` (stop, download again, dismiss), "newer on Civitai" on `lora:` and `model:` values, `> model updates`.
9. Civitai and Hugging Face, part 2: `civitai:` and `hf:` with the browser's filters as keys (`by:` new on both sites' routes), Find models opened on the bar's search, Add to Picked and `> picked`, `> get missing files`.
