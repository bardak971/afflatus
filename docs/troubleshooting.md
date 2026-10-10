# Troubleshooting

Start with **Settings → About**: it runs the start-up checks (ffmpeg, ffprobe, Node, the data folder) and says what failed. Then look below for what you see.

## ComfyUI

**"ComfyUI is offline" / nothing renders.** Settings → ComfyUI → **Test**. The address must be the one your browser reaches ComfyUI at (`http://127.0.0.1:8188` on the same machine). If ComfyUI runs on another machine, start it with `--listen` and use that machine's address; if Afflatus runs in Docker, `127.0.0.1` is the container itself, so use the host's address (see [Docker](install-docker.md#comfyuis-address)).

**A form says a node pack is missing.** The form and the queue name the pack. Install it from the card (through ComfyUI-Manager, ComfyUI restarts from there), or by hand into `custom_nodes`, then restart ComfyUI. The Afflatus node pack itself is installed from Settings → ComfyUI once Afflatus knows ComfyUI's folder.

**A model file is missing.** Settings → Models lists each missing file, the folder it goes in, and where to get it. **Download** works through ComfyUI-Manager; see [ComfyUI setup](comfyui-setup.md#comfyui-manager-for-downloads).

**Downloads are refused when ComfyUI listens on the network.** ComfyUI-Manager only fetches from a URL behind `--listen` when its `network_mode` is `personal_cloud`. Set it in Manager's `config.ini` and restart ComfyUI ([details](comfyui-setup.md#comfyui-manager-for-downloads)). When ComfyUI runs on another machine than Afflatus, also set `PUBLIC_URL` so Manager can reach Afflatus ([configuration](configuration.md)).

**A video render dies at the very end, with a stack overflow in ComfyUI's log.** Some large video graphs crash ComfyUI's graph compiler. Start ComfyUI with `--disable-comfy-compiler`.

**A render ran out of video memory.** Queue → Render times flags it. Lower the resolution or the length, or render fewer takes at once. Unloading models between jobs (Settings → ComfyUI) also helps when the queue mixes model families.

## Afflatus

**The port is taken.** Start with another one: `PORT=8730` (see [configuration](configuration.md)).

**Other machines cannot reach it.** It listens on `127.0.0.1` unless `HOST=0.0.0.0` is set, and then only answers to the names it knows: add the machine's LAN name or address to `ALLOWED_HOSTS`. There is no login: read [SECURITY.md](../SECURITY.md) before opening it up.

**A request gets a 403 behind a reverse proxy.** Add the proxy's host name to `ALLOWED_HOSTS`.

**Videos do not play or exports fail on a Mac.** The Mac bundle has no ffmpeg: `brew install ffmpeg` ([details](install-desktop.md#macos-and-ffmpeg)).

**Linking a folder is refused.** Once Afflatus is reachable from other machines, only folders under `LINK_ROOTS` can be linked ([configuration](configuration.md)).

**Something renders on a model you did not pick.** Look at the waiting job in the Queue: each one says which model it loads. A preset or a person from the Prompt kit can bring their own model or LoRA.

**The library fills up.** Renders that are not kept go to the bin after a day, and the bin empties itself after a week. Settings → Storage shows what takes the space, including takes that never play in a timeline.

## Still stuck

Open an issue with the [bug report form](https://github.com/bardak971/afflatus/issues/new/choose): what you did, what you expected, the version (Settings → About), and the last lines of the server's console and of ComfyUI's log. Leave out anything private (paths, addresses, prompts you would rather not share).
