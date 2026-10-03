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

## 3. Slice C — Regenerate this part

- From Trim mode on a clip: **Regenerate this part** = Generate between the range's edges with `seconds` =
  the range, then **splice back**: a job that waits for the render (`depends_on`) and makes before + new + after
  through `joinVideos`, as a new video with the original as source (the original stays). On a timeline clip,
  the result becomes a new take of that clip.
- Needs: a job that follows another (the queue has `depends_on`), and `joinVideos` with three parts of two videos
  (it has that).

## 4. Slice D — Bridge

- Timeline: a **Bridge** button in the gap between two clips (and in the right-click menu of a clip: "Bridge to
  next"). Makes a clip between them: on H3, `previous` = clip A (its end) and `next` = clip B (its start), what
  the timeline already supports by hand; on Wan / LTX, `start` = A's last frame and `end` = B's first frame
  (two saved frames). Duration pre-set (2 s, editable). The bridge is a clip of the timeline like any other.

## 5. Slice E — Loop

- Trim mode: **Loop the range** = Generate between with `start` = frame at out and `end` = frame at in, the
  result joined after the range (range + bridge back) as a new video. Duration of the bridge editable (1–3 s).

## 6. Slice F — Slow motion

- Trim mode: **Slow motion ×2 / ×4** on the range: a job running RIFE on the range's frames (the
  `FrameInterpolationModelLoader` / RIFE nodes are already used for frame interpolation; this one is a ComfyUI
  job on the GPU, so it goes through the queue like a render), then played at the original fps. Or, without the
  GPU, ffmpeg `minterpolate` (what the timeline's smooth export uses) as the fallback.

## 7. Later — scene detection

- On a long import: `ffmpeg -vf select='gt(scene,0.3)',showinfo` gives cut points; shown as markers on the
  trim bar; "Extract every scene" makes one copy job per scene.

## Order and size

A (2 sessions of work: server cut job + Trim UI + the two generate actions) → B (1: the menu component and two
places) → C (1) → D (1) → E (small) → F (1) → scene detection when wanted.

## Open points for the owner

1. Trim mode in Studio's inline viewer too (planned yes), or the big viewer only.
2. Re-encode quality for cut copies: `crf 10` like the joins (big files, no visible loss) or `crf 16`.
3. Split / Remove send the original to the bin (undoable for a day) — or keep it in place?
