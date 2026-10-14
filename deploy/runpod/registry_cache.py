"""ComfyUI's registry of node packs, fetched when the image is built, as ComfyUI-Manager keeps it (its cache file).

On a pod just up, Manager has no list of packs yet: it reads the whole registry page by page in the background (a few
minutes, longer on a slow host), and until then it cannot install a pack by its name (the real test: "Cannot resolve
install target" for five minutes). With this file in its cache folder (start.sh puts it there when the pod has none),
Manager knows every pack from its first second, and still reads the registry again in the background as it always does.

Written as Manager's own code writes it (comfyui_manager common/cnr_utils.py and manager_util.py): the file named after the
registry's address, the list under "nodes", each pack with a latest_version. A build that cannot reach the registry still
succeeds, without the file: Manager then reads it at the pod's start, as before.
"""

import json
import os
import sys
import time
import urllib.request

BASE_URL = "https://api.comfy.org"
URI = f"{BASE_URL}/nodes"


def simple_hash(text):
    """manager_util.simple_hash: the number its cache files are named with."""
    value = 0
    for char in text:
        value = (value * 31 + ord(char)) % (2**32)
    return value


def cache_name(uri=URI):
    """manager_util.get_cache_path's file name for an address."""
    return f"{simple_hash(uri)}_{os.path.basename(uri).replace('&', '_').replace('?', '_').replace('=', '_')}.json"


def fetch_all(comfyui_version, opener=urllib.request.urlopen):
    nodes = {}
    page = 1
    while True:
        url = f"{URI}?page={page}&limit=30&comfyui_version={comfyui_version}&form_factor=git-linux"
        with opener(urllib.request.Request(url, headers={"User-Agent": "afflatus-pod-build"}), timeout=30) as res:
            got = json.load(res)
        for node in got.get("nodes", []):
            nodes[node["id"]] = node
        if page >= int(got.get("totalPages", 1)):
            break
        page += 1
        time.sleep(0.2)
    for node in nodes.values():
        node.setdefault("latest_version", {"version": "nightly"})
    return list(nodes.values())


def main(out_dir, comfyui_version):
    try:
        nodes = fetch_all(comfyui_version)
    except Exception as err:
        print(f"[afflatus-pod] the registry was not read ({err}): Manager reads it at the pod's start", flush=True)
        return 0
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, cache_name()), "w", encoding="utf-8") as f:
        json.dump({"nodes": nodes}, f)
    print(f"[afflatus-pod] the registry's {len(nodes)} node packs kept for Manager's cache", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "unknown"))
