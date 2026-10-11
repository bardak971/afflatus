# Afflatus: the server and the web app in one image, ffmpeg included. ComfyUI is not in it: Afflatus talks to
# the one you run, at the address you give it in Settings.
#
#   docker run -p 127.0.0.1:8720:8720 -v afflatus-data:/data ghcr.io/bardak971/afflatus:latest
#
# The build stage can run on any platform; the runtime stage installs the npm dependencies for its own
# platform (sharp has one native package per platform), so a multi-arch build gets each right.
#
# Both stages start from one exact node:24-bookworm-slim, pinned by the digest of its multi-arch index. To
# move it, `docker buildx imagetools inspect node:24-bookworm-slim` prints the new one (its Digest line).
# The ffmpeg is Debian's own package, a GPL build (the desktop bundles carry an LGPL one).

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

FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
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
