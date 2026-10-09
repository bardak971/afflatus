# The command bar

One bar, from anywhere in the app, that reaches everything Afflatus holds and does: press **Ctrl+K**, type a few letters, press Enter. It works like Alfred or Raycast: keyboard first, fuzzy, ranked by what you use, with a key that switches the mode and a list of actions behind every result.

Status: built (`apps/web/src/bar/`, the index in `apps/server/src/commandIndex.ts`). The first mock is the "Command bar — Afflatus" canvas (three boards: the bar, the keys, the settings).

## What it finds

Everything is in one index, searched together:

| Kind | Enter does | Shown as |
| --- | --- | --- |
| Timeline | open it in the editor | name · clips · length · exported · project |
| Draft | open it in the Studio | name · recipe · renders · last used |
| Render or item | open it in the viewer | its name (`Harbor walk · c2 · t3`, `Night market 04`) · kind · size · when |
| Project | work in it | name · timelines · items · size |
| Folder | open it in the library | name · project · items · size |
| Workflow | Try it (a new draft on it) | name · output · whether it can be built |
| Prompt kit entry | open it in the Prompt kit | name · person, place, style, preset or snippet · built in |
| Place to go | go there | the screens, each tab of Settings, Queue › Render times, Queue › ComfyUI log, Open Projects, Keyboard shortcuts |
| Command | run it | what it does · what it touches · estimate |
| Setting | flip it, run it, or open its page | name · Settings › page · its value |

With nothing typed, the bar shows **Recent** (the last timelines, drafts, renders and commands you used) and a few **Suggested** rows that fit the moment: pause the queue while something runs (resume it when paused), bin unused takes when a timeline has some, reconnect to ComfyUI when it is offline, the selected clip's split and takes, group by model when it saves loads, and "N failed in the queue" (Enter types `!`).

## Keys

| Key | Does |
| --- | --- |
| Ctrl+K | opens the bar from anywhere; again, or Esc, closes it (changeable in Settings) |
| ↑ ↓ | move through the results |
| Enter | the result's first action (open, run, flip) |
| Ctrl+Enter | its second action (run at the top of the queue, show in Projects, apply a preset in the Studio…) |
| Tab | the result's whole list of actions; Tab or Esc goes back |
| Shift | shows or hides the preview |
| Esc | clears what is typed, then closes |

A row whose action has a key in the app shows it on its right, read from the key table (`apps/web/src/keys/table.ts`): split (S or Ctrl+B), the previous and next take (Alt+[ and Alt+]), Generate (Ctrl+Enter), rendering the clip selected in the open editor (Ctrl+Enter), Keyboard shortcuts (?), and in a render's Tab list the viewer's keys (U, F, B, I, E, R, M, P, C, G, V, L, Shift+L, S, D…). A key is shown only where pressing it does that thing. The status bar has a small chip with the bar's shortcut that opens it with the mouse.

## Modes: the first character

| Starts with | Searches | Example |
| --- | --- | --- |
| (nothing) | everything | `hw` → Harbor walk; `queue` → Go to Queue |
| `>` | commands, then the places to go to | `> render clips 3-5`, `> seed 1234`, `> settings` |
| `#` | projects and folders | `# dev` → work in Dev |
| `/` | settings, switches flip in place | `/ hover` → Play videos on hover; `/ tokyo` → Dark theme |
| `=` | the calculator | `= 7s 24fps`, `= 1152x2048` |
| `!` | the queue | `!` → running, waiting, failed; Tab → Run next, Cancel this one, Retry… |
| `?` | keys: the rows of the Keyboard shortcuts sheet, with its search (a key first, then words) | `? split` → Split at the playhead · Timeline editor; Enter opens the sheet on that row |
| `"` | prompt history (optional, see below) | `"rain` |
| `@` | cast (optional, see below) | `@ada` → add to the selected clip, or the open draft |

## Actions behind a result (Tab)

