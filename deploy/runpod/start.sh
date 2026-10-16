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
# fifo: sh has no other way to send its own output through a pipe and still exec ComfyUI at the end
LOG=/tmp/afflatus-boot.log
FIFO=/tmp/afflatus-boot.fifo
[ -p "$FIFO" ] || { rm -f "$FIFO"; mkfifo "$FIFO"; }
python -u /opt/afflatus-pod/bootlog.py stamp "$LOG" < "$FIFO" &
exec > "$FIFO" 2>&1
# the log served for the pod's whole life, to its token only (AFFLATUS_TOKEN); never the environment, never the token
python -u /opt/afflatus-pod/bootlog.py serve "$LOG" &

# A step said: Afflatus shows the last one. A start that stops on an error says at which step, and stays up a while so that
# its log can still be read (a container that exits is started again by RunPod, its log with it); Afflatus terminates a
# pod whose ComfyUI never answers at its boot limit, as before
STEP="the start"
step() {
  STEP="$*"
  echo "[afflatus-pod] step: $*"
}
trap 'code=$?; if [ "$code" != 0 ]; then echo "[afflatus-pod] failed: $STEP (exit $code)"; sleep 1200; fi' EXIT

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
  exec python /opt/afflatus-pod/broken.py /tmp/afflatus-gpu.txt
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
# Its own output (download bars) in a file of its own; the boot log says when it ends, and its last line when it fails
if [ ! -d "$BASE/models/insightface/models/buffalo_l" ]; then
  echo "[afflatus-pod] fetching InsightFace's face models, in the background"
  (if python -c "from insightface.app import FaceAnalysis; FaceAnalysis(name='buffalo_l', root='$BASE/models/insightface', allowed_modules=['detection', 'recognition'], providers=['CPUExecutionProvider']).prepare(ctx_id=-1)" > /tmp/afflatus-insightface.log 2>&1; then
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
# shellcheck disable=SC2086
exec python /comfyui/main.py --listen 0.0.0.0 --port 8188 --enable-manager --disable-auto-launch --base-directory "$BASE" ${COMFYUI_ARGS:-}
