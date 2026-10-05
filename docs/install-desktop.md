# Afflatus on a PC or a Mac

The release bundles run with nothing installed: they carry their own Node runtime and, on Windows and Linux, ffmpeg. Download the one for your machine from the [releases page](https://github.com/bardak971/afflatus/releases).

| Machine | File | Start |
|---|---|---|
| Windows 10 or 11, x64 | `afflatus-<version>-win-x64.zip` | Unzip anywhere, double-click `Afflatus.bat` |
| Linux, x64 | `afflatus-<version>-linux-x64.tar.gz` | `tar xzf` it, run `./afflatus.sh` |
| macOS on Apple Silicon | `afflatus-<version>-darwin-arm64.tar.gz` | `tar xzf` it, run `./afflatus.sh` |

A console window opens and says the address; your browser opens on `http://127.0.0.1:8720` a few seconds later. Closing the window, or Ctrl+C, stops Afflatus. There is nothing to install and nothing is written outside the folder you unpacked.

## First run

1. **ComfyUI.** Start your ComfyUI as usual. In Afflatus, Settings → ComfyUI, enter its address (`http://127.0.0.1:8188` when it runs on this machine) and press Test.
2. **ComfyUI's folder.** On the same page, give it ComfyUI's folder (the one with `main.py`). With it, Afflatus installs its node pack into ComfyUI's `custom_nodes` (restart ComfyUI once after that) and reads your model files to tell which model each is for. Without it, both are done by hand or by name.
3. **Models.** Settings → Models shows what is ready per model family and what is missing, with the file names and where they go. To have Afflatus download them into ComfyUI, turn on "Download missing models" there: it works through ComfyUI-Manager, which ComfyUI has built in since 0.3.7x but keeps off until asked. In ComfyUI's folder, run `pip install -r manager_requirements.txt` with ComfyUI's own Python (the venv's, or `python_embeded` in the portable build), then start ComfyUI with `--enable-manager`. An older ComfyUI takes the ComfyUI-Manager custom node instead (clone `https://github.com/Comfy-Org/ComfyUI-Manager` into `custom_nodes`). The desktop build has it on already. Without it, missing files still get links to open in your browser.
4. **A language model**, if you want the prompt designer: Settings → Designer, any OpenAI-style address (LM Studio, Ollama, llama.cpp on this machine, or a service).

## Where things are

- Your data, the library, the settings and the timelines, lives in the `data` folder next to the launcher. Nothing else is written.
- To update, unpack the next release over the old folder, or beside it and move the `data` folder across. The database migrates itself at start.
- To move Afflatus to another machine, move the folder. A backup is one zip from Settings → Storage → Back up now; restoring is unpacking it into an empty `data` folder.

## Options

The launcher reads a few environment variables. On Windows set them in the console before starting (`set PORT=8730` in cmd, `$env:PORT=8730` in PowerShell), on Linux and macOS as usual (`PORT=8730 ./afflatus.sh`).

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8720` | The port. Change it when another program, or another Afflatus, has 8720 |
| `HOST` | `127.0.0.1` | The address. `0.0.0.0` makes it reachable from other machines on your network; there is no login, so only do that on a network you trust |
| `ALLOWED_HOSTS` | empty | The names Afflatus answers to, comma-separated, besides `localhost`, `127.0.0.1`, the `HOST` address and the host of `PUBLIC_URL`. A request that names any other host (a page on another site pointing one of its names at this machine) gets a 403. When you open Afflatus by your PC's name or LAN address, put that name or address here: `ALLOWED_HOSTS=pc.lan,192.168.1.20` |
| `PUBLIC_URL` | empty | The address other machines reach Afflatus at (`http://192.168.1.20:8720`), given to ComfyUI for model downloads when ComfyUI runs elsewhere; its host is answered to as well |
| `LINK_ROOTS` | empty | Only the folders named here (and what is inside them) can be linked from Settings → Folders, separated as PATH is (`;` on Windows, `:` elsewhere). Set it whenever Afflatus can be reached from other machines: without it, anyone who can open the page can link any folder of the disk Afflatus can read and have its pictures, videos and sounds served and written to. The system's own folders (Windows, Program Files, AppData, a drive's root, the home folder itself) are never linked, whatever is set |
| `DATA_DIR` | the `data` folder beside the launcher | Where everything is kept |
| `FFMPEG`, `FFPROBE` | the bundled ones (`bin/`), or the PATH on macOS | The tools' paths |

## macOS and ffmpeg

The Mac bundle has no ffmpeg: there is no build of it that can be shipped without licence questions. Install it once with Homebrew:

```
brew install ffmpeg
```

Without it the library and the designer work; trims, exports, joins, slow motion and video previews do not, and Settings → About says so. The first time the launcher runs it also clears macOS's quarantine mark on the bundled Node, so Gatekeeper does not stop it.

## Running from the sources instead

See [develop.md](develop.md). It needs Node 22.16 or newer and ffmpeg on the PATH.