- **A render:** the viewer's own actions: view · show in its folder · use in this draft · keep · download · variation · reuse (same seed, new seed) · PNG info · i2v · the quick passes (Upscale 2x, Face detailer, Remove background) and the tools that open in a form (Inpaint, Edit, Outpaint) · mirror · Extend · save frame (the first frame) · extract audio · copy the seed · add to a timeline · open in ComfyUI · move to a project · rename · move to the bin. Trim and Compare need the viewer on screen and are left to it.
- **A timeline:** open · show in Projects · render missing clips · export · finish · fix all · bin unused takes · rename · move to another project · delete.
- **A draft:** open · show in Projects · generate again · duplicate · rename · move to another project · delete.
- **A project:** work in it · show in Projects · new folder inside · import a folder here · rename · archive · delete.
- **A folder:** open · show in Projects · rescan (a folder of the disk) · new folder inside · import a folder here · rename · move · delete or unlink.
- **A workflow:** Try it · Edit · Export · Open in ComfyUI · Remove.
- **A Prompt kit entry:** open in the Prompt kit; a preset: apply in the Studio (Ctrl+Enter); a snippet: copy its text; a person: add to the selected clip or the open draft.
- **A queue job:** running: open queue · stop this render · copy the seed; waiting: open queue · run next · cancel this one; failed: open queue · retry unchanged · retry with shorter stretches or at a smaller size (after running out of memory) · open its draft · dismiss.

