# Afflatus with Docker

One image, `ghcr.io/bardak971/afflatus`, with ffmpeg inside, for `linux/amd64` and `linux/arm64`. It is tagged like the release (`0.2.1`), by minor (`0.2`) and `latest`; a pre-release (`0.3.0-rc.1`) gets its own tag only. ComfyUI is not in it: Afflatus talks to the one you run. Its ffmpeg is the one the Windows and Linux bundles carry, BtbN's GPL 9.0 build (with libx264), checked against its published SHA-256 when the image is built; its licence is in `/usr/local/share/doc/ffmpeg`.

## Compose

The repository's [compose.yaml](../compose.yaml):

```yaml
services:
  afflatus:
    image: ghcr.io/bardak971/afflatus:latest
    container_name: afflatus
    restart: unless-stopped
    ports:
      - "127.0.0.1:8720:8720"
    volumes:
      - afflatus-data:/data
    extra_hosts:
      - "host.docker.internal:host-gateway"

volumes:
  afflatus-data:
```

```
docker compose up -d
```

Open `http://127.0.0.1:8720`. The port is published on this computer only. To reach Afflatus from other machines, publish it as `8720:8720` and set `ALLOWED_HOSTS` (below). To link folders of your disk, see [Linked folders](#linked-folders). To update, `docker compose pull && docker compose up -d`. The data volume carries everything (database, library, settings) across updates. Settings → About says when a new version is out and gives that command; a container does not replace its own image.

Or without compose:

```
docker run -d --name afflatus -p 127.0.0.1:8720:8720 -v afflatus-data:/data ghcr.io/bardak971/afflatus:latest
```

## Linked folders

A linked folder is a directory shown in the library as it is on the disk, its files used where they are. In the container that means two steps: mount the directory into the container, and name it in `LINK_ROOTS`. The image listens on every address inside the container (`HOST=0.0.0.0`), and a server that listens beyond loopback links nothing until `LINK_ROOTS` says which directories may be linked: without it, every link is refused, whatever the port is published as.

```yaml
    volumes:
      - afflatus-data:/data
      - /home/me/Videos:/media/videos
    environment:
      LINK_ROOTS: /media
```

Then link `/media/videos` (or a folder under it) from the Projects panel. Several roots are `:`-separated (`LINK_ROOTS=/media:/shoots`).

## ComfyUI's address

In Settings → ComfyUI, give it the address as seen from inside the container:

- ComfyUI on the same machine as Docker Desktop (Windows or macOS): `http://host.docker.internal:8188`.
- ComfyUI on the same Linux machine: `http://host.docker.internal:8188` with the `extra_hosts` line above, or the machine's LAN address.
- ComfyUI on another machine: its LAN address, `http://192.168.x.y:8188`. ComfyUI must listen on that address (`--listen`). For Afflatus to download models into it, give it Afflatus's node pack (below): the pack fetches the files through Afflatus (set `PUBLIC_URL`). Without the pack ComfyUI-Manager does it, and must then have `network_mode = personal_cloud` in its `config.ini` (`user/__manager/` for the built-in Manager, `custom_nodes/ComfyUI-Manager/` for the custom node): a ComfyUI that listens on the network refuses downloads from a URL otherwise.

## The node pack

The container cannot write into ComfyUI's folder, so install Afflatus's node pack by hand once: Settings → ComfyUI → "download the node pack", unpack the zip into ComfyUI's `custom_nodes` folder (it makes `custom_nodes/afflatus-nodes/`), restart ComfyUI. It brings the MiniMax H3 continuation nodes, the route Afflatus uses to read your model files' headers through ComfyUI (it cannot read the disk), and, from 0.11.0, the route that downloads models into ComfyUI's folders.

## Environment

| Variable | Default in the image | Meaning |
|---|---|---|
| `PORT` | `8720` | The port inside the container |
| `HOST` | `0.0.0.0` | Listens on all addresses inside the container; publish the port as you see fit |
| `DATA_DIR` | `/data` | The volume |
| `ALLOWED_HOSTS` | empty | The names Afflatus answers to, comma-separated. `localhost` and `127.0.0.1` always are; a request with any other `Host` header gets a 403, which keeps a page from another site from driving the API by pointing one of its names at this machine. Name here whatever you open Afflatus as from other machines, and the name a reverse proxy or a scraper uses (`ALLOWED_HOSTS=afflatus.home,192.168.x.y`) |
| `PUBLIC_URL` | empty | The address ComfyUI reaches Afflatus at, for model downloads (the node pack fetches through it); its host is answered to as well |
| `LINK_ROOTS` | empty | The directories that may be linked as folders, `:`-separated (a mounted volume: `LINK_ROOTS=/media`). Needed to link anything: the image listens beyond loopback, so with it empty every link is refused ([Linked folders](#linked-folders)) |
| `DATABASE_URL` | empty | A `postgres://` address instead of SQLite in the volume. SQLite is the supported one |
| `TZ` | `UTC` | The time zone, for the times shown |

Set a password in Settings › Interface › Access before publishing the port (requests from the host come through Docker's network, so none is exempt from it). A forgotten one: the sign-in sends a code to Telegram or to `docker logs afflatus`; lost every way in, `docker compose stop afflatus && docker compose run --rm afflatus node apps/server/dist/index.mjs reset-password`, or set `AFFLATUS_RESET_PASSWORD: "1"` for one start. For the internet, put your usual reverse proxy with its own authentication in front.

## Backups

Settings → Storage → Back up now gives one zip of the database and every file. Or back up the volume itself: with the container stopped, copy `/var/lib/docker/volumes/afflatus-data`, or `docker run --rm -v afflatus-data:/data -v "$PWD":/out alpine tar czf /out/afflatus-data.tgz -C /data .`.

## Health

`GET /api/health` answers with the version, the database kind and the start-up checks; the image's own health check calls it.

## Next

[Configuration](configuration.md) for every setting and environment variable, [using Afflatus](guide.md) for a walk through the app, and [troubleshooting](troubleshooting.md) when something does not work.
