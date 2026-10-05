# Afflatus with Docker

One image, `ghcr.io/bardak971/afflatus`, with ffmpeg inside, for `linux/amd64` and `linux/arm64`. It is tagged like the release (`0.1.0`), by minor (`0.1`) and `latest`. ComfyUI is not in it: Afflatus talks to the one you run.

## Compose

The repository's [compose.yaml](../compose.yaml):

```yaml
services:
  afflatus:
    image: ghcr.io/bardak971/afflatus:latest
    container_name: afflatus
    restart: unless-stopped
    ports:
      - "8720:8720"
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

Open `http://127.0.0.1:8720`. To update, `docker compose pull && docker compose up -d`. The data volume carries everything (database, library, settings) across updates.

Or without compose:

```
docker run -d --name afflatus -p 8720:8720 -v afflatus-data:/data ghcr.io/bardak971/afflatus:latest
```

## ComfyUI's address

In Settings → ComfyUI, give it the address as seen from inside the container:

- ComfyUI on the same machine as Docker Desktop (Windows or macOS): `http://host.docker.internal:8188`.
- ComfyUI on the same Linux machine: `http://host.docker.internal:8188` with the `extra_hosts` line above, or the machine's LAN address.
- ComfyUI on another machine: its LAN address, `http://192.168.x.y:8188`. ComfyUI must listen on that address (`--listen`). For Afflatus to download models into it, its ComfyUI-Manager must then have `network_mode = personal_cloud` in its `config.ini` (`user/__manager/` for the built-in Manager, `custom_nodes/ComfyUI-Manager/` for the custom node): a ComfyUI that listens on the network refuses downloads from a URL otherwise.

## The node pack

The container cannot write into ComfyUI's folder, so install Afflatus's node pack by hand once: Settings → ComfyUI → "download the node pack", unpack the zip into ComfyUI's `custom_nodes` folder (it makes `custom_nodes/afflatus-nodes/`), restart ComfyUI. It brings the MiniMax H3 continuation nodes and the route Afflatus uses to read your model files' headers through ComfyUI, since it cannot read the disk.

## Environment

| Variable | Default in the image | Meaning |
|---|---|---|
| `PORT` | `8720` | The port inside the container |
| `HOST` | `0.0.0.0` | Listens on all addresses inside the container; publish the port as you see fit |
| `DATA_DIR` | `/data` | The volume |
| `ALLOWED_HOSTS` | empty | The names Afflatus answers to, comma-separated. `localhost` and `127.0.0.1` always are; a request with any other `Host` header gets a 403, which keeps a page from another site from driving the API by pointing one of its names at this machine. Name here whatever you open Afflatus as from other machines, and the name a reverse proxy or a scraper uses (`ALLOWED_HOSTS=afflatus.home,192.168.1.20`) |
| `PUBLIC_URL` | empty | The address ComfyUI reaches Afflatus at, for model downloads; its host is answered to as well |
| `LINK_ROOTS` | empty | The directories that may be linked as folders, `:`-separated (a mounted volume: `LINK_ROOTS=/media`). Set it whenever the port is published beyond this machine: without it anyone who can open the page can link any directory the container can read |
| `DATABASE_URL` | empty | A `postgres://` address instead of SQLite in the volume. SQLite is the supported one |
| `TZ` | `UTC` | The time zone, for the times shown |

There is no login. Publish the port on your own network only, or put your usual reverse proxy with its own authentication in front.

## Backups

Settings → Storage → Back up now gives one zip of the database and every file. Or back up the volume itself: with the container stopped, copy `/var/lib/docker/volumes/afflatus-data`, or `docker run --rm -v afflatus-data:/data -v "$PWD":/out alpine tar czf /out/afflatus-data.tgz -C /data .`.

## Health

`GET /api/health` answers with the version, the database kind and the start-up checks; the image's own health check calls it.
