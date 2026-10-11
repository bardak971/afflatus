# Afflatus nodes for ComfyUI

A small node pack that lets Afflatus continue a MiniMax H3 clip from the clip's own latent, the way the
chained H3 workflows do, instead of pinning re-encoded pixel frames (which restarts the motion and shifts
colour and voice at the join).

## Nodes

| Node | What it does |
|---|---|
| Afflatus: Save H3 Latent | Writes a MiniMax H3 video+audio latent as one safetensors file (both streams, frame count in the metadata). ComfyUI's own SaveLatent cannot store the nested pair. |
| Afflatus: Load H3 Latent | Reads such a file back, from an upload or the input folder. |
| Afflatus: Normalize H3 Latent | Rounds a sampled window's audio to its own frame boundary, so the window is a valid clip to continue from. |
| Afflatus: Trim H3 Latent | Keeps a latent's first frames (a count on the 17k + 5 grid), video and audio: a clip handed over before its end is continued from there. |
| Afflatus: H3 Tail Guide | The clip before's tail as the frame-zero guide: its last decoded frames re-encoded by the VAE for the picture, its exact latent for the sound. Without frames, the exact latent tail guide. Afflatus no longer uses it; kept for graphs that name it. |
| Afflatus: H3 Latent Head Guide | Anchors the clip after's first tokens at the end of the window: the clip lands exactly where the clip after begins. |
| Afflatus: H3 Latent Landing | The same from where any of the clip after's 17-frame chunks begins: a clip lands inside another, on time. |
| Afflatus: H3 Seam Latent | A continuation's new tokens after the clip before's own last ones, to decode the two as one piece: the join then matches the whole chain decoded at once. |
| MiniMax H3 Guided Continuation Window | Allocates the continuation target: a hidden overlap of the previous latent's tail plus the new frames. |
| MiniMax H3 Latent Tail Guide | Conditions the target on the previous latent's tail, video and audio, with no VAE round trip. |
| MiniMax H3 Append Continuation | Drops the hidden overlap and appends only the new tokens to the previous latent. |

The last three are the MIT-licensed continuation nodes of ttulttul's
[ComfyUI-Minimax-H3-Continuation](https://github.com/ttulttul/ComfyUI-Minimax-H3-Continuation), vendored
with one small change (a guarded import: a ComfyUI too old for them says "update ComfyUI" rather than
failing with an ImportError); their licence is in `LICENSE-continuation`.

## Routes on ComfyUI's server

With the pack loaded, ComfyUI answers:

- `GET /afflatus/header?folder=<models folder>&filename=<file>`: a `.safetensors` file's header (its
  metadata, and each tensor's dtype and shape). Afflatus uses it to tell which model a file is for when it
  runs on another machine than ComfyUI and cannot read the file from the disk. Read-only: the first bytes of
  the file, nothing loaded.
- `GET /afflatus/version`: the pack's version, read from `pyproject.toml`. Afflatus compares it with the copy it
  ships and says "restart ComfyUI" while an older one is loaded.
- `POST /afflatus/clean-input` with `{"older_than_hours": 24}`: removes the pictures Afflatus uploaded to
  `input/afflatus/` that are older than that (only files named `afflatus_*`, in that one folder, never younger
  than an hour). The body must be sent as `application/json`.
- `POST /afflatus/download`, `GET` and `DELETE /afflatus/download/<id>` (0.11.0): a model file fetched from
  Afflatus's own one-time download address into the first folder ComfyUI lists for its kind, for a ComfyUI on
  another machine than Afflatus. Written as `<name>.part`, picked up again where it stopped after a cut, renamed
  once complete. Only model-file names, only into model folders (never `custom_nodes`), no redirects followed.

## Install

Afflatus installs the pack itself when it knows ComfyUI's folder (Settings → ComfyUI → "ComfyUI folder
on this computer"): it copies this folder to `custom_nodes/afflatus-nodes/`. ComfyUI loads it at its next
start. By hand: copy this folder into ComfyUI's `custom_nodes/` and restart ComfyUI.

Needs a ComfyUI with the arbitrary-frame MiniMax H3 guides (0.3.x, commit `e01fb4c` or newer). No extra
Python packages: torch and safetensors come with ComfyUI.

## How Afflatus uses it

Every MiniMax H3 render also saves its own sampled window as its latent (Normalize, then Save H3 Latent);
the file goes to ComfyUI's temp folder (cleared when ComfyUI starts) and Afflatus keeps its own copy beside
the video. When a clip on a timeline extends the one before, that
latent is uploaded (cut with Trim when the clip before is handed over early), the Window prepares a hidden
overlap plus the new frames, the Latent Tail Guide conditions on the overlap, the sampler runs as usual, and
Seam Latent puts the clip before's last tokens in front of the new ones so that the two decode as one piece:
the join plays as a plain cut. A constant cost whatever the length of the timeline. A clip put between two
others also gets the clip after's latent, anchored at the window's end by the Head Guide, or by Landing when
it lands further into that clip. Append Continuation is included for workflows that want one cumulative
latent; Afflatus does not use it.

Which guide, the form's "Continue from": **Auto** is the exact latent (ttulttul's Latent Tail Guide), decoded
as one piece with the clip before; **Frames** pins the clip before's last frames and sound, re-encoded, as
ComfyUI alone does it. Measured on chains of continuations: a chain guided by re-encoded frames loses fine
detail at every clip (it copies a softened picture), while the exact latent keeps it. The hybrid guide
(Afflatus's H3 Tail Guide: frames for the picture, latent for the sound) was Auto for a while and is no longer
offered.
