#!/bin/sh
# The Afflatus pod's start (Dockerfile beside this): ComfyUI on 8188 with its Manager, the Afflatus node pack in it.
#
# With a volume (/workspace, a network volume or the pod's own), ComfyUI's files live there: the models, the node packs
# the Manager installed, the user folder. A next pod on the same network volume finds them and starts in a minute,
# without fetching them again. Without one, they are on the container's disk and go with the pod.
#
# Every step is written to the boot log (bootlog.py), stamped, and ComfyUI's own output after them: Afflatus reads it on
# BOOT_PORT (8189) with the pod's token while ComfyUI is not up yet, and says on the pod's card where the start is.
set -e

# the start's output through the stamper into the log, and on to the container's own output as before (RunPod's log). A
# fifo: sh has no other way to send its own output through a pipe, ComfyUI's after it
LOG=/tmp/afflatus-boot.log
FIFO=/tmp/afflatus-boot.fifo
[ -p "$FIFO" ] || { rm -f "$FIFO"; mkfifo "$FIFO"; }
python -u /opt/afflatus-pod/bootlog.py stamp "$LOG" < "$FIFO" &
exec > "$FIFO" 2>&1
# the log served for the pod's whole life, to its token only (AFFLATUS_TOKEN); never the environment, never the token
python -u /opt/afflatus-pod/bootlog.py serve "$LOG" &

# --- the failure path (deploy/runpod/tests/test_start.py runs this part on its own)
# A step said: Afflatus shows the last one. A start that stops on an error says at which step, and does not exit: a
# container that exits is started again by RunPod, fails at the same step (a full volume stays full) and bills on, with
# no watchdog, since the node pack's runs only in ComfyUI. So broken.py takes over, as when the GPU fails: it arms the
# watchdog from the pod's environment (the pod stops by itself when Afflatus is away) and answers on ComfyUI's port; the
# boot log, still served, says the step, and Afflatus terminates the pod at once when it reads it. Should broken.py itself
# not run, the start waits as before, so that its log can still be read
POD=/opt/afflatus-pod
STEP="the start"
step() {
  STEP="$*"
  echo "[afflatus-pod] step: $*"
}
failed() {
  [ "$1" != 0 ] || return 0
  echo "[afflatus-pod] failed: $STEP (exit $1)"
  python -u "$POD/broken.py" --start "$STEP" "$1" || echo "[afflatus-pod] broken.py did not run: no watchdog"
  sleep 1200
}
trap 'failed $?' EXIT
# --- end of the failure path

step "checking the GPU"

if [ -d /workspace ] && touch /workspace/.afflatus-check 2>/dev/null; then
  rm -f /workspace/.afflatus-check
  BASE=/workspace/comfyui
else
  BASE=/comfyui
fi
# the GPU first: on a host whose driver or GPU is in a bad state ("CUDA unknown error") ComfyUI would crash at every start,
# billed for nothing. Said on ComfyUI's port instead (broken.py), and Afflatus terminates the pod at once
if ! python -c "import torch; torch.cuda.init(); torch.zeros(1, device='cuda')" 2>/tmp/afflatus-gpu.txt; then
  cat /tmp/afflatus-gpu.txt
  trap - EXIT
  exec python "$POD/broken.py" /tmp/afflatus-gpu.txt
fi

