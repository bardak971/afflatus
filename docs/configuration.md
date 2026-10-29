# Configuration

Afflatus is configured in two places: a few environment variables read at start, and everything else in the app's Settings, kept in its database.

## Environment variables

Set them before starting: in the console on Windows (`set PORT=8730` in cmd, `$env:PORT=8730` in PowerShell), on the command line elsewhere (`PORT=8730 ./afflatus.sh`), under `environment:` in Docker Compose, or in the Helm chart's `env` values.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8720` | The port to listen on |
| `HOST` | `127.0.0.1` | The address to listen on. `0.0.0.0` opens it to your network; the Docker image listens on all. Set a password (Settings › Access) first: see [Security](../SECURITY.md). Listening on loopback only, the password's "From this computer" exemption cannot be turned on |
| `DATA_DIR` | `./data` (`/data` in the image) | Where the database and the files live |
| `PUBLIC_URL` | empty | The address other machines reach Afflatus at (`http://192.168.x.y:8720`). Needed when ComfyUI runs on another machine, so Afflatus's node pack (or ComfyUI-Manager) can fetch downloads through Afflatus. Its host is also answered to |
| `ALLOWED_HOSTS` | empty | Host names Afflatus answers to, comma-separated, besides `localhost`, `127.0.0.1`, `HOST` and the host of `PUBLIC_URL`: the machine's LAN name or address, a reverse proxy's name. A request for any other name gets a 403 (this stops DNS rebinding). A reverse proxy must send `X-Forwarded-For`: Update and Go back are refused through it, and taken only at `localhost` or `127.0.0.1` on the machine itself |
| `TRUST_PROXY` | empty | Addresses of reverse proxies on other machines (comma-separated IPs) whose `X-Forwarded-Proto` is believed: behind a TLS proxy there, the sign-in cookie is then marked Secure. A proxy on the same machine is believed without it |
| `LINK_ROOTS` | empty | The only folders that may be linked into the library (and what is inside them), separated as `PATH` is (`;` on Windows, `:` elsewhere). Set it whenever Afflatus is reachable from other machines: without it, linking is refused once `HOST` is not loopback, and from any other device than this computer (a phone through a proxy or tunnel on this machine included). System folders are never linked, whatever is set |
| `DATABASE_URL` | empty | A `postgres://` address instead of SQLite. SQLite is the supported one; Postgres is written and its migrations run in CI, but it is not yet used day to day |
| `FFMPEG`, `FFPROBE` | the first that passes the start-up check: a bundle's own, the `PATH`'s, Get ffmpeg's in `data/bin`, ComfyUI's imageio-ffmpeg | The tools' paths. One you set is the only one tried, never swapped for another |
| `AFFLATUS_SQLITE_WORKER` | empty | `1` runs SQLite's statements in a worker thread instead of the server's own: a long read no longer holds the other requests, but a route of many small statements gets slower while ffmpeg takes every core. Off by default |
| `PRESETS_DIR` | the install's `presets/` folder | Where the shipped presets are read from |
| `RUNPOD_API_URL` | `https://api.runpod.io` | RunPod's API, for rented machines: a stand-in RunPod (the demo's `DEMO_RUNPOD=1`, the tests) |
| `RUNPOD_PROXY` | `https://{id}-{port}.proxy.runpod.net` | How a pod's ComfyUI is reached, `{id}` and `{port}` filled in: RunPod's own proxy unless set |
| `NODE_PACK_DIR` | the install's `comfy-nodes/afflatus-nodes` | Where the Afflatus node pack is installed into ComfyUI from |
| `CIVITAI_URL` | empty: civitai.com, then civitai.red | One Civitai-compatible site to ask instead (a mirror, a stand-in for tests). It lifts no download rule |
| `HUGGINGFACE_URL` | `https://huggingface.co` | Hugging Face's address, for a stand-in |
| `MODEL_LIST_URL` | ComfyUI-Manager's `model-list.json` on GitHub | The list of standard model files a missing file is looked up in |
| `UPDATES_URL` | GitHub's latest release of Afflatus | Where the daily check asks for the latest release, in the shape of GitHub's `releases/latest` answer: a mirror, or a stand-in for tests. Its downloads are fetched from it too. An update is still taken only when its `SHA256SUMS.txt` is signed by the release key built into Afflatus |
| `AFFLATUS_INSTALL` | set by the launcher (`bundle`) and the image (`docker`) | How Afflatus was installed, which decides what Settings → About offers: `bundle` updates itself, `docker` and anything else (the sources) get the notice and the command. Not to be set by hand |
| `AFFLATUS_RESET_PASSWORD` | empty | `1`: the password and every signed-in device are removed at this start, said loudly in the log (Settings › Access). For an owner who lost the password and every way to a reset code; take it out once in. The same without a start: `reset-password` (`Afflatus.bat reset-password`, `./afflatus.sh reset-password`, `pnpm start reset-password`) with Afflatus stopped |
| `AFFLATUS_NO_BROWSER` | empty | `1`: a bundle's launcher opens no browser tab when Afflatus starts |
| `AFFLATUS_PRETEND_SITES` | empty | `1`: the sites are pretend ones on this machine (the tests, the demo). Plain-http downloads are then allowed, and no real site is asked for what no stand-in covers (Hugging Face, Manager's model list). Never set it on a real install |

## In the app

Everything else is in **Settings**, saved as you change it:

- **ComfyUI:** its address, its folder when it runs on this machine (for the node pack and to read model files), when to unload models.
- **Models:** which families are on, what each has ready or missing, downloads into ComfyUI's model folders, a Civitai API key for files that need an account, newer versions of your models.
- **Designer:** an optional OpenAI-style language model that writes prompts (LM Studio, Ollama, llama.cpp or a service), its system prompts and context size.
- **Prompts:** the prompting guide per model family that the designer follows, and the Danbooru tag check.
- **Interface:** theme and accent colour, explanations under every setting or behind the `?`, playing videos and sound on hover; browser notifications when the queue empties or after each render.
- **Command bar:** its shortcut, whether it learns what you use, its preview, and its optional parts (prompt snippets, `@` cast).
- **Storage:** disk usage, the bin, takes that never play, how long render times are kept, backups.
- **About:** the version and its updates (a new version's notes, Update and Go back on a bundle, the command for Docker and the sources), "Check for new versions" (once a day, on by default: one request to GitHub, nothing about you in it), and the start-up checks (ffmpeg, ffprobe, Node, the data folder).

Nothing leaves your machine unless you turn on a download or a lookup; each such switch is off until you turn it on.

## Metrics

`/metrics` serves Afflatus's figures in Prometheus format, for a scraper on the inside of the network (no key; it answers any Host name). Besides the record of render times and the machines' gauges (listed in `deploy/grafana/README.md`), it has the server's own:

- Node's figures, as prom-client collects them under their usual names: `process_resident_memory_bytes`, `process_cpu_seconds_total`, `nodejs_heap_size_used_bytes`, `nodejs_eventloop_lag_seconds` (with `_p50`, `_p90`, `_p99`), `nodejs_gc_duration_seconds` and the others of its default set.
- `afflatus_render_added_seconds{machine, stage}`: what Afflatus adds around each render, per machine: `before` (from the job's start until ComfyUI has the prompt) and `filing` (from the last output until what it made is stored).
- `afflatus_render_added_part_seconds{machine, part}`: their parts: `scan` (the node list and the machine check), `cuts` (cutting and reading the pictures, clips and sounds it is handed), `uploads` (sending them), `free` (freeing ComfyUI's memory for another model), `measuring` (measuring a finished video, once its job closed: the machine takes its next job meanwhile).

These are the seconds a GPU waits on Afflatus: a machine where they grow (a rented pod's uploads, a slow disk) shows there. The dashboard in `deploy/grafana/afflatus.json` has them in its **Server** row.
