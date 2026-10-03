# A range on a video — the plan

Settled with the owner on 2026-10-03. One idea under several features: pick an **in** and an **out** on any
video of the library, then do something with the range. Everything below sits on the same handles.

## 0. What is there already

- Viewer on a video: a plain `<video controls>`, **Save frame** (`POST /api/assets/:id/frame`, `frameAt` with
  ffmpeg, a new image asset with its source), **Extract audio**, **Extend** (a new draft: H3 joins the clip's
  last frames through the `clip` input; Wan / LTX open on the last frame as an image).
- Timeline: takes play `startMs → endMs` (non-destructive trim), exports through `joinVideos` (ffmpeg, a queue
  job without GPU), `/api/assets/:id/strip` gives a filmstrip JPEG of a video.
- Server cutting: `cutFrames` (frame-exact, re-encode, `libx264 crf 10`), `frameAt`, `soundPart`, `joinVideos`.
- Recipes: H3, Wan and LTX take a first frame and a last frame (`role: "start"` / `"end"`); H3 also takes a
  `clip` with a `moment` (`ClipValue.at`) as previous or next clip.

## 1. Slice A — Trim mode (the base)

**Server**

- `POST /api/assets/:id/range` `{ startMs, endMs, action }`, `action` ∈ `copy` | `split` | `remove`. Queued as a
  job of kind `cut` (like the export job: ffmpeg, no GPU, shows in the queue with a label such as
  `beach.mp4 · 0:04–0:09 → library`). Done by a new `apps/server/src/cut.ts` helper `rangeOf(source, ext,
  startMs, endMs, opts)`:
  - **copy** → one new video asset: when `start` and `end` fall on keyframes (`ffprobe -skip_frame nokey`), a
    stream copy (`-ss -to -c copy`) for speed and no loss; otherwise a re-encode with the same settings as
    `cutFrames`. Sound kept. The asset carries `source_id` = the video and a `range` in its generation-less
    provenance (a new `assets.source_range` column, `"startMs-endMs"`, migration 0022) so the viewer's *Source*
    strip can say "0:04–0:09 of beach.mp4".
  - **split** → three assets (before, range, after; a part shorter than one frame is skipped), the original to the bin.
  - **remove** → one asset = before + after (through `joinVideos` with two parts of the same video), the original
    to the bin.
  - A range that is the whole video is refused ("nothing to cut").