step "preparing ComfyUI's folders"
mkdir -p "$BASE/custom_nodes" "$BASE/models" "$BASE/user" "$BASE/input" "$BASE/output"
# ComfyUI's model folders, as its own checkout has them: a fresh volume holds none, and nothing could be put in one
for dir in /comfyui/models/*/; do
  mkdir -p "$BASE/models/$(basename "$dir")"
done
echo "[afflatus-pod] ComfyUI's files in $BASE"

# InsightFace's face models for the node pack's Face Match, fetched from InsightFace's own release while ComfyUI starts
# (the image does not carry them: their licence is for non-commercial research). In the background, so the start is not
# held up; once in the models folder a volume keeps them, and a render that needs them first fetches them itself
# Its own output (download bars) in a file of its own; the boot log says when it ends, and its last line when it fails.
# Whole or not at all (face_models.py): fetched beside the models folder and moved in when complete, and a folder a pod
# ended mid-extraction left is not taken for them, so the check is for the two files Face Match loads, not the folder
if [ ! -s "$BASE/models/insightface/models/buffalo_l/det_10g.onnx" ] || [ ! -s "$BASE/models/insightface/models/buffalo_l/w600k_r50.onnx" ]; then
  echo "[afflatus-pod] fetching InsightFace's face models, in the background"
  (if python /opt/afflatus-nodes/face_models.py "$BASE/models/insightface" > /tmp/afflatus-insightface.log 2>&1; then
    echo "[afflatus-pod] InsightFace's face models fetched"
  else
    echo "[afflatus-pod] InsightFace's face models not fetched: $(tail -n 1 /tmp/afflatus-insightface.log)"
  fi &)
fi

# the node pack as this image has it, over the one an older pod left on the volume: the lock and the watchdog are the
# image's, never an older copy's
step "putting in the node packs"
rm -rf "$BASE/custom_nodes/afflatus-nodes"
cp -r /opt/afflatus-nodes "$BASE/custom_nodes/afflatus-nodes"

# the node packs built into the image (Dockerfile), at its commits: linked in, over a copy an older pod left on the volume
while read -r pack; do
  [ -n "$pack" ] || continue
  rm -rf "${BASE:?}/custom_nodes/$pack"
  ln -s "/opt/packs/$pack" "$BASE/custom_nodes/$pack"
done < /opt/packs/BUILT_IN

# node packs an earlier pod installed on the volume: their Python packages are not in this container yet. Torch stays the
# image's CUDA build (/constraints.txt): a pack asking for another would swap it for a PyPI one, GBs at every start
# with a volume, pip's cache kept there: a next pod does not download them all again. Each list bounded in time: the pod
# is billed while it installs, and its watchdog is not running yet
if [ "$BASE" != /comfyui ]; then
  unset PIP_NO_CACHE_DIR
  export PIP_CACHE_DIR="$BASE/.pip-cache"
fi
# the lists to install, counted first: each step says which of how many it is ("(3/14)"), what Afflatus shows while it
# boots. POSIX sh (no arrays): the same test in both rounds
wanted() {
  [ -f "$1" ] || return 1
  [ "$1" = "$BASE/custom_nodes/afflatus-nodes/requirements.txt" ] && return 1
  # the built-in ones' packages are in the image already (DaSiWa's list on purpose not)
  ! grep -qxF "$(basename "$(dirname "$1")")" /opt/packs/BUILT_IN
}
n=0
for req in "$BASE"/custom_nodes/*/requirements.txt; do
  if wanted "$req"; then n=$((n + 1)); fi
