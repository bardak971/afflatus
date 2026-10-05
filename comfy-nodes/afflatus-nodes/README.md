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
| Afflatus: H3 Tail Guide | The clip before's tail as the frame-zero guide: its last decoded frames re-encoded by the VAE for the picture, its exact latent for the sound. Without frames, the exact latent tail guide. |
| Afflatus: H3 Latent Head Guide | Anchors the clip after's first tokens at the end of the window: the clip lands exactly where the clip after begins. |
| MiniMax H3 Guided Continuation Window | Allocates the continuation target: a hidden overlap of the previous latent's tail plus the new frames. |
| MiniMax H3 Latent Tail Guide | Conditions the target on the previous latent's tail, video and audio, with no VAE round trip. |
| MiniMax H3 Append Continuation | Drops the hidden overlap and appends only the new tokens to the previous latent. |

The last three are the MIT-licensed continuation nodes by ttulttul
([ComfyUI-Minimax-H3-Continuation](https://github.com/ttulttul/ComfyUI-Minimax-H3-Continuation)),
vendored unchanged; their licence is in `LICENSE-continuation`.

## Two routes on ComfyUI's server

With the pack loaded, ComfyUI answers `GET /afflatus/header?folder=<models folder>&filename=<file>` with a
`.safetensors` file's header (its metadata, and each tensor's dtype and shape) and `GET /afflatus/version`
with the pack's version. Afflatus uses the first to tell which model a file is for when it runs on another
machine than ComfyUI and cannot read the file from the disk. Read-only: the first bytes of the file, nothing
loaded.

## Install

Afflatus installs the pack itself when it knows ComfyUI's folder (Settings → ComfyUI → "ComfyUI folder
on this computer"): it copies this folder to `custom_nodes/afflatus-nodes/`. ComfyUI loads it at its next
start. By hand: copy this folder into ComfyUI's `custom_nodes/` and restart ComfyUI.

Needs a ComfyUI with the arbitrary-frame MiniMax H3 guides (0.3.x, commit `e01fb4c` or newer). No extra
Python packages: torch and safetensors come with ComfyUI.

## How Afflatus uses it

Every MiniMax H3 render also saves its own sampled window as its latent (Normalize, then Save H3 Latent);
Afflatus keeps the small file beside the video. When a clip on a timeline extends the one before, that
latent is uploaded, the Window prepares a hidden overlap plus the new frames, a tail guide conditions on
the overlap, the sampler runs as usual and the window is decoded: a constant cost whatever the length of
the timeline. A clip put between two others also gets the clip after's latent, anchored at the window's end
by the Head Guide, so it lands exactly where that clip begins. Append Continuation is included for workflows
that want one cumulative latent; Afflatus does not use it.

Which tail guide: by default Afflatus's own (the frames re-encoded, the sound from the latent). Measured on
chains of continuations (2026-10-05, files in ComfyUI's output folder): a window guided by the clip before's
*sampled* latent reproduces that tail almost exactly (correlation 0.999) but 2 to 4 % wider in every latent
channel, with the same small per-channel biases at every hop; nothing re-anchors the chain to real pixels, so
clip after clip the picture gets softer and darker. A guide encoded from the decoded frames has no such
direction and a chain of those stays flat; the sound does not drift, so its exact latent is kept (the voice
carries over as it is). The exact latent guide (ttulttul's) remains available as "Continue from: Latent".
