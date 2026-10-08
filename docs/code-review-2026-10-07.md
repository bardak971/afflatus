# Code review, 2026-10-07

A critical pass over the whole application before it goes public: the server (`apps/server`), the web app (`apps/web`), the shared packages (`packages/*`), the ComfyUI node pack (`comfy-nodes`), the release tooling and the documentation. Seven reviewers read the code area by area (Create, Timeline, Workflows, server core, web core, packages and node pack, release); an eighth checked every finding of the 2026-10-05 review against today's code.

**How the findings were checked.** Every HIGH finding below was re-verified by hand against the files; five were reproduced, not just read:

- the upload-body deletion, on the demo server (a scratch folder was deleted);
- a cross-site request pausing and resuming the queue, on the demo server;
- the prototype pollution, by running the importer on a crafted file in a throwaway process;
- two importer mis-mappings, by the reviewer, on files of the local corpus;
- the flaky test, by the full run below.

Most MEDIUM findings were re-read in the code; the ones marked *(unverified)* were not.

## Outcome (2026-10-08)

Every finding below was worked on the same night, area by area, and merged.

**Checks after the merge:**
- typecheck clean;
- 1162 tests pass (1 skipped: the Postgres migration test, which runs in CI against a Postgres service);
- the node pack's 18 Python tests pass;
- `check:graphs` 146 variants, 0 problems;
- the build passes, main chunk 376 kB (was 555 kB).

The three reproduced HIGH findings were reproduced again after the fix and are refused:
- the fake upload body answers 400 and the folder stays;
- the cross-site POST answers 403;
- the `__proto__` workflow file is refused and nothing is polluted.