done
i=0
for req in "$BASE"/custom_nodes/*/requirements.txt; do
  wanted "$req" || continue
  i=$((i + 1))
  step "installing the Python packages of $(basename "$(dirname "$req")") ($i/$n)"
  timeout 600 pip install -q -c /constraints.txt -r "$req" || echo "[afflatus-pod] could not install $req"
done

# ComfyUI-Manager installs the node packs a job needs only where it trusts who asks: on a ComfyUI listening on every
# address (a pod), only in its "personal cloud" mode (a machine one person uses: this one is locked to Afflatus's token)
# at its normal security level. Those two keys set, its other settings kept
step "setting up ComfyUI-Manager"
python - "$BASE/user/__manager/config.ini" <<'PY'
import configparser, os, sys
path = sys.argv[1]
os.makedirs(os.path.dirname(path), exist_ok=True)
c = configparser.ConfigParser(strict=False)
c.read(path)
if "default" not in c:
    c["default"] = {}
c["default"]["network_mode"] = "personal_cloud"
c["default"]["security_level"] = "normal"
with open(path, "w") as f:
    c.write(f)
PY

# the registry's list kept in the image, where Manager has none yet: it resolves a pack's name from its first second.
# Its date kept (cp -p): Manager finds it old and reads the registry again in the background, using this one meanwhile
mkdir -p "$BASE/user/__manager/cache"
for f in /opt/afflatus-pod/manager-cache/*.json; do
  if [ -f "$f" ] && [ ! -f "$BASE/user/__manager/cache/$(basename "$f")" ]; then
    cp -p "$f" "$BASE/user/__manager/cache/" || echo "[afflatus-pod] could not copy the registry list"
  fi
done

# COMFYUI_ARGS: more of ComfyUI's flags, from the pod's environment (--fast, --reserve-vram 1, …). Its output goes on into
# the boot log: its custom nodes' loading shows there, and why it stopped when it does
step "starting ComfyUI"
trap - EXIT
# --- the run (deploy/runpod/tests/test_start.py runs this part on its own)
# ComfyUI as this script's child, not in its place: were it the container's main process, its death (the out-of-memory
# killer, a crash in a library) would end the container, RunPod would start a fresh one that knows nothing of the render
# ("history 404"), and its log would be gone. So the script waits for it, and passes RunPod's stop on to it. When it ends
# without being asked to, died.py writes why (its signal, the out-of-memory killer's count, the memory's peak) and
# broken.py serves that as "comfy_died": Afflatus fails the render, says why and terminates the pod. Never started again
# here: a render that killed ComfyUI once would likely kill it again, billed
COMFY_STATE=/tmp/afflatus-comfy.json
DIED=/tmp/afflatus-died.json
# RunPod's stop (TERM) heard from here on, before ComfyUI is even started: PID 1 has no default end on TERM, so a stop
# that came before the trap would wait out its grace period and end in SIGKILL. Before ComfyUI runs, it only says stop;
# once it runs, it is passed on to it
COMFY=
STOPPING=
WOKEN=
stop() {
  STOPPING=1
  WOKEN=1
  [ -z "$COMFY" ] || kill -TERM "$COMFY" 2>/dev/null || true
}
trap stop TERM INT
python -u "$POD/died.py" start "$COMFY_STATE" || echo "[afflatus-pod] died.py did not run: a crash will say less"
[ -z "$STOPPING" ] || exit 0
# --disable-pinned-memory: ComfyUI keeps the models' weights in pinned RAM to feed the GPU (31 GB of an A40 pod's 46.6),
# which the kernel cannot take back; the frames of a long decode on top went past the container's limit and it was
# killed. Measured on an A40 (2026-10-18, a masked swap of 226 frames): killed at 46.6 GB without it; with it, three
# renders back to back peaked at 15-20 GB, at the same 92 s a step. COMFYUI_ARGS adds the pod's own flags after it (pinned
# memory cannot be turned on again there: ComfyUI has no flag for that)
# ComfyUI-Manager's restart (after it installs a node pack) exits instead of restarting in place when this is set (comfy-cli
# sets it): this script would take that for a death, and the pod would be terminated. Never set for ComfyUI here
unset __COMFY_CLI_SESSION__
# shellcheck disable=SC2086
python /comfyui/main.py --listen 0.0.0.0 --port 8188 --enable-manager --disable-auto-launch --disable-pinned-memory --base-directory "$BASE" ${COMFYUI_ARGS:-} &
COMFY=$!
echo "$COMFY" > /tmp/afflatus-comfy.pid
# a stop that came while it was being started: passed on now that there is a ComfyUI to stop
[ -z "$STOPPING" ] || kill -TERM "$COMFY" 2>/dev/null || true
# a trap ends `wait` early with ComfyUI still running: wait again, until what `wait` returns is ComfyUI's own end
set +e
while :; do
  WOKEN=
  wait "$COMFY"
  code=$?
  [ -n "$WOKEN" ] || break
done
# no `set -e` from here on: a write to the boot log that fails (its stamper gone, killed with ComfyUI by the out-of-memory
# killer) must not end this script, which RunPod would start again: what this run is here to prevent
if [ -n "$STOPPING" ]; then
  exit 0
fi
echo "[afflatus-pod] ComfyUI ended (status $code)"
python -u "$POD/died.py" end "$code" "$COMFY_STATE" "$DIED" || echo "[afflatus-pod] died.py could not write its report"
# broken.py serves until the pod ends, as a child (and the wait after it too): RunPod's stop then ends the script at once,
# instead of being lost on PID 1 until its SIGKILL
WAITING=
trap 'kill $WAITING 2>/dev/null; exit 0' TERM INT
python -u "$POD/broken.py" --died "$DIED" &
WAITING=$!
wait "$WAITING" || echo "[afflatus-pod] broken.py did not run: no watchdog"
sleep 1200 &
WAITING=$!
wait "$WAITING"
# --- end of the run
