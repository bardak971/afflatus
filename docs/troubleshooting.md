# Troubleshooting

Start with **Settings › About › On this computer**: it runs the start-up checks (ffmpeg, ffprobe, Node, the data folder) and says what failed. Then look below for what you see.

## ComfyUI

**"ComfyUI is offline" / nothing renders.** Settings › ComfyUI → **Test**. The address must be the one your browser reaches ComfyUI at (`http://127.0.0.1:8188` on the same machine). If ComfyUI runs on another machine, start it with `--listen` and use that machine's address; if Afflatus runs in Docker, `127.0.0.1` is the container itself, so use the host's address (see [Docker](install-docker.md#comfyuis-address)).

**"ComfyUI isn't answering · the render goes on".** Not the same as offline. ComfyUI went silent in the middle of a render, but its process still runs: its port still takes a connection, or RunPod says the pod runs. That is a ComfyUI loading a model, or a PC short of memory and paging. The render is followed on and never queued again; the Queue and the status bar say so (with what ComfyUI holds and the RAM free when it is this PC's), and one **ComfyUI not answering** notification goes out until it answers again (its own tick in Settings › Notifications). When it says the PC is paging, restart ComfyUI once the queue is empty to give that memory back. A port closed, or a proxy with nothing behind it, is offline: the render is queued again while attempts remain.

**Settings › ComfyUI has a "Too old for" row.** Afflatus reads ComfyUI's version and PyTorch when it connects, and names the families (or the forms of a family) your ComfyUI is too old for, with the version they need. Update ComfyUI: `git pull` in its folder and its requirements with its own Python, `update\update_comfyui.bat` on the portable (**Copy what to run** gives the line when ComfyUI is on this PC), ComfyUI Desktop updates itself. A PyTorch built for a CUDA older than 13 gets a row too: the int8 and NVFP4 files then run without their fast kernels.

**A form says a node pack is missing.** The form says it under the option before you render, and the job waits for it in the Queue: **Install and restart** (through ComfyUI-Manager, ComfyUI restarted once nothing renders there), **Run without**, or set the machine to **Always** in Settings › ComfyUI › Missing node packs. Without Manager, clone the pack into `custom_nodes` and restart ComfyUI. Nodes that come with ComfyUI itself are said as "update ComfyUI", with the version that brought them; Manager's "Install Missing Custom Nodes" cannot find those. The Afflatus node pack itself is written from Settings › ComfyUI once Afflatus knows ComfyUI's folder, with **Restart ComfyUI** on its row.

**A pack says "installed, not loaded".** ComfyUI-Manager installed it but ComfyUI did not load it after its restart (a missing Python package, an import error in ComfyUI's log). Afflatus does not install it again by itself: fix what the log says, restart ComfyUI by hand, and the job goes on. A pack too old for the job (loaded, but without the node it needs) is said as such: update it through Manager or a `git pull` in its folder.

**A model file is missing.** Settings › Models lists each missing file, the folder it goes in and its size, and a family missing files has **Get the minimum** for what its first operation needs. A render that lacks only files Afflatus knows a download for waits in the Queue with **Download** instead of failing, and starts once they are in; a file put there by hand is noticed within a minute, or at once with **Look again** on its row. See [Downloads](comfyui-setup.md#downloads).

**A Civitai download is refused.** Most files need your Civitai API key (Settings › Models › Civitai API key). A version marked **Paid** or **Early Access · until <day>** in Find models is sold on Civitai: unlock it on its page with the same account, then download it again. The refusal says Civitai's own reason with the version's page, and a key Civitai refuses is said as such.

**Downloads are refused when ComfyUI listens on the network.** That is ComfyUI-Manager, which downloads only when neither Afflatus nor its node pack can: behind `--listen` it fetches from a URL only when its `network_mode` is `personal_cloud`. Set it in Manager's `config.ini` and restart ComfyUI ([details](comfyui-setup.md#comfyui-manager)). Better, update Afflatus's node pack (Settings › ComfyUI) and restart ComfyUI: the pack then downloads instead. When ComfyUI runs on another machine than Afflatus, also set `PUBLIC_URL` so ComfyUI can reach Afflatus ([configuration](configuration.md)).

**A large download stops with "ComfyUI-Manager dropped the connection".** Manager holds a file from anywhere but Hugging Face in memory until the end, and Windows can refuse past a few GB (`WinError 10055` in ComfyUI's log). Let Afflatus download it instead: on the same machine, give Settings › ComfyUI the ComfyUI folder; on another machine, update the node pack and restart ComfyUI.

**A video render dies at the very end, with a stack overflow in ComfyUI's log.** Some large video graphs crash ComfyUI's graph compiler. Start ComfyUI with `--disable-comfy-compiler`.

**A render ran out of video memory.** Queue › Render times flags it. Lower the resolution or the length, or render fewer takes at once. Unloading models between jobs (Settings › ComfyUI) also helps when the queue mixes model families.

## A job that waits

Every waiting row in the Queue says what holds it, amber where it waits on you:

| The row says | What to do |
|---|---|
| **waits for a GPU** | No ComfyUI of your own is added and no rented GPU is up: add one in Settings › ComfyUI, or Deploy a GPU from the status bar |
| **waits for N files on <machine>** | Press **Download** on the row (nothing is downloaded unasked), or put the files in by hand and press **Look again** |
| **waits for a node pack** | **Install and restart**, or **Run without** (above) |
| **waits for pod <name>** | It is pinned to a stopped pod, or only that pod has its files: **Start** (the rate and the idle stop asked first), or move it with **Run on** in its menu |
| **its pod was terminated** | Its pod went (idle stop, Terminate): deploy one, or **Run on** another machine |
| **· stuck on <pod>: …** | A file the pod never got. Afflatus asks for it again; meanwhile the job no longer keeps the pod billed past its idle stop |
| **Render on <machine> now** | The plan keeps it for a machine that ends it sooner (one that holds its model, a faster one) while this one is free. Click to run it there |

A pod's **Start** greyed on a row means a spending cap is reached: raise it in Settings › Costs, or wait for the day or the month to turn. An agent's job over its token's cap says its figures on the row ([agents (MCP)](mcp.md)).

A timeline clip that carries on from the clip before waits for that clip's render. One whose clip before has no take and none coming is refused, saying to render that clip first or to make the join a hard cut.

## ffmpeg

Afflatus tries ffmpeg as it uses it at start: version 6.1 or newer, libx264 and aac, and a test cut of a join's run-up. **ffmpeg 7.0 and 7.1 are refused**: they miscount those frames, and joins fail with "The frames to join onto could not be cut from that clip".

- When the one on the `PATH` fails, Afflatus takes the first that passes among Get ffmpeg's and ComfyUI's own (imageio-ffmpeg, once ComfyUI's folder is set), and Settings › About says which.
- When none passes, **Get ffmpeg** (Settings › About, the banner, the first launch; Windows and Linux) downloads the bundles' build into `data/bin`, checks its SHA-256 and uses it at once. On macOS, About gives the `brew install ffmpeg` line ([details](install-desktop.md#macos-and-ffmpeg)).
- `FFMPEG` and `FFPROBE` set by you are never swapped for another: their failure is said instead ([configuration](configuration.md)).
- In Docker, the image's ffmpeg is the one used; there is no Get ffmpeg there.

A join whose frames could not be cut names the ffmpeg, its version and the count it gave, and points to About.

## Rented GPUs

**A pod stays up with nothing rendering.** Its idle stop counts from its last render; a job waiting for files the pod never gets no longer holds it. Check the pod's card in Settings › Rented GPUs for its idle and watchdog minutes, and Queue › Costs for where its time went.

**Start is refused on a stopped pod.** RunPod has no GPU free on that pod's host. Afflatus offers to deploy a new pod on the same network volume, its models already there, through the usual deploy and its caps; the renders pinned to the stopped pod move to the new one.

**A deploy is refused.** A spending cap would be passed: the refusal says the sum (what is spent, what the pods up commit, what the deploy adds). The caps are in Settings › Costs.

## Afflatus

**The port is taken.** Start with another one: `PORT=8730` (see [configuration](configuration.md)).

**Other machines cannot reach it.** It listens on `127.0.0.1` unless `HOST=0.0.0.0` is set, and then only answers to the names it knows: add the machine's LAN name or address to `ALLOWED_HOSTS`. Set a password in Settings › Sign-in first, and read [SECURITY.md](../SECURITY.md) before opening it up.

**A request gets a 403 behind a reverse proxy.** Add the proxy's host name to `ALLOWED_HOSTS`.

**Videos do not play or exports fail on a Mac.** The Mac bundle has no ffmpeg: `brew install ffmpeg` ([details](install-desktop.md#macos-and-ffmpeg)).

**Linking a folder is refused.** From another device than the computer Afflatus runs on (through a proxy or a tunnel too), or once Afflatus listens on the network, only folders under `LINK_ROOTS` can be linked ([configuration](configuration.md)).

**Something renders on a model you did not pick.** Look at the waiting job in the Queue: each one says which model it loads. A preset or a person from the Prompt kit can bring their own model or LoRA.

**Render is greyed.** The form says why over it ("Write what happens first.", "Add the source video first"), and the status bar names a file that is not there yet.

**The library fills up.** Renders that are not kept go to the bin after a day, and the bin empties itself after a week (both set in Settings › Storage: check they are not on "Never" and "Until emptied"). Settings › Storage shows what takes the space, including takes that never play in a timeline.

**The model folders fill up.** Settings › Model files lists every model file on this PC with how Afflatus used it: the ones it never used, the extra copies, the space by last use. Delete moves them to the Recycle Bin (or a `.afflatus-set-aside` folder), Put back brings them back, and Empty erases them for good.

## Still stuck

Open an issue with the [bug report form](https://github.com/bardak971/afflatus/issues/new/choose): what you did, what you expected, the version (Settings › About), and the last lines of the server's console and of ComfyUI's log (Queue › ComfyUI log). Leave out anything private (paths, addresses, prompts you would rather not share).