- `GET /api/assets/:id/strip?frames=N&width=W` — the existing strip, with a frame count and a width, so the trim
  bar can ask for a denser strip for long videos (today it is fixed for the timeline's clip width).
- Tests in `apps/server/test/video.test.ts` with ffmpeg-made test clips (the suite already makes some):
  copy on keyframes vs re-encode, split counts, remove joins, lineage recorded, whole range refused.

**Web**

- `apps/web/src/Trim.tsx`: the Trim mode of the viewer (both the big one and Studio's inline one share it).
  Under the video: the filmstrip, a scrubber with the playhead and two handles; readouts `in 0:04.20 ·
  out 0:09.05 · 4.85 s · 116 frames`; keys **I** / **O** set in/out at the playhead, **,** / **.** step one frame
  (needs the fps: `asset.fps`), **L** loops the range, **Shift+,** / **Shift+.** step ten frames, **Home/End**.
  `requestVideoFrameCallback` for a frame-exact playhead. The native `controls` go off in Trim mode (our own
  play/pause and the scrubber take over).
- The action row of the range: **Copy to library** · **Split** · **Remove** · **Save frame at in** · **Save frame
  at out** · **Generate between** · **Extend from here** (the last two below). Each with its key shown.
- Keys list: a "Viewer (video, Trim)" card.
- `Viewer.tsx`: a **Trim** button (key **T**) toggles the mode; the mode remembers nothing across videos.

**Generate between / Extend from here** (same slice, no server work)

- *Generate between*: save two frames (in and out: two `POST /frame` calls), then open the video model used
  last (`usedLast`, as "Image to video" does) with `start` = frame at in, `end` = frame at out, `seconds` =
  out − in snapped to the model's step. One new draft.
- *Extend from here*: the playhead's moment. On a model with a `clip` input (H3): `clip = { asset, at:
  playheadMs }` as previous clip (true continuity: the join frames are cut at that moment, motion carried).
  On the others: `start` = frame at the playhead. The existing `carryOn` path in `Viewer.tsx` gets a `moment`.

**Demo first**: the Trim mode is walked in the demo (the pretend clips have sound and known fps) before the
live app gets it; the cut job runs against real ffmpeg either way.

## 2. Slice B — right-click menus

- `apps/web/src/ContextMenu.tsx`: one component, `items: Array<{ label, key?, icon?, danger?, disabled?, run }
  | "—">`, opened on `contextmenu`, placed inside the window, closes on Escape / click / scroll, keyboard
  navigable, the key of each item shown as in the Keys list. Never the only way to an action: every item
  mirrors a button that exists.
- First: the **timeline clip** (Trim, Regenerate this part, Bridge to next, New take, Extend, Save frame, Mute,
  Remove) and the **library tile** (Open, Keep, Move to…, Variation, Reuse parameters, Image to video, Open in
  ComfyUI, Bin). Then queue cards, Prompt kit rows, the viewer's video.

## 3. Slices C, D, E — the range on the timeline (built 2026-10-04, replacing Trim on the timeline)

The owner's question after a day with Trim on the timeline: "do we really need the Trim menu? imagine I want to
regen a range between 2 clips". Trim works on one take, so it cannot. The timeline got what every NLE has
instead: **In and Out on the ruler**, with the actions on the range. Trim stays in the viewer, for raw footage.

- **Setting the range**, no mode: **I** and **O** at the playhead (one alone reaches to the end, or from the
  start); **Shift-drag on the ruler** sweeps one; two brackets `[` `]` on the ruler drag In and Out, snapping
  to cuts and to the playhead; a clip's menu has **Set range to this clip**; **Esc** or the × clears it. The
  band is drawn over the ruler and the tracks. `←` `→` (Shift: ten) and `,` `.` step one frame of the clip
  under the playhead, so the range is frame-accurate at any zoom. In = Out on a cut is allowed: "this cut".
- **The range bar** under the video (and the right-click on the band, the same list, `rangeItems` in
  `TimelineEditor.tsx`): **Play** (Space with the playhead outside the range plays it too; it stops at Out),
  **Loop** (L), **Regenerate**, **Split at In / Out**, **Remove**, **Copy to library**, ×.
- **Regenerate** (`POST /api/timelines/:id/range` action `regenerate`, `Timelines.regenerateRange`): what plays
  between In and Out goes, and a new clip is inserted in its place, pinned to the frame just before In and the
  frame at Out (`Timelines.frame`, made once per moment; a still is its own picture), on the clip's model when
  it takes those frames, else the first that does, with that clip's words and settings and `seconds` = the
  range snapped to the model's steps; the clip after it becomes a cut. **Nothing is rendered**: the new clip
  comes back selected, its form (and the Designer) is the owner's first, then New take renders it. It is a
  clip like any other, so it can be re-rendered again and again. In = Out on a cut = **Bridge** (slice D): a
  clip between the two, pinned to their frames, nothing removed. One Undo step.
- **Split at In / Out** (`splitRange`): the clips under In and Out each become two (a still into two stills);
  both on cuts already is refused. **Remove** (`removeRange` → `cutOut`): the clips inside go, the clip at In
  stops there, the clip at Out starts there (and becomes a cut); a range inside one clip splits it at Out first
  so the rest stays a clip; less than a tenth of a second left of a clip = the clip goes too. **Copy to
  library** (`export` with a `range` window, through the export queue): one video of that part, named
  "Timeline · 0:02–0:04", without the music. All tested in `timelines.test.ts`.
- Gone with it: the splice cut job, `POST /api/clips/:id/regenerate`, `spliceTake`, Trim's T key on the
  timeline. Kept: `splitClip` ("Split clip at playhead" in the clip menu, no range needed), the viewer's Trim.
- The clip menu also gained **Extend from this frame** and **Save frame** (at the playhead, on when it stands
  on that clip).
- **Loop** (slice E) is not built: with the range it would be "Regenerate with In and Out swapped"; wanted
  only when asked for.

## 5. Slice F — Slow motion (the owner, 2026-10-04: "if the GPU is faster and better quality, yes" → RIFE on the GPU first, ffmpeg minterpolate only as the fallback)

- Trim mode: **Slow motion ×2 / ×4** on the range: a job running RIFE on the range's frames (the
  `FrameInterpolationModelLoader` / RIFE nodes are already used for frame interpolation; this one is a ComfyUI
  job on the GPU, so it goes through the queue like a render), then played at the original fps. Or, without the
  GPU, ffmpeg `minterpolate` (what the timeline's smooth export uses) as the fallback.

## 4. Later — scene detection

- On a long import: `ffmpeg -vf select='gt(scene,0.3)',showinfo` gives cut points; shown as markers on the
  trim bar; "Extract every scene" makes one copy job per scene.

## Order and size

A (done) → B (done) → C + D as the range on the timeline (done) → F (1 session) → scene detection when wanted.

## Open points for the owner

1. Trim mode in Studio's inline viewer too (planned yes), or the big viewer only.
2. Re-encode quality for cut copies: `crf 10` like the joins (big files, no visible loss) or `crf 16`.
3. Split / Remove send the original to the bin (undoable for a day) — or keep it in place?
