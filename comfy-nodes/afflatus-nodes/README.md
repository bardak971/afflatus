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
| Afflatus: H3 Tail Guide | The clip before's tail as the frame-zero guide: its last decoded frames re-encoded by the VAE for the picture, its exact latent for the sound. Without frames, the exact latent tail guide. Deprecated: Afflatus no longer uses it; kept for graphs that name it. |
| Afflatus: H3 Latent Head Guide | Anchors the clip after's first tokens at the end of the window: the clip lands exactly where the clip after begins. |
| Afflatus: H3 Latent Landing | The same from where any of the clip after's 17-frame chunks begins: a clip lands inside another, on time. |
| Afflatus: H3 Seam Latent | A continuation's new tokens after the clip before's own last ones, to decode the two as one piece: the join then matches the whole chain decoded at once. |
| Afflatus: Face Match | How alike the faces of pictures or a clip's frames are to a person's pictures (InsightFace buffalo_l, on the CPU). Registered only when `insightface` is installed in ComfyUI's Python. |
| Afflatus: Face Crop | A person's picture cut to a square around its largest face, 2.5 face heights a side, kept inside the picture (LTX 2.5's reference pictures); without a face found, the picture as it is. Registered only when `insightface` is installed. |
| Afflatus: Face At | The same for the person at a place in a frame (the one put in where someone stood), and how many copies of them it finds. Also needs `insightface`. |
| Afflatus: Swap Mask (H3) | The person a swap replaces, from a SAM 3.1 video track (the one the window before replaced, a click, else the largest face): an H3 noise mask on the latent grid and a paste-back mask, so the swap redraws only them. |
| Afflatus: Swap Mask Preview (H3) | Swap Mask's two masks drawn over the source frames: the cells H3 redraws in the accent colour, the paste-back band lighter. |
| Afflatus: Swap Paste by Difference (H3) | The swap's render kept over the source where it clearly differs from it inside the redrawn zone, and over the person; elsewhere the source's own pixels. |
| Afflatus: H3 Audio Lock | Encodes a sound into an H3 latent's audio stream and masks it from the noise: the sampler redraws the video only, with that sound beside it (Face refine). |
| Afflatus: Follow Colours | Brings each frame's colours to a reference video's at the same moment (Lab mean and spread), both averaged over a stretch of frames first, never across a cut: a slow drift is followed, no flicker is added. |
| Afflatus: Swap Colour Match (H3) | Passes the swap's render through unchanged. Deprecated (0.31.0): its colour match washed the redrawn wall white and was taken out of Swap character; kept for graphs that name it. |
| MiniMax H3 Guided Continuation Window | Allocates the continuation target: a hidden overlap of the previous latent's tail plus the new frames. |
| MiniMax H3 Latent Tail Guide | Conditions the target on the previous latent's tail, video and audio, with no VAE round trip. |
| MiniMax H3 Append Continuation | Drops the hidden overlap and appends only the new tokens to the previous latent. Deprecated (0.11.2): Afflatus joins with Seam Latent instead; kept for graphs that name it. |

The last three are the MIT-licensed continuation nodes of ttulttul's
[ComfyUI-Minimax-H3-Continuation](https://github.com/ttulttul/ComfyUI-Minimax-H3-Continuation), vendored
with two small changes (a guarded import: a ComfyUI too old for them says "update ComfyUI" rather than
failing with an ImportError; Append Continuation marked deprecated); their licence is in `LICENSE-continuation`.

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
  another machine than Afflatus. Written as a `.part` beside it, picked up again where it stopped after a cut, renamed
  once complete. Only model-file names, only into model folders (never `custom_nodes`), no redirects followed. From
  0.11.1: a file of unknown size is refused and never written past its size, two at a time at most, and the
  `.part` files a stopped ComfyUI left are removed at its next start. From 0.12.0: also Hugging Face's and Civitai's own
  signed download links (https, on their download hosts only), which Afflatus asks for with its key and hands over
  without it; `POST /afflatus/download/<id>/url` gives a download whose link expired a fresh one, and it carries on.
- `POST /afflatus/upload`, `PUT`, `GET` and `DELETE /afflatus/upload/<id>` (0.14.0): a model file Afflatus sends itself,
  for one no site has (a LoRA of your own), to a ComfyUI that cannot reach Afflatus (a rented pod). The size is said
  first (a folder without the room is refused then), each piece is `PUT` as raw bytes at the byte the upload is at
  (`?offset=`, 64 MB at most), a piece cut short is sent again, and the file is renamed once complete. The same folders
  and names as the downloads; nothing written past its size; an upload nothing is sent to for 10 minutes is dropped.
- `GET` and `POST /afflatus/alive` (0.13.0): the watchdog of a rented machine. Afflatus says "still here" with
  `{"minutes": 15}` every minute or so; silent that long, the pod stops itself (on RunPod: `runpodctl stop pod`, or
  RunPod's API with the pod's `RUNPOD_API_KEY`). Nothing is armed until Afflatus says it; `{"minutes": 0}` disarms it.
  With `AFFLATUS_WATCHDOG_ACTION=terminate` in the pod's environment (0.13.1: Afflatus sets it for a pod without a
  volume, which keeps nothing when stopped), it terminates the pod instead. A stop that fails or leaves the pod running is
  asked again; after 3 tries it terminates the pod instead (0.20.0), and `GET` says how many it made (`tries`) and what it
  asks now (`end`).
- `GET` and `POST /afflatus/lock`, `POST /afflatus/unlock`, `POST /afflatus/login-code`, `/afflatus/login` (0.12.0):
  the lock. Once Afflatus locks a ComfyUI (Settings → ComfyUI → Access), every route of its server needs the machine's
  token: `Authorization: Bearer <token>` (Afflatus sends it so on the websocket too), `?token=` on the websocket for other tools, or the cookie the login page sets. The lock is kept
  as the token's hash in `afflatus-lock.json` in ComfyUI's user folder; nothing is locked until Afflatus locks it.
  `AFFLATUS_TOKEN=<token>` locks it from its start. **To take the lock off by hand,** delete `afflatus-lock.json`, or
  start ComfyUI with `AFFLATUS_LOCK=off`. A ComfyUI locked so whose lock cannot be put in front of its server (an
  aiohttp or ComfyUI change) stops at its start rather than run open, and says the same two ways out (0.20.0).

- `GET /afflatus/power` (0.18.0): the GPU's power draw in watts (NVML through `nvidia-ml-py`, else `nvidia-smi`), for this PC's electricity; null where neither reads it.
- `GET /afflatus/disk` and `POST /afflatus/models/remove` (0.19.0): the disk the model folders are on (bytes free and in all), and a model file taken off it to make room on a rented pod.
- `GET /afflatus/models/list` (0.21.0): every model file of the models folder with its size and date, each once; on a pod with a network volume, what the volume holds (Afflatus's volume Files).

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