**Second round (2026-10-08), the items first fixed in part:**
- **HIGH 14:** what the user typed before the cast was worked in is kept with the job and the generation (`asked`, migration 0040), from the Studio and from timeline renders; a tool, Extend or carry-on opened from the result carries that, and the cast goes along as the cast. `compose` also skips words already present.
- **HIGH 2, second half:** every state-changing request must be JSON, a file, or carry `X-Afflatus: 1` (the web app sends it); a body-less or `text/plain` POST answers 403.
- **Redirects:** the Civitai and Hugging Face lookups go through the same checked fetch (each hop judged, the API key kept to the first host).
- **HIGH 7:** a missing pack's values read by position (only when each fits its socket's type) now always carry a note naming the node.
- **W-4:** helper nodes (KSamplerSelect, schedulers, configs, contexts, providers, detailers) are no longer sampling passes; nodes that really sample by their inputs are. Six corpus files lost a stage that existed only because of a helper; 67 gained the HIGH 7 note (expect.json refreshed).
- **A render sent twice after a crash:** the prompt id is chosen and saved before sending; after a restart the queue asks ComfyUI whether it has it before sending again.
- **Leftover MP4s:** the node pack (0.10.0) also cleans `output/Afflatus/video_*` older than a day, asked by the server at most once an hour.
- **`timelines.ts`:** 1005 → 707 lines (`timelinePlan.ts`, `timelineTakes.ts`; the wrappers are gone); `regenerateRange` split.
- **A new clip takes the cast of the clip before** when that clip has its own (it used to fall back to the timeline's every time). The live preview on the timeline follows the editor's volume and mute instead of the browser's own controls.

**Third round (2026-10-08), the last four:**
- **The library's `maxPages`:** `GET /api/assets` takes a `before` cursor and answers `prev`; the Studio grid and a draft's results keep at most 8 pages and read the ones above again when scrolled back to. The pickers (picture field, the timeline's media) stay uncapped: they have no loader at the top and are rarely scrolled far.
- **T-8:** a generation's measure has its own column (`generations.measure`, migration 0041, filled from `resolved` in one statement); the in-memory cache is gone.
- **`takes.lead_ms`:** dropped (migration 0042); undo and redo put back only the take columns that exist, so steps kept before still restore.
- **ClipTip's times:** its two formatters moved to `format.ts` unchanged (`seconds`, `spell`), with tests.
- Also: a person's or place's reference images take files dropped from the computer (several at once) and pictures dragged from the library.

**By design, still the owner's** (see `docs/going-public.md`): HIGH 21 and 22 (the history rewrite) and R-4 (the GHCR package made public).

**Checks after the second round:**
- typecheck clean;
- 1183 tests pass after the third round (1 skipped: Postgres, run in CI);
- 21 Python tests;
- `check:graphs` 146/0;
- build 376 kB.
- A browser pass on the demo server (Studio, Create, timeline, workflows, Queue, Settings in both themes, Prompt kit, Shortcuts, the stale-tab reload) showed no console error.

**Not run here:** Postgres, a Docker build, the release workflow, `helm` beyond `lint`/`template`, any render. Migrations up to 0040 ran on the owner's database (copy kept as `afflatus.db.pre-0040_asked`); the node pack 0.10.0 loads at ComfyUI's next start.

## The shape of the code

| | |
|---|---|
| TypeScript, TSX and Python, without tests | about 51 400 lines (server 14 600, web 23 000, recipes 6 100, workflows 3 500, comfy 1 700, core 1 400, node pack 1 200) |
| Tests | 85 files, 973 tests (web: 8 files); Python: none run |
| `npm run -s typecheck` | clean |
| `npx vitest run` | 972 pass, **1 failed**: `packages/comfy/test/monitor.test.ts:129` (see LOW, Tests) |
| `npm run -s build` | passes; the main chunk is 555 kB (Vite warns over 500 kB); `MaskPainter` is imported both statically and lazily, so its lazy import does nothing |
| `corepack pnpm check:graphs` | 146 variants, 0 problems |
| `pnpm audit` | 0 vulnerabilities (287 packages); no unused dependencies; every licence is compatible with AGPL-3.0 |
| Biggest files | `timelines.ts` 1092, `db.ts` 1043, `inspect.ts` 924, `cut.ts` 904, `WorkflowEditor.tsx` 835, `TimelineEditor.tsx` 786, `designer.ts` 716, `fields.tsx` 684 |
| Longest functions | `TimelineEditor` 743, `WorkflowEditor` 730, `Inspector` 492, `Player` 436, `registerAssets` 384, `Form` 380, `flowRecipes` 368, `CreatePanel` 367, `recipeFromWorkflow` 345, `Trim` 336, `fromEditor` 332 |

**Overall.** The base the last review praised is still sound: ffmpeg runs only through `execFile` with argument arrays, SQL is never built from strings, storage keys stay inside their roots, the queue claims jobs with a conditional update, and nothing in the node pack uses `torch.load` or pickle. Almost all of the 2026-10-05 findings were fixed (commit `c12f536`).

This review found new problems in three places:

- **The trust boundary.** No login is a deliberate choice, but four HIGH findings still let a web page in the owner's browser, a shared workflow file, or a machine on the LAN do real damage.
- **The timeline's newest features.** Landing, seamless joins and finished takes break undo, splits and landings in ways a user will hit.
- **Draft handling with several tabs.** Edits, designer replies and cast words go to the wrong draft or are lost.

## What became of the 2026-10-05 review

Fixed (each checked against today's code, with the file and line):

| Was | Now |
|---|---|
| H1 LIKE without ESCAPE | fixed: `queueView.ts:117-122`, with an underscore test (`queue.test.ts:406`) |
| H2 DNS rebinding | fixed: `hostCheck.ts`, `app.ts:45-49` |
| H3 backup over 4 GB | fixed: real zip64 (`zipStream.ts`), the abort is logged (`backup.ts:101-104`) |
| H4 export state from the last 30 jobs | fixed: `jobs.timeline_id`, migration 0032 with an index and a backfill |
| H5 progress overshoot on tiles | fixed: `monitor.ts:324-331`; the fake sends tile progress |
| H6 latent re-sample dropped without MMH3 | fixed: `latent-upscale.ts:31,35` throws; `h3/video.ts:45` lists the nodes |
| H7 edits lost on a failed save | fixed: `draft.ts:52-64`, `useEntityDraft.ts`, `useClipEdits.ts` |
| H8 unkeep countdown | fixed: `countdown_from` (migration 0033), `sweep.ts:22` |
| H9 unpinned Node and ffmpeg | fixed: `bundle.mjs` pins both and checks SHA-256 |
| MEDIUM | linking refuses system folders (`linked.ts:35-53`); crash window closed (`queueStore.ts:185-203`); backup cancel; uploads streamed and probed once; `list()` N+1; one SSE timer and a settings cache; derived files forgotten on a linked change; outbound literal-address check; "lookups off" gate; editor re-renders (`timeline/clock.ts`); progress patched in place; advice debounce; effect re-subscriptions; picker `enabled`; lazy routes; upload errors shown; PVC keep; `usedAs` recursion; continuation ImportError; fake progress |
| LOW | the dead exports, the CRC table, `cutRange`/`keepCut`, the shared range-clip insert, the tool claim, `clock`, the open-draft/Open-in-ComfyUI/add-to-timeline helpers, the debounce hooks, the confirm widgets, `text-to-picture` helpers, `latent_io` helpers, `isWidget`, the uncalled `GET /api/system`, the width/height patch, the side-effecting GETs, `timeline_future` cleanup, menu keys, project in query keys, the address field, the LTX preview node, the hires latent variant, the `H3Video` type, the a11y nesting in tiles and the viewer, web tests, the backup cancel test, the release hardening (`__pycache__`, header limit, security context, CI permissions and SHA pins), the docs drift |
| Structure | `app.ts` (135 lines now), `queue.ts`, `Setup.tsx`, `TimelineEditor.tsx` hooks, `Viewer.tsx`, `Studio.tsx`, `Track.tsx`, `h3/video.ts`, `inspect.ts` sections: all split |

Still open or partly fixed:

| Was | State |
|---|---|
| M: whole videos read into memory | **open**: `cut.ts` takes `Uint8Array` everywhere; the export holds every part (`timelineExport.ts:44,82,98`) |
| M: missing indexes | **open**: only `jobs_by_timeline` was added. Still none on `assets.generation_id`, `takes.asset_id`, `jobs.clip_id`, `jobs.generation_id`, `jobs.depends_on`, either `generation_inputs` column, `assets(deleted_at, created_at, id)` |
| M: search parses every generation | partly: the model tally is cached; each search still `JSON.parse`s up to 4000 inputs (`assets-api.ts:109`) |
| M: transactions | partly: `linked.ts:154-169` `unlink` and `duplicateClip` (`timelineRange.ts:115-135`) still write several tables without one |
| M: library refetches every loaded page | open by decision (`data.ts:80-93`); finding M-web-4 below makes it costlier |
| M: transitive dependencies | partly: one lockfile per staging, but not the audited `pnpm-lock.yaml` (see Release) |
| M: outbound fetches | partly: a redirect or a name that resolves to a private address passes (see MEDIUM) |
| L: Krea 2 copies the FLUX recipes | open (about 230 lines) |
| L: grid rounders | partly: `roundTo` exists; `r32` twice, `round8`, and the web's own copy remain |
| L: HTTP error helper | partly: about 20 inline `Object.assign(new Error(…), { statusCode })` remain (`backup.ts:67`, `civitai.ts:89,148`, `entities.ts:269,305`, `timelines-api.ts:367-384`, …) |
| L: basename lambda | partly: `media.ts:58 fileName` exists; nine copies remain (`designer.ts:448,505`, `modelPages.ts:31`, `fields.tsx:51`, `form.ts:9`, …) |
| L: `insertInto("assets")` by hand | partly: `timelineRange.ts:77-86` `cutRow` |
| L: `drafts.target` always "new" | open |
| L: `latentFramesOf` exported, used in its file | open (`queueStore.ts:15`) |
| L: modal shells | partly: `Keys.tsx:184` is still hand-made, without focus handling |
| L: nested interactive in the track clip | partly: `TrackClip.tsx:81-84` is a `div role="button"` holding a `<button>` |
| L: ffmpeg suites skip silently | partly: CI installs ffmpeg; 14 `skipIf` still skip locally |
| L: no test of a `linked:` key outside the roots | open |
| S: `timelines.ts` | partly: the four modules exist, but `timelines.ts` is still 1092 lines with about 20 one-line wrappers (`:1062-1086`) |
| S: shared debounced save | open: `useEntityDraft` and `draft.ts` each keep their own save/flush/retry |
| S: API types from the zod schemas | open |

## HIGH

Real bugs a user will hit, or clear weaknesses.

### Trust boundary

1. **Any JSON request can delete a folder and read a file** (`apps/server/src/uploadBody.ts:8`, `app.ts:74-79`, `lookup-api.ts:66`).
   - **Cause:** `isUpload` only checks that the body has `path` and `dir` keys. The `onResponse` / `onRequestAbort` hook then runs `rm(req.body.dir, { recursive: true, force: true })` for any such body, on every route that takes JSON. `POST /api/embedded` also runs `readFile(req.body.path)`.
   - **Reproduced** on the demo server: `POST /api/embedded` with `{"path": "<a file>", "dir": "<a scratch folder>"}` read the file and deleted the folder.
   - **Who can do it:** anyone who can reach the port. A cross-site page cannot, because a JSON body needs a preflight.
   - **Fix:** mark real uploads with something a body cannot carry (a module-private `WeakSet` filled in the content-type parser, or a `Symbol` key), and test that a JSON `{path, dir}` body is left alone.

2. **A web page in the owner's browser can empty the bin, bin takes and restart ComfyUI** (`app.ts:45-49`; `usage.ts:38,50`; `jobs-api.ts:73,77`; `setup-api.ts`; `presetFiles.ts:160`; `designer.ts:~694`).
   - **Cause:** the Host check stops DNS rebinding, but nothing checks `Origin` or `Sec-Fetch-Site`.
   - **What gets through:** a `fetch(…, { method: "POST", mode: "no-cors" })` with no body (or a `text/plain` one) is a "simple" request. It needs no preflight and reaches the handler with `Host: localhost:8720`, which is allowed.
   - **Routes that run on such a request:** every route that ignores its body or reads `req.body ?? {}`:
     - `POST /api/storage/empty-bin` (deletes the bin for good);
     - `bin-idle-takes`;
     - `comfy/restart` and `comfy/free`;
     - `queue/pause` and `queue/resume`;
     - `models/updates/check` (hashes every model file);
     - `presets/shipped:<id>/get` (starts multi-GB downloads when downloads are on);
     - `designer/test` (spends LLM tokens).
   - **Reproduced** on the demo server: `POST /api/queue/pause` with `Origin: https://evil.example` and `Sec-Fetch-Site: cross-site` answered 200 and paused the queue.
   - **Fix:** an `onRequest` hook that refuses every method other than GET/HEAD/OPTIONS when `Sec-Fetch-Site` is `cross-site`/`same-site`, or when `Origin` is present and its host is not in `allowedHosts()`. Exempt `/metrics` and `/api/health` from the Host check for scrapers (see Release 4). Also require `Content-Type: application/json` (or an `X-Afflatus` header the web client adds) on body-less POSTs.

3. **Importing a workflow file can pollute `Object.prototype` for the whole server** (`packages/workflows/src/editor.ts:450`, maps made from `{}` at `:328`; reached from `apps/server/src/workflows.ts:125` on the raw request body).
   - **Cause:** a node whose id is `"__proto__"` makes `(wiring.fallback[id] ??= {})[socket.name] = typed[socket.name]` write onto `Object.prototype`, because `wiring.fallback["__proto__"]` is the prototype itself.
   - **Reproduced** by running `fromEditor` on a two-node file in a throwaway process: afterwards `({}).polluted === "PWNED"`.
   - **Effect:** in the server, every object inherits the value until the next restart. That includes options objects passed to `child_process` and Fastify.
   - **Same root:** `catalog[node.type]` with a type named `constructor` or `__proto__` (`editor.ts:262,431`, `inspect.ts:768`) reads a prototype member and throws a 500.
   - **Fix:**
     - Build every id-keyed map with `Object.create(null)` or a `Map`.
     - Refuse node ids and socket names `__proto__`, `constructor` and `prototype` in `fromEditor`.
     - Use `Object.hasOwn(catalog, t)`.
     - Add a test with this file.

4. **A file written into a linked folder takes its extension from the item's name, and folders inside AppData can be linked** (`linked.ts:296-297`, `:35-53`).
   - **Cause:**
     - `diskName` keeps any 2-5 character extension the name carries (`/\.[A-Za-z0-9]{2,5}$/.test(safe) ? safe : …`), whatever the file really is.
     - `whyNotLinkable` refuses `AppData` and its three stores, but not the folders further inside them.
   - **Effect:** whoever can reach the API can link such a folder, then upload, rename or move a picture into it under a name ending in an executable extension.
   - **Verified in the code, not executed.**
   - **Fix:**
     - Always take the extension from the file's type (`extOf(a.mime)`), dropping the name's own.
     - Refuse anything under AppData, ComfyUI's `custom_nodes`, and Afflatus's own `DATA_DIR`. Linking `DATA_DIR/files` and then binning would also remove another item's own file.
     - When `HOST` is not loopback, require `LINK_ROOTS`.

### Workflows

5. **One saved workflow can stop the server from starting** (`apps/server/src/registry.ts:26`, `services.ts:49`).
   - **Cause:** `this.made = this.defs.map(recipeFromWorkflow)` has no try/catch. `recipeFromWorkflow` builds the graph eagerly (`recipe.ts:458-460, 473`, `usedNodes` → `build`), and `build` can throw:
     - `fillDirector` (`director.ts:30,33`) throws on a DaSiWa Director version it does not know;
     - `ancestors` (`wiring.ts:196-205`) is recursive and overflows on a very long chain.
   - **Effect:**
     - `POST /api/workflows` inserts the row first, then the reload throws: a 500.
     - At the next start, `createServices` rejects and Afflatus does not boot.
     - The workflow cannot be deleted from the UI.
   - **Fix:** wrap each `recipeFromWorkflow` call (skip and log, as the `safeParse` failure already does), build once before inserting, make `ancestors` iterative, and make `files` lazy (see MEDIUM W-8).

6. **Group-node values land on the wrong fields when a link's `target_slot` is not the socket's index** (`editor.ts:188`).
   - **Cause:** `targets.some((l) => scope.nodes.get(String(l.target_id))?.inputs?.[l.target_slot]?.widget?.name)` indexes by `target_slot`. In real files the slot does not always match the socket's index.
   - **Reproduced by the reviewer** on a corpus file (a MiniMax H3 sparse-attention workflow):
     - "megapixels" is not counted as a front field, and every later value shifts;
     - `FrameInterpolationModelLoader.model_name` becomes `"0.4824, 0.2412, 0.0"`;
     - RTX `quality` becomes 1.5.
   - **Effect:** those nodes are bypassed as saved. Turning their switch on makes ComfyUI refuse the prompt.
   - **Fix:** find the socket by `inputs.find((s) => s.link === l.id)`.

7. **A node whose pack is missing has its values read by position against a partial socket list, and they stay wrong after the pack is installed** (`editor.ts:114-117`, `MissingPacks.tsx:66`).
   - **Reproduced by the reviewer:** the same file's `UnifiedResizeImageMask` saves 13 values for 7 visible widget sockets. The import gives `megapixels: 1280, upscale_method: 768, …`, with no note.
   - **After installing the pack:** `MissingPacks` re-inspects the already-flattened wrong graph, not `start.editor`, so the wrong values are saved.
   - **Fix:** when the type is not in the catalog and there are more saved values than sockets, do not map by position; note "read once its pack is installed". After an install, rerun `fromEditor(start.editor)`.

### Timeline

8. **Splitting at the playhead cuts in the wrong place on a clip that the clip before lands on, or on a seamless one** (`timelineRange.ts:105-109` against `:165`).
   - **Cause:**
     - The web sends `assetMs = take.startMs + local`, where `startMs` is `visible().start` (`Player.tsx:183`, `menus.tsx:43`).
     - `splitClip` subtracts `plays().start`.
     - `splitAt` then adds `visible(p.active).start` back.
   - **Effect:** the cut lands 167 ms late on a landed clip, and one frame early on a seamless ×2 take. The ±40 ms bounds check also tests the wrong window.
   - **Fix:** compute `localMs = atMs - visible(active).start` and check the bounds against `visible()`. Or send timeline-clock ms, as `cutOut` does.

9. **A landing breaks as soon as the clip after is finished** (`timelines.ts:258`).
   - **Cause:** `placedOf` tests `mine.take.next_take_id === next.active.take.id`. A finished take has a new id, so the lander's `next_take_id` (the draft) no longer matches. `joinState` (`:287-291`) accepts the finished take through `same()` and still says "fresh".
   - **Effect:** `give` and `landed` are dropped. The lander stops before its guided tail, and the next clip starts 167 ms earlier. The length changes in the player, the export and `matches()`, and the join becomes the plain cut that the comment measures as a ×5 motion step.
   - **Fix:** one `landsOn(a, b)` / `follows(a, b)` helper with the `same()` rule, used by both `placedOf` and `joinState` (see LOW T-9).

10. **Undo of "the finished take" or "the slow-motion take" changes nothing but uses a step** (`timelines.ts:930, 1037`, `restore()` `:440-451`).
    - **Cause:** `restore()` keeps every take added since the snapshot, and keeps it playing when it is the clip's current take: `const playing = current && newer.some((t) => t.id === current) ? current : c.take_id`.
    - **Effect:** the header says "Undone: the finished take" while the finished take still plays.
    - **Fix:** store the added take id with the history row and drop it from `newer` on undo.

11. **Undo does not restore a timeline's project or folder** (`timelines.ts:519` labels the steps "the project" / "the folder"; `restore()` sets only name, size, music, look and mood, `:452-459`).
    - **Effect:** "Undone: the project" moves nothing back, and redo is equally empty. `adoptFolder` (`:669`) also writes `folder_id` outside any snapshot.
    - **Fix:** add `project_id`, `folder_id` and `folder_chosen` to the restore.

### Create

12. **A second tab deletes the draft open in the first, and everything typed afterwards is lost** (`apps/web/src/draft.ts:94-101`).
    - **Cause:** the sweep deletes every empty draft except the one open *in this tab* (`d.id !== openId`).
    - **Scenario:**
      - Tab A starts a new, empty draft.
      - Tab B refetches its list and deletes A's draft.
      - Every PUT in A then answers 404, the status says "Could not save … Retry", and Retry 404s for ever.
      - A reload loses the text.
    - The docs advertise drafts "from another device".
    - **Fix:** sweep on the server by age (`updated_at` older than some minutes), not from the client. In `flush`, treat a 404 as "re-create the draft with what is unsaved".

13. **A designer reply that arrives after a draft switch overwrites the other draft's conversation** (`apps/web/src/Designer.tsx:86-99`).
    - **Cause:** `onTurns` is the open draft's `setChat`, and the designer stays open across the switch (`data-designer-stays`).
    - **Effect:** draft A's conversation plus the reply replace draft B's chat.
    - **The same pattern:** `CreatePanel.tsx:81-82` writes the moved seed into whichever draft is open when `enqueue` returns.
    - **Fix:** capture the draft id when sending and write through `saveDraft(id, …)`, or key `<Designer>` by draft id and drop a late reply.

14. **Opening a tool from the viewer puts the cast's words in the prompt twice** (`apps/web/src/viewer/useViewerActions.tsx:205-208`; `apps/server/src/jobs-api.ts:29`; `entities.ts:218-226`).
    - **Cause:** `POST /api/jobs` composes the cast into the prompt before queueing, so `g.inputs` holds the composed text. The tool's new draft carries those inputs *and* gets `look: castOf(...)` again, which composes the people and looks a second time.
    - **Where:** inpaint, img2img and redraw (i, e, r), and the "subject" prompt of extend and carry on.
    - **Fix:** keep the user's own pre-compose prompt with the generation and carry that, or do not pass `look` when the carried prompt is already composed. `compose` could also skip words already present.

15. **"New outfit" and the copy buttons fail when the app is opened by LAN address over http** (`screens/kit/PersonEditor.tsx:148` `crypto.randomUUID()`; `fields.tsx:525`, `viewer/ViewerSidebar.tsx:57` `navigator.clipboard.writeText`).
    - **Cause:** both exist only in secure contexts (https or localhost).
    - **Effect:** the click throws and nothing happens.
    - **Fix:** an id from `Date.now().toString(36) + Math.random()`, and `navigator.clipboard?.writeText` with a textarea fallback, as `SnippetTable` and `Log` already do.

### Web core

16. **No error boundary: a failed chunk load or any render error blanks the whole app** (`App.tsx:146-168`, `main.tsx`).
    - **Cause:** nothing in `apps/web/src` defines an error boundary or listens for `vite:preloadError`.
    - **Scenario:** after an upgrade with a tab still open, the first click on a lazy route imports a chunk that no longer exists. React 19 unmounts the root and the page goes blank, with no message.
    - **Fix:**
      - Add a top-level boundary and one per route that offer "Reload".
      - Reload once on `vite:preloadError`.
      - Compare `hello.version`, which the server already sends (`events.ts:61`), with the build's version.

### Server core

17. **A finish or frame-interpolation job blocks the single queue for two hours when ComfyUI loses its prompt** (`apps/server/src/queueTools.ts:193-214`).
    - **Cause:** `awaitPrompt` polls `history(promptId).catch(() => undefined)`, and gives up only after `2 * 60 * 60_000` ms. After a ComfyUI crash or restart (an out-of-memory SeedVR2 run is the typical case) the history is gone. The job stays "running" and nothing else can start.
    - Renders use `waitForOutputs`, which detects a lost prompt.
    - **Fix:** use `waitForOutputs` here too, or check the queue position every few polls and throw `ComfyLost`.

18. **Cancelling a waiting job does not cancel the jobs that continue from it** (`queue.ts:189-207` against `:411-415`).
    - **Cause:** only `finish()` fails a job's dependents ("a job that waited on this one can never run now"). The queued-cancel path marks the row cancelled and returns without doing so.
    - **Scenario:** "Render clips 2-5", then cancel clip 2 while it waits. Clips 3-5 leave `waitingOn` and render anyway, minutes of GPU each, joined onto clip 2's old take or onto nothing.
    - Cancelling the *running* job goes through `finish()`, so the two cancel paths disagree.
    - **Fix:** run the same cascade after the queued cancel, with a test.

19. **"Move unused takes to the bin" bins the drafts that finished takes come from** (`usage.ts:11-15, 38-48`).
    - **Cause:** `idleTakes` is every take that is not playing. After a finish the draft never plays, so the route bins the draft's video and deletes its `takes` row, and the finished take's `finished_from` points at nothing.
    - **Effect:**
      - The next clip that continues from it loses its latent join (`queueStore.ts:33-59`).
      - A "Latent: re-sampled" finish fails with "This draft's latent was not kept" (`queueSubmit.ts:174-177`).
      - A week later the latent is erased.
    - **Fix:** leave out takes named by any `finished_from` or `prev_take_id`, and assets that are kept; do it in one transaction.

20. **A Postgres install never starts: migration 0034 uses SQLite's two-argument `max`** (`db.ts:712`: `width * height * max(1, cast(...))`).
    - **Cause:** Postgres has `GREATEST`, not a scalar `max`, so the statement fails even on an empty table. Kysely runs pending migrations in one transaction on Postgres, so the whole batch rolls back.
    - `DATABASE_URL` is documented; STATUS says the Postgres path was "written, never run".
    - **Fix:** `case when x < 1 then 1 else x end`, and one CI job that runs the migrations on Postgres. M-9 below is the same path.

### Going public

21. **112 of the 114 commits carry the owner's personal e-mail as author and committer**, and the tags v0.1.0 to v0.2.1 point into them. Only `aecf7d2` and `c70bfa0` use the noreply address.
    - **Fix:** `git filter-repo --mailmap`, then re-create the tags.
    - Push the result to a re-created repository rather than force-pushing: GitHub keeps old commits reachable by SHA for a while.

22. **The deleted session notes (`STATUS.md`) are in 66 commits of history** (deleted by `0d94968`). They hold working notes and quotes, the kind of file `.gitignore` calls "never published".
    - **Fix:** drop the file in the same filter-repo pass (`--path STATUS.md --invert-paths`).

23. **The Helm chart answers 403 to its own Ingress** (`chart/templates/deployment.yaml` sets only `HOST`, `PORT`, `DATA_DIR`).
    - **Cause:** `hostCheck.ts` allows only loopback, a real `HOST`, `PUBLIC_URL` and `ALLOWED_HOSTS`, so `ingress.host` is refused unless the user knows to add it.
    - **Fix:** when `ingress.enabled`, set `PUBLIC_URL` and add `ingress.host` to `ALLOWED_HOSTS`, and say so in `install-cluster.md`.

## MEDIUM

### Security and exposure

- **S-1. Redirects get past the outbound check** (`downloads.ts:253`, `fromLink.ts:118`).
  - `assertPublicUrl` judges only the first address, and both fetches use `redirect: "follow"`. A public link that redirects to a LAN or link-local address (`169.254.169.254`) is followed.
  - Also check that the Civitai key in `d.headers` is not sent on to the redirect target.
  - **Fix:** `redirect: "manual"` and re-check each `Location`, at most five hops.
- **S-2. A workflow file chooses which code ComfyUI-Manager installs** (`editor.ts:331` reads `properties.cnr_id`; `packs.ts:29-35,59` gives it priority over Manager's own map and installs any `https://github.com/...` value as a nightly clone).
  - One click on "Install the pack" then runs that repository inside ComfyUI. `MissingPacks.tsx:90` shows it as a `registry.comfy.org` link, which misleads.
  - **Fix:**
    - Accept only registry ids (`^[\w-]+$`) from the file.
    - Prefer Manager's map.
    - Show a git URL verbatim with "not from the registry".
- **S-3. Subgraph bomb** (`editor.ts:248-254, 411-424`). Group nodes are opened recursively with no depth limit, no total cap and no cycle check. A definition that contains itself overflows the stack; a 10-way fan-out seven deep makes 10^7 nodes in the single Node process. **Fix:** cap the depth (8) and the opened nodes (20 000), and refuse a definition already on the path.
- **S-4. Quadratic work and backtracking regexes on strings from an imported file.**
  - `editor.ts:343-351` scans the lines above each bare URL before the 80-link cap.
  - `editor.ts:347`, `suggest.ts:123-130` and `types.ts:20` backtrack on long runs of spaces and punctuation.
  - **Fix:** clamp titles, labels and notes when reading them, and stop at 80 links.
- **S-5. `fromEditor` trusts the file's shape through `as` casts** (`editor.ts:224, 230, 333, 420, 529`). A `null` node, an object where an array belongs, or a non-string name gives a raw TypeError 500. **Fix:** a loose zod schema for the editor file at the route (it also strips `__proto__`, see HIGH 3).
- **S-6. A preset's `look` is never validated** (`entities.ts:51` `look: z.unknown()`, `presetFile.ts:46`, `PresetEditor.tsx:32`).
  - A malformed look crashes the form (`draft.ts:149` reads `look.cast.length`).
  - A look of another wrong shape makes every later draft save fail the strict `lookSchema`.
  - **Fix:** `lookSchema.nullable().optional()`, and drop the casts.
- **S-7. The no-login port is published on every interface by default** (`compose.yaml`, the README's `docker run -p 8720:8720`). `LINK_ROOTS` is missing from the README's table, though `install-docker.md` says to set it whenever the port is published. **Fix:** `127.0.0.1:8720:8720` with a comment on opening it.

### Timeline

- **T-1. Holding Ctrl+Z sends overlapping undos** (`useEditorKeys.ts:42-45` does not check `isPending`; `timelines.ts:470-487` reads, snapshots, restores and deletes in four steps outside one transaction). Two requests restore the same row. **Fix:** ignore the key while pending, and serialise undo, redo and `remember` per timeline.
- **T-2. `duplicateClip` keeps `finished_from` pointing at the original clip's takes** (`timelineRange.ts:129`); `splitAt` drops it from the second half (`:168-175`). Finish → redo on the copy then upscales the already finished take. **Fix:** remap it through `ids`, and carry it in `splitAt`.
- **T-3. Trims and "Extend from this frame" work in shown time but write raw trims** (`TimelineEditor.tsx:355`, `Track.tsx:152-153`, `Inspector.tsx:251`). On a landed or seamless clip the join breaks and the cut moves away from the frame the user saw. **Fix:** let the server convert from shown time, as `endAt` and `splitAt` do.
- **T-4. The Inspector computes the room from `asset.durationMs`; the server uses `lengthOnGrid()`** (`Inspector.tsx:160`). On ×2-interpolated takes this is off by about a model frame. **Fix:** send `roomMs` in `takeView`.
- **T-5. `editClip` records the undo step before validating** (`timelines.ts:724-740, 774`). A refused edit leaves an empty step, a lost redo stack and a half-applied patch. **Fix:** check first; update the clip and the take in one transaction.
- **T-6. Finish and slow-motion tool jobs are not idempotent across a restart** (`queueTools.ts:146-154`). `finished()` has a "placed already" guard; `takeFrom` has none, so a resumed job adds a second take and asset. **Fix:** store the made asset id on the job before placing it.
- **T-7. `matches()` runs ffmpeg once or twice per join, one after another, inside one HTTP request** (`timelineMedia.ts:121-151`). It is keyed by `take:fromMs`, so every trim recomputes it. **Fix:** compute the means when a take is stored, and run the joins with a small concurrency.
- **T-8. `view()` cost grows with history** (`timelines.ts:320-348`). It loads every job ever run for the timeline's clips, filters them per clip, and parses every generation's `resolved`, on every `timeline` event. **Fix:** only live jobs plus the last per clip; store `measure` in its own column.
- **T-9. A rendered clip trimmed to nothing shows as unrendered** (`timelines-api.ts:50-51` has no maximum; `timelines.ts:772-783` clamps only at 0). **Fix:** clamp on the server so at least about 100 ms plays.
- **T-10. Clips can be reordered only by dragging.** There is no "Move earlier/later" in the clip menu, and the trim separators cannot take focus. **Fix:** menu items, or Alt+←/→ on a focused clip.
- **T-11. A timeline refetch while playing restarts the player's frame loop** (`Player.tsx:51, 233-370`; `seq` follows the `clips` identity). **Fix:** key `seq` on a stable signature and read it through a ref.

### Create

- **C-1. The web lets you pass the server's limits, and then every save fails** (`lookSchema` caps the cast at 8 and snippets at 30, `entities.ts:75,78`; `LookBar.tsx:89`, `Snippets.tsx:60`, `PersonEditor.tsx:148` have no caps). A 9th cast entry makes every draft save answer 400. **Fix:** export the limits from core, enforce them in the UI, and show the 400 message.
- **C-2. Closing or reloading the tab loses the last edit** (`draft.ts:91`, `useEntityDraft.ts:42` flush only on unmount; there is no `pagehide`). **Fix:** flush on `pagehide` with `fetch(…, { keepalive: true })`, and add `beforeunload` while a save has failed.
- **C-3. The whole Studio re-renders on every sampler step** (`Studio.tsx:146`, `CreatePanel.tsx:169` read `useQueue()`, which is patched every progress event). **Fix:** `useQueue(select)` with narrow selectors; `memo` `CreatePanel` and `Tile`. *(likely)*
- **C-4. "Show final prompt" sends one `POST /api/compose` per keystroke** (`LookBar.tsx:33-37`). **Fix:** `useSettled` the input in the key.
- **C-5. Typing in the prompt redoes the whole form's work** (`CreatePanel.tsx:69,170`, `RecipeForm.tsx:287-291`, `ModelLoad.tsx:35`): `formDefaults` twice per render, and the whole form stringified. *(likely)*
- **C-6. A hard-coded card threshold silently drops the refine pass** (`flow/recipes.ts:85-86, 475-476`, `krea2/recipes.ts:290-291`: `REFINE_MAX_PIXELS = 3.2e6`, "does not fit a common card"; `klein/recipes.ts:287` 2.6e6). Above it, without the tile nodes, "img2img pass after upscale" is skipped with no message, on any card. This goes against the no-card-figures rule. **Fix:** always tile, or learn the limit from `render_stats`; at least say on the form that it was skipped.
- **C-7. Deleting is immediate in some places and confirmed in others** (`CreatePanel.tsx:317` deletes a draft and its conversation at once; `People.tsx:97` row "Delete" is immediate; `People.tsx:228` uses `TwoStep`). **Fix:** one behaviour.
- **C-8. Draft actions fail silently** (`draft.ts:79-87`: `createDraft(...).then(...)` has no catch, so `creating.current` stays true and the form never appears; `CreatePanel.tsx:310,317,318` use `void`). **Fix:** catch, reset, and banner.

### Workflows

- **W-1. `Get`/`Set` and switch targets across a subgraph boundary are dropped without a note** (`editor.ts:312-316, 477-481, 537`). The file says "what it cannot read is said in notes". **Fix:** look for the SetNode in the root and every definition, and note what is still not found.
- **W-2. False "values may have been read wrong" notes on group nodes** (`editor.ts:416-419`). The check runs even when the `proxyWidgets` path read the values correctly; 11 corpus files carry the note, and it says "A group node" without a name. **Fix:** skip it on the proxy path, and name the node.
- **W-3. No hint for nodes that write outside ComfyUI's folders or run code.** An imported workflow runs as is. "Hints, not rules": a note at inspect for absolute or `..` paths in string widgets, and for a short list of known exec or file-writing node types. *(unverified)*
- **W-4. Six different "model file" regexes and two "sampling pass" rules** (`inspect.ts:104`, `wiring.ts:357`, `recipe.ts:25,444`, `model.ts:4`, `WorkflowEditor.tsx:159`; `inspect.ts:644,680` vs `suggest.ts:77-89`, `recipe.ts:427`). A `.engine` or `.onnx` file is flagged at import but not counted in `files`; WanVideo samplers get sections but no pass labels. **Fix:** one `MODEL_FILE` and one `isSamplingPass` in `catalog.ts`.
- **W-5. The corpus test asserts little and does not run in CI** (`corpus.test.ts:19-31` compares booleans and counts; `notes` are recorded but never compared; the corpus is gitignored, so CI skips it). HIGH 6 and 7 pass today. **Fix:**
  - assert `notes <= was.notes`;
  - snapshot the bound targets per file;
  - commit synthetic fixtures for HIGH 3, 6 and 7 and for S-3 and S-4.
- **W-6. The editor's preview rebuilds the whole recipe on every keystroke** (`WorkflowEditor.tsx:263-269` depends on `title`; `recipe.ts:473` builds eagerly). The same work runs on every registry load, for every saved workflow. Its `catch { return null; }` hides the reason. **Fix:** make `files` lazy, drop `title` from the dependencies, and show `err.message`.

### Web core

- **WC-1. The `hello` event refetches every query on every page load** (`live.ts:88`; the server sends `hello` on the first connection too, `events.ts:61`). About fifteen queries are cancelled and started again. `call()` passes no `AbortSignal`, so both requests reach the server. **Fix:** ignore the first `hello`, and pass `signal` through `call()`.
- **WC-2. Escape in a dropdown inside a Dialog closes the whole Dialog** (`Dialog.tsx:42-47`: a window capture listener stops Escape; only Tab has the `[role=listbox],[role=menu]` exception). The Finish dialog loses its settings. **Fix:** the same exception for Escape.
- **WC-3. Every library change refetches about ten queries, and each user action does it twice.**
  - **Cause:**
    - `live.ts` invalidates the `["assets"]` prefix, which now covers the list pages, folders, storage, families, models, estimates, render times, lanes (limit 500) and the backup plan.
    - Mutations invalidate it again in `onSuccess` (`TileMenu.tsx:66-68,93`, `Library.tsx:162`), though the server already emits `library`.
    - `folderImport.tsx:57` invalidates every 8 uploads.
  - **Fix:**
    - Drop the mutation invalidations where the server emits `library`.
    - Move the derived queries off the `assets` prefix.
    - Throttle `library` as `queue` already is.
- **WC-4. Every `queue` event refetches every loaded page of the History** (`data.ts:18` under the `["queue"]` prefix). With notifications on, `watch()` makes another `api.queue()` (`live.ts:36`). **Fix:** key the history apart, and refetch it when a job ends.
- **WC-5. Tile-menu actions fail silently** (`TileMenu.tsx:66-80,93,157`, `History.tsx:154-166` Requeue/Dismiss/Retry, `actions.ts:155` `useMakeTimelineOf`). **Fix:** `onError` → `useBanners().push`.
- **WC-6. A folder import can stay stuck until reload** (`folderImport.tsx:37`: if `api.folders()` throws, `run` stays `{ over: false }`; the note has no close button, and every later import is refused). **Fix:** `try/finally`.
- **WC-7. Text in the light themes fails contrast.** Computed from `themes.ts`/`palettes.ts`:
  - `ink-3` on a panel: 2.63 in Latte, 3.29 in Dawn;
  - `ink-2`: about 4.0;
  - the accent in Latte: 2.15.
  - **Fix:** map `ink-3` and `ink-2` to darker steps in light themes, and test `contrast(ink-*, panel) >= 4.5` for every theme.
- **WC-8. Render times: a preset window freezes when it is clicked** (`Times.tsx:25-29,106` sends a fixed `to`). New renders never appear in "24H". **Fix:** send the period and let the server take "now".
- **WC-9. Query keys that nothing refreshes:**
  - `Projects.tsx:101` invalidates `["drafts"]` with `exact: true` (the list is `["drafts","list",project]`);
  - `TileTip.tsx:42` uses `["asset", id]` beside `["assets","one",id]`;
  - `useViewerActions.tsx:157` keeps a project-less `["drafts"]` copy.

### Packages and node pack

- **P-1. An outdated node pack is reported as "loaded", and seamless joins and landings quietly fall back to ordinary ones.**
  - **Cause:** `nodePack.ts:17-18` probes `AfflatusH3TailGuide`, "its newest one", which is in fact one of the oldest; `h3/join.ts:20` says it is unused. Nothing calls `GET /afflatus/version` (`__init__.py`).
  - **Effect:** with pack 0.5.0 still loaded, `ctx.has(H3_SEAM)` and `ctx.has(H3_LANDING)` are false, so `resolveJoin` and `h3/video.ts:92` pick plain joins with no error.
  - **Fix:** compare `/afflatus/version` with the pack's version (one shared constant).
- **P-2. Saved H3 latents accumulate in ComfyUI's output folder** (`latent_io.py:62-74`, `h3/finish.ts:101,103`): `output/Afflatus/h3_*` and `h3fine_*` for every render, plus the MP4s of the ComfyUI-only video path. Nothing deletes them; `clean-input` covers only `input/afflatus/`. **Fix:** write them to ComfyUI's temp folder (it is cleared at start), or extend the cleanup to `output/Afflatus/h3*` older than N hours.
- **P-3. The progress bar sits at 99% through H3's latent re-sample** (`h3/video.ts:122-123`, `latent-upscale.ts:46-47`, `monitor.ts:83,329-330`): `MMH3UltimateUpscale` is in a "refining" phase, which counts as sampler steps on top of `totalSteps`. **Fix:** add it to `passes` with its own step count, or give it a non-sampler phase. *(likely)*
- **P-4. The fake ComfyUI still differs from the real one** (`testing.ts`):
  - it broadcasts every message to every socket, where real ComfyUI sends progress only to the prompt's `client_id`, so no test can catch a clientId bug (one has already happened);
  - KSamplerAdvanced passes report the full `steps`, not `end - start`;
  - it never sends `executing {node: null}`, `execution_success` or `execution_cached`.
  - **Fix:** route by `client_id`, report the sliced step count, and send the end-of-prompt messages.
- **P-5. No Python is tested or even compiled in CI** (`ci.yml:22-26`). **Fix:** `python -m py_compile comfy-nodes/afflatus-nodes/*.py` now. Then add pytest with stubs for the frame and token arithmetic (Trim at 22/39/56 frames, Seam lengths, Landing `start_t`).
- **P-6. Wan, LTX and H3 each carry the same finishing code** (`h3/finish.ts:84-97`, `wan/video.ts:291-307`, `ltx/video.ts:363-380`):
  - `early = seedvr || model`, the pixel upscale, the RIFE block and `saveVideo` at `fps * 2`;
  - the `ModelPreviewOverrideKJ` block three times;
  - the per-LoRA `LoraLoaderModelOnly` loop seventeen times.
  - **Fix:** `finishFrames(...)`, `livePreview(...)` and `applyLoras(...)` in `recipes/src/shared`.
- **P-7. `parseInput` casts zod's output to the hand-written input interface** (`core/src/recipe.ts:170-172`), and nothing checks that the two match. The last review found three fields missing this way. **Fix:** a test per recipe that the parsed keys equal the input ids; longer term, derive the type from the `inputs` array.

### Server core

- **M-1. A SQLite migration that fails halfway can stop the app from starting** (`db.ts:1037-1043`). Kysely's SQLite adapter does not wrap migrations in a transaction, so part of a multi-step migration stays applied but is not recorded as done; the next start retries it and fails on "duplicate column". Several migrations have several steps (0007, 0008, 0023, 0032). No copy is made first. **Fix:** wrap each `up` in `db.transaction()` (SQLite allows DDL in one), and `VACUUM INTO afflatus.db.pre-<name>` when migrations are pending.
- **M-2. Unkeeping or binning in the library has no "still used" guard.**
  - **Cause:** timeline use keeps an asset (`timelines.ts:578`), but `/:id/keep`, `/bulk` and `DELETE /:id` (`assets-api.ts:375-424`) accept a take, still, music or cast picture.
  - **Effect:** the sweep bins it after a day and erases it after a week (`sweep.ts:15-48`). That leaves `clips.take_id`, `still_asset_id`, `sound_asset_id`, `timelines.music_asset_id`, `prev_take_id` and `finished_from` pointing at nothing.
  - **Also:** `POST /api/entities` does not keep the pictures it names (only `PUT` does, `entities.ts:284`).
  - **Fix:** one `stillUsed(asset)` check (timelines, entities, presets, queued jobs) in the sweep and in those routes.
- **M-3. Retrying a finish job loses `finished_from`** (`queue.ts:284-291`: `again()` does not pass it). The retried latent re-sample renders as an ordinary clip render and is not recorded as a finish. **Fix:** pass `finishedFrom: row.finished_from`.
- **M-4. A job resumed after a restart can neither run nor be cancelled while ComfyUI is offline.** `cancel()` acts only on the in-memory `this.running`, and `whileOffline` expires only `queued` rows (`queue.ts:201-206, 393-402`). *(likely)*
- **M-5. Finish and RIFE tool jobs ignore pause and do not wait for an offline ComfyUI.** Every `CUT_JOB` is exempt from pause (`queue.ts:354-363`), though SeedVR2 and RIFE use the GPU. Conversely, exports queued behind a GPU job wait for ComfyUI they do not need.
- **M-6. Errors only logged:**
  - a take that cannot be placed leaves the job "done" and the clip empty (`queue.ts:507`, `console.warn`);
  - a missing latent turns a latent join into a frame join without a word (`queueSubmit.ts:127, 132`).
  - **Fix:** write a warning on the job or the take.
- **M-7. One slow outlier marks every larger form as "past where this model slowed down"** (`forecast.ts:131-136`: `cliffAt` is the smallest render that cost twice the usual). **Fix:** require two such renders, above the largest at the usual pace.
- **M-8. Restore is neither implemented nor tested.**
  - Restoring is "unzip into DATA_DIR" in a README; `backup.test.ts` checks the zip's entries only.
  - A file the sweep deletes while the backup walks aborts the whole backup (`backup.ts:45, 99`).
  - On Postgres the README still says the zip holds `afflatus.db`.
  - **Fix:** skip vanished files, and add a restore round-trip test.
- **M-9. Postgres integer overflow:** `render_stats.work` (pixels x frames: a 45 s 1080p clip is 2.2e9) and `assets.bytes` (an export over 2 GiB) are `integer`, which is int4 on Postgres. **Fix:** `bigint`.
- **M-10. `renders.ts` `fold()` is not atomic** (`:216-238`). A stop between the upserts and the delete counts the rows twice at the next fold.
- **M-11. "Empty bin" duplicates the sweep's erase loop without `derivedKeys`** (`usage.ts:50-62`), so film strips, motion and scene files leak. **Fix:** one shared `eraseAsset()`.
- **M-12. Performance:**
  - more missing indexes: `render_stats(model_file, status, created_at)` for the forecast on every form change, `generations(draft_id)`, `generations(family)`, `assets(origin, kept_at)` for the sweep;
  - every progress event re-runs the whole `queue.status()`, up to four times a second (`events.ts:28-39`);
  - `services.ts:56-60` `infoOf` reads and parses the whole `model_info` table on each call;
  - an unguarded `JSON.parse` of a corrupt `inputs` row breaks the whole history or status (`queue.ts:101`, `queueView.ts:135, 259`).

### Release

- **R-1. The image and the bundles do not install the audited dependency tree** (`scripts/release/stage.mjs`: the server's direct deps, then `npm install --package-lock-only` against the live registry at each release; each release job does this on its own). **Fix:** stage once and pass `release/app/package-lock.json` to the image and bundle jobs, or `pnpm deploy --prod`.
- **R-2. The PodMonitor scrape answers 403** (Prometheus sends `Host: <pod IP>:8720`). `deploy/grafana/README.md:30` also says port 8721, which is the dev server. **Fix:** exempt `/metrics` and `/api/health` from the Host check, and say 8720.
- **R-3. Chart version and image tag are stale and tied to the homelab:**
  - `Chart.yaml` 0.1.0 and `values.yaml` `image.tag: "0.1.0"`, while the app is 0.2.1;
  - `install-cluster.md` says the tag defaults to `appVersion`, which is false;
  - `storageClassName: longhorn`;
  - "while the image is private";
  - a private GitOps example in `install-cluster.md:26-66`.
  - **Fix:** `tag: ""` with `default .Chart.AppVersion`, `storageClassName: ""`, and a generic Argo example.
- **R-4. The GHCR package stays private when the repository goes public**, so the README's `docker run ghcr.io/…` fails for everyone. Make the package public once, before announcing.
- **R-5. A pre-release tag would become `latest`** (`release.yml` always adds `type=raw,value=latest`; `v*` matches `v0.3.0-rc1`). **Fix:** `enable=${{ !contains(github.ref_name, '-') }}`, and mark the GitHub release `prerelease`.
- **R-6. Docs that promise what the code no longer does:**
  - `docs/architecture.md` is the 2026-10-01 pre-build proposal ("Nothing here is built"), citing files of another, private app;
  - the node pack README lists 8 of 11 nodes and describes the removed hybrid guide;
  - "vendored unchanged" (README, pack README, `__init__.py:14`), though `continuation_nodes.py:414-428` carries a change;
  - `install-desktop.md` says "nothing is written outside the folder you unpacked", but temp folders and the node pack are.
- **R-7. No third-party notices travel with the web bundle** (React, lucide, wouter, zustand, react-query and the OFL fonts, whose licence must accompany the files), nor with `danbooru.csv.gz` (MIT, upstream named in `apps/server/assets/README.md` but its licence text not shipped). **Fix:** generate `THIRD_PARTY_NOTICES.txt` at staging; add `LICENSE-danbooru-tags`.

## LOW

Compact; each is quick.

- **Dead code** (verified by whole-repo word search):
  - **Timeline:**
    - the `lead_ms` take-over: `leadFor` is always 0 (`timelineModel.ts:90`); the `takes.lead_ms` column is only written; `takeView.leadMs` is read only by a test;
    - the hybrid join: the `frames → "hybrid"` branch of `joinKindOf` (`core/graph.ts:67`) and the `"hybrid"` checks in `timelineExport.ts:62`, `ClipTip.tsx:40`, `App.tsx:67` serve old takes only;
    - `MATCH` is imported and unused in `timelineExport.ts:1`;
    - the `Timelines.takeOf` wrapper (`:1064`);
    - `pictureAt`'s `edge === "end" ? X : X` (`timelineRange.ts:277`).
  - **Create:**
    - per-input advice: `/api/advice` always returns `items: []` (`setup-api.ts:76`), so `word`, `warnOf` and the "Heavy:" line never fire, and `forecast.ts:105` builds a `hint` nobody reads;
    - `Scope "kept"` is no longer offered;
    - the redundant `setQuery("")` effect (`RecipeForm.tsx:343`).
  - **Web:** `useAddToLast` (`actions.ts:139`).
  - **Python:** `read_frames()` (`latent_io.py:120-126`).
  - **Registered but used by no recipe:** `MiniMaxH3AppendContinuation` and `AfflatusH3TailGuide`.
  - **Exported but used only in their own file:** about 90 symbols in core, comfy and recipes (`WAN_NEGATIVE`, `H3_MAX_PIXELS`, `NODE_PACKS`, `refineSigmas`, …); `latentFramesOf`; web `comfyHref`, `useLastTimeline`, `ClipMark`, `PackState`, `ROLE_WORDS` (and a second, different `ROLE_WORDS` in `formTarget.ts`), `Display`.
- **Duplication:**
  - **Timeline:** the `same()` lambda twice (`timelines.ts:266, 287`); the follow, seam and landing conditions in `placedOf` and `joinState`; the player's `blendOf`/`dissolveOf` against the server's `joinFade`; the 17k+5 grid three times. All belong in `packages/core`.
  - **Create:** seed wrap and `RANDOM_SEED` three times each; LoRA trigger words three times (`fields.tsx:57`, `designer.ts:446-453` and `:505-521`); the upscaled-frame maths (`RecipeForm.tsx:438-440`, `fields.tsx:282-283`) against `latentUpscaleSize`; `holdsNothing`; `lookAdds`/`emptyLook`; `estimateFor`/`estimateMs`.
  - **Workflows:** the group-edge lines (`editor.ts:270-281`, `:498-508`); six consumer maps; five "primitive or value node" tests; `defaultOf` twice; the `pic_` id.
  - **Web:** five duration formatters beside `format.ts`; two debounce copies beside `useSettled`; the rename mutation three times; the "Move to → project" submenu twice; blob download three times (`Workflows.tsx:130` revokes the URL at once, where `presetFile.ts:34` waits a second); the brush code in `Chart.tsx` and `Times.tsx:402-420`.
  - **Python:** `AfflatusH3LatentHeadGuide` is `Landing` with `land_at = 0` (`latent_io.py:206-244` against `:275-313`).
  - **Krea 2:** see the open items above.
- **Small bugs:**
  - **Timeline:**
    - ClipTip labels a faded take "Seamless latent join" (`ClipTip.tsx:40`, check `take.seamless`);
    - an unknown `after` id moves the clip first (`addClip :593`, `editClip :786`);
    - `cutOut` keeps unrendered clips inside a removed range (`timelineRange.ts:223-243`);
    - `matches()` resets the colour carry after an unrendered clip, unlike the export;
    - two tabs can each queue an export, and two `remember()` calls can share a `seq` (no unique index);
    - the plan route makes about 24 undo steps for one plan;
    - `continueFrom` makes two steps and a `void` rejection;
    - strips and motion are served `immutable` for a year though linked files change (`timelines-api.ts:336-351`);
    - a finish whose draft was removed plays its hidden run-up (`addTake :826`);
    - `handoverAt(...).catch(() => null)` hides "ffmpeg not found" (`timelines.ts:882`).
  - **Create:**
    - advice keys the recipe no longer has make the estimate vanish (`RecipeForm.tsx:306-314`);
    - only required pictures are checked before sending (`CreatePanel.tsx:73`);
    - image inputs do not check `asset.kind` (`queueSubmit.ts:59`);
    - a preset for a missing recipe moves the draft there (`CreatePanel.tsx:138-141`);
    - `DraftResults.tsx:30` fetches when `list` is given;
    - `People.tsx:81-85` drops another item's pending edit;
    - `Strip` puts ids into `querySelector` unescaped (`RecipeForm.tsx:140,147`);
    - `TagCheck` and `useLoraWordsOf` swallow failures (`fields.tsx:90, 602-609`);
    - `/api/designer/test` 500s on an unknown id.
  - **Workflows:**
    - held-path URLs are not checked to be http(s) (`types.ts:131,133`);
    - frame `parent` cycles recurse for ever (`suggest.ts:68-74, 205-208`);
    - a subgraph used twice shares link and frame state (`editor.ts:235-242, 383-395`);
    - `ancestors` recomputed in sorts (`inspect.ts:651-657, 874, 884`);
    - compressed PNG text chunks are reported as "no workflow" (`Workflows.tsx:38-43`).
  - **Web:**
    - `Workflows.tsx:63` reads `body.message` where the server answers `{ error }`;
    - `ComfyCard.tsx:128` has no catch;
    - the tab icon draws the old app's letter "s" (`TabProgress.tsx:23`);
    - "a Afflatus tab" (`NotifyCard.tsx:20`);
    - keyboard-opened menus land at the top-left corner;
    - `TextAsk` keeps the first question's text (no `key`, `Confirm.tsx:104`);
    - destructive confirms focus the danger button;
    - notifications fire in every tab;
    - `MissingPacks` polls without end;
    - two screen modules hold stores (`TileMenu.tsx:10`, `DropTray.tsx:9`), which makes import cycles.
  - **Packages:**
    - `AfflatusH3SeamLatent` aligns dtype but not device (`latent_io.py:357-360`);
    - `/afflatus/header` answers 500 on a header that is a list (`__init__.py:96`);
    - the routes do blocking file I/O on ComfyUI's event loop;
    - the monitor socket reconnects only on `ensure()`;
    - `execution_cached` is ignored;
    - number inputs are not `.int()` (`core/inputs.ts:245`);
    - `optionalNodes` widens the recipe test's blind spot.
- **Server core:**
  - `core.loaded(base)` is noted before `client.submit`, so a failed submit leaves the next job thinking the model is loaded (`queueSubmit.ts:203-205`);
  - a crash between ComfyUI accepting a prompt and `resume` being saved renders it twice (`queue.ts:476-477`);
  - a failed `store()` leaves its files in storage with no row;
  - a resumed job that already has `generation_id` is rendered again and then discarded (`queue.ts:503`);
  - tool jobs never re-arm the idle unload (`runTool`);
  - the sweep deletes files before the row;
  - `downloads.ts` `persist` writes without temp-and-rename and marks a download still "saving" at shutdown as "interrupted";
  - designer upstream failures answer 400 (502 fits), and one turn can take about 8 minutes;
  - `updates.daily()` failures are swallowed;
  - history search is case-sensitive on Postgres only;
  - write-only columns: `generations.recipe_version`, `model_info.read_at`, `model_pages.found_at`;
  - `UserError`, `DesignerError` and `LinkedError` duplicate `httpError`;
  - `renderedOf`/`draftOf` are one loop twice (`queueStore.ts:33-59`);
  - `rifeModelIn` re-implements `choicesOf`;
  - the job-kind mapping is written twice in `queueView.ts`;
  - the settings upsert three times in `queue.ts`;
  - unvalidated query or params: `GET /api/entities` (`kind` cast), `/api/jobs/:id/stage/:n`, `/api/civitai/find`, `?recipe=` on the embedded routes;
  - misplaced doc comments in `queueSubmit.ts:280-284`, `queueTools.ts:26-30` and `designer.ts`.
- **Owner's rules:**
  - filter-gated or back-style buttons ("Every folder" only with a folder filter, `TileMenu.tsx:271`; "Back to 24H" and "Apply" in `Times.tsx:167,169`);
  - a fixed 80 °C "hot" threshold (`App.tsx:94`, `Queue.tsx:31`, `Times.tsx:196`; temperature, not VRAM, so the owner's call);
  - `docs/builtins-audit.md:5` names one card and its memory.
- **Accessibility:**
  - `KeysHelp` is not a `Dialog`;
  - `Select`'s list is not announced (no `combobox`/`aria-activedescendant`);
  - every library tile is named "Open image" (`Library.tsx:78`);
  - `SeedField`'s label points at nothing in Random mode;
  - `SizeField` and the caption toggles have labels without a control;
  - the Operation radiogroup has no arrow keys;
  - the clip's `div role="button"` holds a `<button>`.
- **Tests:**
  - `monitor.test.ts:129` is new and flaky: it asserts a 40 ms step measures under 90 ms of wall-clock, and measured 94.5 ms on a loaded machine. Assert against the fake's own clock, or widen the bound.
  - `format.test.ts`, `grouping.test.ts` and `diff.test.ts` assert little.
  - Easy pure modules with no tests: `format.ts` (most of it), `themes.ts` (contrast), `Library.tsx tree()`, `Chart.tsx curve/ceiling`, `presetFile.ts`, `folderImport.ts folderFor`, the progress merge in `live.ts`.
- **Release:**
  - stale `.pyc` files are tracked (`comfy-nodes/afflatus-nodes/__pycache__`, not shipped): `git rm --cached`;
  - `packages/workflows/.vitest/` is untracked and holds local paths: ignore it;
  - `HANDOVER*.md` instead of listing each one, in `.gitignore` and `.dockerignore`;
  - base images not digest-pinned;
  - the image's Debian ffmpeg is a GPL build the README does not mention;
  - workflow inputs interpolated into `run:` (`release.yml`);
  - stale comments in `bundle.mjs:20`;
  - pnpm 10.6.2;
  - the AGPL source link points at `main`, not the running tag;
  - `docs/code-review-2026-10-05.md` lists attack paths that are now fixed: mark it so, or drop it;
  - make sure `apps/server/dist` is rebuilt before release (a stale build still sends `skip_frames`).

## Giant files and functions

Lengths measured on today's code (TypeScript compiler API, top-level functions and components). Each split follows a seam that already exists.

| Function | Where | Lines | Split |
|---|---|---|---|
| `TimelineEditor` | `screens/TimelineEditor.tsx:44` | 743 | `useTimelineMutations`; `placeItems` (`:374-430`) into `menus.tsx`; `TimelineHeader` (`:464-509`) and `Transport` (`:532-566`); the designer IIFE (`:734-772`) as `ClipDesigner` |
| `WorkflowEditor` | `screens/WorkflowEditor.tsx:106` | 730 | `useMapping()` (state, `:108-245`); `ReadPanel` (step 1, `:362-545`) with `MediaRoles`; `BeforeItRuns` (`:547-646`); `SwitchList`, `StagesPick`, `WidgetList` (step 2); `FormPanel` (step 3) |
| `Inspector` | `timeline/Inspector.tsx:76` | 492 | its `takesInner`, `durationInner`, `pinnedInner`, `lookInner` consts become components |
| `Player` | `timeline/Player.tsx:48` | 436 | the 138-line step effect (`:233-370`) into `useHandover`; `blendOf`/`dissolveOf` replaced by a shared `joinFade` |
| `registerAssets` | `server/assets-api.ts:53` | 384 | list and search, file and thumb, upload, keep/bin/restore/move: one `register*` each |
| `Form` | `RecipeForm.tsx:259` | 380 | a pure `layoutOf(recipe, values, seen, q)` in `form.ts` (testable); `summariesOf`; `useFormSearch`; `ModelDefaults`; `InputsPart`, `OutputPart` |
| `flowRecipes` | `recipes/flow/recipes.ts:193` | 368 | one file per recipe (`picture`, `redraw`, `paint-over`, `outpaint`, `sharper`, `fix-face`) taking `(spec, kit)`; Krea 2 then reuses them |
| `CreatePanel` | `studio/CreatePanel.tsx:34` | 367 | `ModelPicker`, `PresetMenu`, `DraftHeader`, `useGenerate`, `GenerateBar` |
| `recipeFromWorkflow` | `workflows/recipe.ts:142` | 345 | `formInputs(def)`; `placeSections`; `buildWorkflow` hoisted; lazy `filesOf` |
| `Trim` | `Trim.tsx:63` | 336 | frame decoding into a hook; the key handling into `useTrimKeys` |
| `fromEditor` | `workflows/editor.ts:222` | 332 | `openScopes`, `resolveLink`, `readSources`, `frames`, `visitNodes`, `readSwitches` with one shared context |
| `registerDesigner` | `server/designer.ts:413` | 304 | the helpers closing over `s` into `designerContext.ts` (removes the duplicate `triggersOf`); `checkedReply()` for the retry ladder |
| `startFakeComfy` | `comfy/testing.ts:126` | 296 | `fakeRoutes`, `fakeManager.ts`, `fakeSockets` (per-clientId routing, P-4), `simulate` |
| `Track` | `timeline/Track.tsx:29` | 292 | the rest of its drop and ruler logic into the existing `track/` hooks |
| `MaskPainter` | `MaskPainter.tsx:32` | 290 | `useBrushCanvas`, `PainterToolbar` |
| `registerTimelines` | `server/timelines-api.ts:109` | 279 | `renderClips()` (`:155-199`), `finishClips()` (`:233-280`, its latent eligibility apart) |
| `suggestSections` | `workflows/suggest.ts:155` | 255 | `framesToSections`, `byRole`, `placeValueNodes`, `mergeTwins`, `splitLong` |
| `useViewerActions` | `viewer/useViewerActions.tsx:32` | 250 | `useNewDraftActions` (where HIGH 14 is fixed), `useMediaExtract`, the key map |
| `FolderPanel` | `screens/Library.tsx:159` | 243 | `useFolderMutations`, `FolderRow`, `NewFolderForm`, `BinFooter`; move to `screens/library/` |
| `RenderTimes` | `screens/queue/Times.tsx:105` | 234 | `useTimesView` (also fixes WC-8), `WindowBar`, `SummaryTiles`, `ModelTable`, `RenderList`; formatters to `format.ts` |
| `Queue` | `screens/Queue.tsx:38` | 220 | `RunningCard`, `WaitingList`, `MachineMeters`, `QueueControls` |
| `submit` | `server/queueSubmit.ts:40` | 194 | one uploader per input type (`uploadImage`, `uploadWholeClip`, `uploadJoinClip`, `uploadReferences`, `uploadSound`), `checkMasks`, `timingOf` |
| `ltxVideo.build` | `recipes/ltx/video.ts:207` | 192 | `ltxFrame`, `ltxLoad`, `ltxTwoPass`, `ltxOnePass`, `ltxTemporal`, then the shared `finishFrames` (P-6) |
| `joinVideos` | `server/cut.ts:452` | 148 | `partChains()`, `fadeRuns()`, `musicChain()` |
| `wanVideo.build` | `recipes/wan/video.ts:192` | 132 | `wanLoad`, `wanLatent`, `wanPasses`, then `finishFrames` |
| `scan` | `comfy/capabilities.ts:73` | 131 | `slotFiles`, `recipeChoices`, `recipeReadiness` |
| `TimelineExport.export` | `server/timelineExport.ts:17` | 108 | `exportFrame`, `partFor`, `storeExport` |
| `editClip` | `server/timelines.ts:692` | 100 | `validateClipPatch`, `labelOf(patch)`, then one transaction (fixes T-5) |

For the files: `timelines.ts` would drop well under 800 lines by deleting its twenty one-line wrappers (callers use `timelines.range.*` directly) and moving `placedOf`'s join marking into a pure `markJoins` beside `timelineModel.ts`. `db.ts` is mostly migrations: move each migration to `migrations/00NN-name.ts` and keep the table types and `openDb` in `db.ts`.

Server-side functions over about 80 lines not listed above:

- `store` (`queueStore.ts:62`, 144 lines): `collectOutputs`, `fileOne`, `sideFiles` and a `writeRows` transaction.
- `registerModelPages` (`modelPages.ts:34`, 156): page routes and word routes.
- `registerFolders` (`folders.ts:17`, 128): linked folders and plain folders.
- `summary` (`renders.ts:318`, 127): `windowOf`, `bucket`, per-recipe lines.
- `compose` (`entities.ts:127`, 115): words, LoRAs, references and voice, one step each.
- `runCut` (`queueTools.ts:80`, 111): `runFinish`, `runSlowRife`, `runSlowFfmpeg`, along its existing `opts.action` branches.
- `registerLookup` (`lookup-api.ts:18`, 106): `embeddedIn` and the downloads routes out.
- `Updates.run` (`modelUpdates.ts:108`, 100): match, fetch, write.
- `registerMetrics` (`metrics.ts:21`, 100): the tally beside `renders.ts`.
- `Queue.run` (`queue.ts:449`, 83): its catch block as `failed(err, ...)`.

## Suggested order

1. **Before going public (a day or two):**
   - The trust boundary: HIGH 1, 2, 3 and 4, S-1, S-2, S-3.
   - The Postgres migration: HIGH 20 (or say Postgres is not supported yet).
   - The server that does not boot: HIGH 5.
   - The history rewrite: HIGH 21 and 22.
   - The chart: HIGH 23, R-2, R-3 and R-4.
   - The error boundary: HIGH 16.
   - The secure-context fix: HIGH 15.
   - The notices: R-7.
   - The docs that promise too much: R-6.
2. **The timeline and draft bugs (a few days):**
   - HIGH 8 to 14, 17, 18 and 19.
   - M-1 (migrations in a transaction), M-2 (the still-used guard), M-3.
   - T-1, T-2, T-3, T-5, T-6.
   - C-1, C-2, C-8.
   - P-1.
   - Each with a test.
3. **Importer accuracy:**
   - HIGH 6 and 7.
   - W-1, W-2, W-4.
   - W-5, so the corpus guards it.
4. **Performance:**
   - WC-1, WC-3, WC-4.
   - C-3, C-4.
   - T-7, T-8.
   - The indexes migration.
   - `cut.ts` on paths.
5. **The splits**, file by file, each a pure move with the tests kept green:
   - `TimelineEditor`, `WorkflowEditor`, `Inspector`, `Player` first;
   - then `recipeFromWorkflow` and `fromEditor`;
   - then the recipes' shared finishing (P-6).

## What should not be touched

The 2026-10-05 list still holds:

- the graph-checking spine (`checkGraph`, `check:graphs`, the recipe test that insists `nodes()` equals what the graph uses);
- `warmGraph`;
- the `/afflatus/header` route;
- `wiring.ts`;
- the queue's conditional claim and resume by prompt id;
- the snapshot undo and redo (fix `restore`, keep the model);
- the storage containment;
- the SSE-driven invalidation in `live.ts` (narrow it, keep it);
- the player's pre-roll and hand-over;
- the keyboard discipline;
- the portal primitives;
- the theme tokens (adjust the light values).

Added since:

- `hostCheck.ts` (extend it, see HIGH 2);
- `zipStream.ts`;
- `timeline/clock.ts`;
- the corpus and `expect.json` workflow.
