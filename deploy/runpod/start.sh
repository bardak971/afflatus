#!/bin/sh
# The Afflatus pod's start (Dockerfile beside this): ComfyUI on 8188 with its Manager, the Afflatus node pack in it.
#
# With a volume (/workspace, a network volume or the pod's own), ComfyUI's files live there: the models, the node packs
# the Manager installed, the user folder. A next pod on the same network volume finds them and starts in a minute,
# without fetching them again. Without one, they are on the container's disk and go with the pod.
set -e

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
  exec python /opt/afflatus-pod/broken.py /tmp/afflatus-gpu.txt
fi

mkdir -p "$BASE/custom_nodes" "$BASE/models" "$BASE/user" "$BASE/input" "$BASE/output"
echo "[afflatus-pod] ComfyUI's files in $BASE"

# the node pack as this image has it, over the one an older pod left on the volume: the lock and the watchdog are the
# image's, never an older copy's
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
for req in "$BASE"/custom_nodes/*/requirements.txt; do
  [ -f "$req" ] || continue
  [ "$req" = "$BASE/custom_nodes/afflatus-nodes/requirements.txt" ] && continue
  # the built-in ones' packages are in the image already (DaSiWa's list on purpose not)
  grep -qxF "$(basename "$(dirname "$req")")" /opt/packs/BUILT_IN && continue
  pip install -q -c /constraints.txt -r "$req" || echo "[afflatus-pod] could not install $req"
done

# ComfyUI-Manager installs the node packs a job needs only where it trusts who asks: on a ComfyUI listening on every
# address (a pod), only in its "personal cloud" mode (a machine one person uses: this one is locked to Afflatus's token)
# at its normal security level. Those two keys set, its other settings kept
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

# COMFYUI_ARGS: more of ComfyUI's flags, from the pod's environment (--fast, --reserve-vram 1, …)
# shellcheck disable=SC2086
exec python /comfyui/main.py --listen 0.0.0.0 --port 8188 --enable-manager --disable-auto-launch --base-directory "$BASE" ${COMFYUI_ARGS:-}