The actions are the ones the app already has (the viewer, the Projects panel, the Queue page, the Workflows screen, the Prompt kit, the timeline editor's buttons). The bar calls the same hooks and the same routes, and names each action as the screen does; it adds no behaviour of its own.

## Commands (`>`)

Plain words read by fixed rules, never an LLM. Each command shows what it will do before Enter: what it touches, how many, and an estimate where one exists. A command still missing its figures (named with "…") completes the bar on Enter or Tab.

- On the open timeline (else the one last opened from the bar): `render clips 3-5`, `render missing`, `export`, `finish`, `fix all`, `bin unused takes`. Ctrl+Enter on a render renders and moves its jobs to the top of the queue, in their order (the queue's "Run next").
- On the clip selected in the editor: `split`, `previous take`, `next take`.
- On the open draft: `generate`, `seed 1234`, `steps 30`, `cfg 4`, `size 576x1024`, `length 5s`, `preset <name>`, `save as preset <name>`.
- Models: `load <model>`, `unload models` (as the Queue page's button: not while a render runs), `new draft <model>`, `import workflow`.
- Making things: `new timeline [name]`, `new folder <name>` (at the top of the project you work in), `new project <name>`, `new person|place|style|preset|snippet <name>` (opened in the Prompt kit), `link folder [path]`.
- The queue: `pause queue`, `resume queue`, `cancel waiting`, `retry failed`, `dismiss failed`, `group by model`, `empty bin`.
- Elsewhere: `view last render`, `reconnect` (ComfyUI asked again, as Settings' Test again).

A command that cannot be undone (empty bin, delete) asks first, as the app does elsewhere.

## Calculator (`=`)

The figures video work needs, using the family's real grid from the recipe contract (H3: sizes on 32, frames on `17k + 5` at 24 fps):

- `= 7s 24fps` → 175 frames (7.29 s) on the H3 grid; Enter copies the number.
- `= 121f 24fps` → 5.04 s.
- `= 1152x2048` → 2.4 MP · 9:16.
- `= 9:16 1mp` → 768×1344 (snapped to the family's grid).
- With a timeline or draft open, a render estimate: **learned from `render_stats` (forecast.ts) or not shown**. No card or VRAM figure is ever written into the bar.

## Optional parts (Settings › Command bar)

Off until turned on, each with its own switch:

- **Prompt snippets.** Type `;name` in any prompt field and it expands (`;cine` → "Live-action, cinematic, gritty…"). These are the Prompt kit's own snippets: the name typed is the snippet's name in lower case with dashes ("Cine look" → `;cine-look`). Settings links to Prompt kit › Snippets, and "Snippet from the open prompt" opens the kit's New snippet with the prompt filled in.
- **Prompt history.** `"` in the bar searches every prompt that was rendered, each shown with its render; Enter loads it into the open draft.
- **Cast with `@`.** Adds a person of the Prompt kit to the clip selected in the open timeline editor (its own cast; one that followed the timeline's gets a copy of it with the person added), with "Add to the open draft" second when a draft is open too. When the clip cannot take a person (a still, no model, a model with no references, voice or prompt, a full cast), the row says why and the person goes to the open draft. The row's line says where it goes.

Always on, with a switch for each where it makes sense: the shortcut, "Learn what I use" (ranking by frequency and recency, kept in this browser), the preview, and "Forget what I used" (asked first; also found with `/ forget`).

Left out on purpose: dropping files on the bar. The app already takes drops for the library, references and workflow import. The LLM designer stays out of the bar.

## Performance

The bar has to open and answer within one frame. Budgets: **open < 50 ms**, **a keystroke to its results < 16 ms**, no network request per keystroke.

- **The code** is its own chunk, loaded lazily (as the Projects panel is) and fetched once the app is idle, so the first Ctrl+K never waits for a download.
- **The index** comes from one small route, `GET /api/command-index`: per entry only `id`, `kind`, `label`, `sub` (project or folder), `updatedAt` and a few figures. No thumbnails or full rows. It is a React Query entry, refreshed by the live events the app already gets (`library`, `timeline`, `queue`, `entities`, `models`) and by a change of the drafts or workflows lists, not on a timer. A library of 10 000 items is about 1 MB of JSON, gzipped about 150 KB, read once.
- **Matching** happens in memory over labels lower-cased once, when the index arrives: substring first, then word initials (`hw` → Harbor walk), then the letters in order. Score = match quality + the learned rank. 10 000 entries take well under 5 ms; past 30 000 the match moves into a Web Worker, with the same API.
- **Rendering**: at most 50 rows, grouped; a longer list scrolls virtually. A row is text and an icon; there are no thumbnails in the list.
- **Preview**: only the selected row's, after it has stayed selected 80 ms (arrowing fast loads nothing). Video plays muted from the existing thumbnail or proxy, never the full file.
- **Ranking**: open counts with a decay, in `localStorage` under `afflatus.bar.rank`, read and written in `try/catch`; it never blocks the bar.
- **Commands and the calculator** are parsed on each keystroke by small pure functions in `apps/web/src/bar/`. They are tested like `tree.ts`.

## The look

An overlay over the current screen, not a dock: the page behind it dims and blurs. The bar sits high in the centre, about 700 px wide, and grows to about 1080 px when the preview opens on its right.

- **Input:** large (20 px).
- **Results:** one row per result, with a tinted icon tile for its kind (timeline orange, render blue, draft and project accent, command yellow, queue teal), the name with the matched part in the accent, and one line of detail. The selected row is filled with the accent wash.
- **Footer:** the keys as keycaps in the Keyboard shortcuts sheet's notation (↑ ↓ move · Enter · Ctrl+Enter · Tab actions · Shift preview), and the mode characters as caps with their names (> commands · # places · / settings · = calc · ! queue · ? keys).
- **Theme:** the app's own tokens, so it follows the theme.

## Built, in order

1. The bar, Ctrl+K, the index route, matching, recents and ranking; go to anything; settings with switches in place.
2. Tab actions and the Shift preview.
3. `>` commands and `!` queue.
4. The calculator.
5. The optional parts: snippets, prompt history, `@` cast.
6. Coverage (Batch F): the places to go to, workflows and the Prompt kit in the index, the commands of the Queue page, the editor, the Workflows screen and the kit, the viewer's actions on a render, the Queue page's fixes on a failed job.
