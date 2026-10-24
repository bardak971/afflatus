# Afflatus: the server and the web app in one image, ffmpeg included. ComfyUI is not in it: Afflatus talks to
# the one you run, at the address you give it in Settings.
#
#   docker run -p 127.0.0.1:8720:8720 -v afflatus-data:/data ghcr.io/bardak971/afflatus:latest
#
# The build stage can run on any platform; the runtime stage installs the npm dependencies for its own
# platform (sharp has one native package per platform), so a multi-arch build gets each right.
#
# The three stages start from one exact node:24-bookworm-slim, pinned by the digest of its multi-arch index. To
# move it, `docker buildx imagetools inspect node:24-bookworm-slim` prints the new one (its Digest line).
# The ffmpeg is the desktop bundles' own, BtbN's GPL 9.0 build (its stage says why not Debian's).

FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/comfy/package.json packages/comfy/package.json
COPY packages/recipes/package.json packages/recipes/package.json
COPY packages/workflows/package.json packages/workflows/package.json
RUN pnpm install --frozen-lockfile
COPY . .
ARG AFFLATUS_VERSION=dev
ENV AFFLATUS_VERSION=$AFFLATUS_VERSION
# a release passes the package-lock.json its stage job resolved (a path inside the build context), so the
# image installs the same tree as the bundles; a local build resolves one here
ARG AFFLATUS_LOCK=
RUN node scripts/release/stage.mjs ${AFFLATUS_LOCK:+--lock "$AFFLATUS_LOCK"}

# ffmpeg and ffprobe: the build the Windows and Linux bundles carry (scripts/release/bundle.mjs's FFMPEG_TAG, BtbN's
# GPL 9.0 build, with libx264), the one for the image's platform, checked against the SHA-256 its release lists in
# checksums.sha256 (ffmpegGet.test.ts holds both sums to scripts/release/checksums.json, and the amd64 one in step with Get ffmpeg's). Not Debian's: bookworm's 5.1 is
# below the 6.1 the start-up check asks (apps/server/src/ffmpegCheck.ts), and trixie's 7.1 miscounts a join's run-up.
# It only downloads and unpacks, so it runs on the build's own platform (no emulation for arm64).
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS ffmpeg
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
 && rm -rf /var/lib/apt/lists/*
ARG TARGETARCH
WORKDIR /ffmpeg
RUN set -eu; \
    tag=autobuild-2026-09-30-13-08; \
    case "$TARGETARCH" in \
      amd64) file=ffmpeg-n9.0.2-17-g2a571b6068-linux64-gpl-9.0.tar.xz; sum=68ee646831adaae2495618346f3bba94ff207ff83bbd34d643e7004730d66269 ;; \
      arm64) file=ffmpeg-n9.0.2-17-g2a571b6068-linuxarm64-gpl-9.0.tar.xz; sum=91afcd7695d4bbbb9e0057aa10baaf9875ec4e1a97303f9059ec971336a2ab46 ;; \
      *) echo "BtbN builds ffmpeg for amd64 and arm64 only, not $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL --retry 3 -o "$file" "https://github.com/BtbN/FFmpeg-Builds/releases/download/$tag/$file"; \
    echo "$sum  $file" | sha256sum -c -; \
    mkdir x; tar -xJf "$file" -C x; \
    mkdir -p out/bin out/share/doc/ffmpeg; \
    cp x/ffmpeg-*/bin/ffmpeg x/ffmpeg-*/bin/ffprobe out/bin/; \
    cp x/ffmpeg-*/LICENSE.txt out/share/doc/ffmpeg/LICENSE.txt; \
    echo "ffmpeg and ffprobe: BtbN FFmpeg-Builds $tag, $file (SHA-256 $sum)" > out/share/doc/ffmpeg/VERSIONS.txt

FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
# xz-utils: Get ffmpeg unpacks BtbN's .tar.xz with tar, which hands it to xz (on amd64, Settings › About offers it when the
# image's own ffmpeg fails its check)
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini xz-utils \
 && rm -rf /var/lib/apt/lists/*
COPY --from=ffmpeg /ffmpeg/out/ /usr/local/
# run once on the image's own platform: a build that cannot encode as Afflatus does is not shipped
RUN ffmpeg -hide_banner -encoders | grep -q libx264 && ffprobe -hide_banner -version > /dev/null
WORKDIR /app
COPY --from=build /src/release/app /app
# the exact dependency tree the staging resolved (its package-lock.json), not a fresh resolution per build
RUN npm ci --omit=dev --no-audit --no-fund --loglevel=error \
 && npm cache clean --force \
 && mkdir -p /data && chown -R node:node /app /data
ARG AFFLATUS_VERSION=dev
# AFFLATUS_INSTALL tells the server it runs in an image: it says when a release is out, and that a new image is
# pulled to update (an image is never changed from inside)
ENV AFFLATUS_VERSION=$AFFLATUS_VERSION \
    AFFLATUS_INSTALL=docker \
    NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8720 \
    DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8720
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
# stacks in the log name the sources (the bundle's map is beside it)
CMD ["node", "--enable-source-maps", "/app/apps/server/dist/index.mjs"]
