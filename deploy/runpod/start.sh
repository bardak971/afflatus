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
mkdir -p "$BASE/custom_nodes" "$BASE/models" "$BASE/user" "$BASE/input" "$BASE/output"
echo "[afflatus-pod] ComfyUI's files in $BASE"

# the node pack as this image has it, over the one an older pod left on the volume: the lock and the watchdog are the
# image's, never an older copy's
rm -rf "$BASE/custom_nodes/afflatus-nodes"
cp -r /opt/afflatus-nodes "$BASE/custom_nodes/afflatus-nodes"

# node packs an earlier pod installed on the volume: their Python packages are not in this container yet. Torch stays the
# image's CUDA build (/constraints.txt): a pack asking for another would swap it for a PyPI one, GBs at every start
for req in "$BASE"/custom_nodes/*/requirements.txt; do
  [ -f "$req" ] || continue
  [ "$req" = "$BASE/custom_nodes/afflatus-nodes/requirements.txt" ] && continue
  pip install -q -c /constraints.txt -r "$req" || echo "[afflatus-pod] could not install $req"
done

# COMFYUI_ARGS: more of ComfyUI's flags, from the pod's environment (--fast, --reserve-vram 1, …)
# shellcheck disable=SC2086
exec python /comfyui/main.py --listen 0.0.0.0 --port 8188 --enable-manager --disable-auto-launch --base-directory "$BASE" ${COMFYUI_ARGS:-}
