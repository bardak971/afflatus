# Afflatus on a PC or a Mac

The release bundles run with nothing installed: they carry their own Node runtime and, on Windows and Linux, ffmpeg. Download the one for your machine from the [releases page](https://github.com/bardak971/afflatus/releases).

| Machine | File | Start |
|---|---|---|
| Windows 10 or 11, x64 | `afflatus-<version>-win-x64.zip` | Unzip anywhere, double-click `Afflatus.bat` |
| Linux, x64 | `afflatus-<version>-linux-x64.tar.gz` | `tar xzf` it, run `./afflatus.sh` |
| macOS on Apple Silicon | `afflatus-<version>-darwin-arm64.tar.gz` | `tar xzf` it, run `./afflatus.sh` |

A console window opens and says the address; your browser opens on `http://127.0.0.1:8720` a few seconds later. Closing the window, or Ctrl+C, stops Afflatus. There is nothing to install. Outside the folder you unpacked, Afflatus writes only working copies in the system's temp folder (uploads, trims, exports, backups; removed once done), the node pack into ComfyUI's `custom_nodes` when you give it ComfyUI's folder, pictures and clips it hands to ComfyUI into ComfyUI's `input/afflatus`, and what you save into a linked folder.

## First run

1. **ComfyUI.** Start your ComfyUI as usual. In Afflatus, Settings → ComfyUI, enter its address (`http://127.0.0.1:8188` when it runs on this machine) and press Test.
2. **ComfyUI's folder.** On the same page, give it ComfyUI's folder (the one with `main.py`). With it, Afflatus installs its node pack into ComfyUI's `custom_nodes` (restart ComfyUI once after that) and reads your model files to tell which model each is for. Without it, both are done by hand or by name.
3. **Models.** Settings → Models shows what is ready per model family and what is missing, with the file names and where they go. To have Afflatus download them into ComfyUI, turn on "Download missing models" there: it works through ComfyUI-Manager, which ComfyUI has built in since 0.3.7x but keeps off until asked. In ComfyUI's folder, run `pip install -r manager_requirements.txt` with ComfyUI's own Python (the venv's, or `python_embeded` in the portable build), then start ComfyUI with `--enable-manager`. An older ComfyUI takes the ComfyUI-Manager custom node instead (clone `https://github.com/Comfy-Org/ComfyUI-Manager` into `custom_nodes`). The desktop build has it on already. When ComfyUI listens on the network (`--listen`), Manager refuses downloads from a URL unless its `network_mode` is `personal_cloud`: set it in `user/__manager/config.ini` (the built-in Manager) or `custom_nodes/ComfyUI-Manager/config.ini` (the custom node) and restart ComfyUI. A ComfyUI that listens on localhost only needs nothing. Without Manager, missing files still get links to open in your browser.
4. **A language model**, if you want the prompt designer: Settings → Designer, any OpenAI-style address (LM Studio, Ollama, llama.cpp on this machine, or a service).

## Where things are

From 0.4.0 the download unpacks to one `Afflatus` folder, which updates keep in place:

```
Afflatus/
  Afflatus.bat, afflatus.sh    the launchers: they start the version named in versions/current
  versions/
    current                    one line: the version to start
    0.4.0/                     a version: its Node, the app and ffmpeg
  data/                        your library, settings and timelines, made at the first start
```

- Your data, the library, the settings and the timelines, lives in `data`, never inside a version.
- To move Afflatus to another machine, move the `Afflatus` folder. A backup is one zip from Settings → Storage → Back up now; restoring is unpacking it into an empty `data` folder.

## Updating

Once a day Afflatus asks GitHub for its latest release (one request, nothing about you in it; the switch is "Check for new versions" in Settings → About). A new version shows as a dot on Settings; Settings → About gives its notes and **Update to …**:

1. The archive, `SHA256SUMS.txt` and its signature are downloaded into `data/updates/`. The signature is checked with the release key built into Afflatus, then the archive's SHA-256 against the signed list: anything that does not match is refused, and nothing changes.
2. The new version is unpacked into `versions/` beside the one that runs, and asked to start once with `--check`.
3. Afflatus waits for the renders already in the queue; nothing new starts meanwhile. **Not now** stops the update until it switches.
4. A copy of the database goes to `data/backups/before-<version>.db`, `versions/current` names the new version, and Afflatus restarts on it. The page follows by itself.

The version before is kept in `versions/` (one, never more). **Go back** in Settings → About restarts on it and restores the database copy taken at the update: what was made since stays in the `data` folder, not in the list. If a new version stops before it is up, the launcher starts the one before again and About says so.

Update and Go back are done on the computer Afflatus runs on: another computer on your network sees the notice, not the buttons.

## Coming from 0.3.0

A 0.3.0 bundle keeps its library inside its own folder, so the step from it is the one download done by hand (the latest release; updates come in the app after it), and its library is moved by hand:

1. Close Afflatus 0.3.0.
2. Unpack the new version anywhere but into the 0.3.0 folder.
3. Move the 0.3.0 folder's `data` folder into the new `Afflatus` folder, beside `versions/`. If the new version was started once already, it has a `data` folder of its own there: delete it or set it aside first. On the same disk the move is a rename, no second copy; the settings, the Prompt kit and your linked folders come with it.
4. Start the new version: it brings the library up to date at its first start.
5. Once your library is there, the 0.3.0 folder can be deleted.

Instead of moving the folder, `DATA_DIR` can point at it where it is.

## Options

The launcher reads a few environment variables. On Windows set them in the console before starting (`set PORT=8730` in cmd, `$env:PORT=8730` in PowerShell), on Linux and macOS as usual (`PORT=8730 ./afflatus.sh`).

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8720` | The port. Change it when another program, or another Afflatus, has 8720 |
| `HOST` | `127.0.0.1` | The address. `0.0.0.0` makes it reachable from other machines on your network; there is no login, so only do that on a network you trust |
| `ALLOWED_HOSTS` | empty | The names Afflatus answers to, comma-separated, besides `localhost`, `127.0.0.1`, the `HOST` address and the host of `PUBLIC_URL`. A request that names any other host (a page on another site pointing one of its names at this machine) gets a 403. When you open Afflatus by your PC's name or LAN address, put that name or address here: `ALLOWED_HOSTS=pc.lan,192.168.x.y` |
| `PUBLIC_URL` | empty | The address other machines reach Afflatus at (`http://192.168.x.y:8720`), given to ComfyUI's node pack for model downloads when ComfyUI runs elsewhere; its host is answered to as well |
| `LINK_ROOTS` | empty | Only the folders named here (and what is inside them) can be linked from Settings → Folders, separated as PATH is (`;` on Windows, `:` elsewhere). Set it whenever Afflatus can be reached from other machines: without it, anyone who can open the page can link any folder of the disk Afflatus can read and have its pictures, videos and sounds served and written to. The system's own folders (Windows, Program Files, AppData, a drive's root, the home folder itself) are never linked, whatever is set |
| `DATA_DIR` | the `data` folder beside the launcher | Where everything is kept |
| `FFMPEG`, `FFPROBE` | the bundled ones (`versions/<version>/bin/`), or the PATH on macOS | The tools' paths |
| `AFFLATUS_NO_BROWSER` | empty | `1`: the launcher opens no browser tab when Afflatus starts (a machine without a desktop, a start at log-in) |

## macOS and ffmpeg

The Mac bundle has no ffmpeg: there is no build of it that can be shipped without licence questions. Install it once with Homebrew:

```
brew install ffmpeg
```

Without it the library and the designer work; trims, exports, joins, slow motion and video previews do not, and Settings → About says so. The first time the launcher runs it also clears macOS's quarantine mark on the bundled Node, so Gatekeeper does not stop it.

## Running from the sources instead

See [develop.md](develop.md). It needs Node 22.16 or newer and ffmpeg on the PATH.

## Next

[Configuration](configuration.md) for every setting and environment variable, [using Afflatus](guide.md) for a walk through the app, and [troubleshooting](troubleshooting.md) when something does not work.
