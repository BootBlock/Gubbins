# syntax=docker/dockerfile:1
#
# Thin, build-free image for the Gubbins bridge.
#
# The bridge runs TypeScript *directly* via Node's built-in type-stripping (Node ≥ 24,
# or ≥ 22.18 LTS — NOT any Node v23.x build; see README.md -> Requirements for why)
# and a zero-dependency ESM loader — there is nothing to compile and there are no runtime
# dependencies, so a single `node:slim` stage with no `npm install` is all it needs.
#
# IMPORTANT: the build context is the REPO ROOT, because the bridge imports the app's pure
# search/DB modules from ../src via the `@/` alias. Build it like this:
#
#   docker build -f bridge/Dockerfile -t gubbins-bridge .
#
# Then run it, mounting your synced snapshot read-only and passing config via the
# environment (NEVER bake a snapshot into the image — see .dockerignore). There is no token to
# pass: callers authenticate with per-user API tokens minted in the app, which arrive with the
# snapshot:
#
#   docker run --rm \
#     -p 127.0.0.1:8787:8787 \
#     -e GUBBINS_SNAPSHOT_PATH=/data/gubbins-sync.json \
#     -v /path/to/synced/folder/gubbins-sync.json:/data/gubbins-sync.json:ro \
#     -v gubbins-bridge-state:/state \
#     gubbins-bridge
#
# The `/state` volume keeps the bridge's stable identity (README.md -> "The bridge's stable
# identity") across a **recreated** container, so consumers such as Home Assistant go on
# recognising it as the same bridge. Leave the volume off and the identity lives only as long as
# the container does: a fresh `docker run` then looks like a different bridge.
#
FROM node:24-slim

WORKDIR /app

# The only things the bridge needs at runtime: its own package, and the app's pure source
# modules it imports via `@/`. No node_modules — the bridge has zero runtime deps.
#
# This copies `bridge/` wholesale into the final layer, so the repo-root `.dockerignore` is what
# keeps an operator's local files — a real `webhooks.json` of signing secrets, a `*.env`, a
# snapshot, a database, a private key — out of it. That list covers every rule in `.gitignore`
# and `bridge/.gitignore`, and `src/lib/docker-context-ignore.test.ts` checks each one.
COPY bridge/ ./bridge/
COPY src/ ./src/

# The repository manifest, which is where the bridge reads the version it reports over the
# API and mDNS (bridge/src/version.ts — it has no version of its own). Without this the
# image would start and then be unable to say which build it is.
COPY package.json ./package.json

# Somewhere the unprivileged user can actually write. The copied source above is root-owned, so
# without this the bridge could not save the identity it is recognised by and would fall back to
# deriving one from the container's hostname — which changes every time the container is recreated,
# making the same bridge look like a new one. Mount a volume here to survive a recreate.
RUN mkdir -p /state && chown node:node /state
ENV GUBBINS_BRIDGE_ID_FILE=/state/bridge-id
# Same volume, same reason: what the bridge published to MQTT last time. Without it a location
# deleted while the container was down keeps its retained topic and its Home Assistant entity.
ENV GUBBINS_BRIDGE_MQTT_STATE_FILE=/state/mqtt-retained.json

# Run as the image's built-in unprivileged user, never root.
USER node
EXPOSE 8787

# Inside a container the process must bind all interfaces for Docker's port mapping to
# work; keep it host-local by publishing to 127.0.0.1 (see the `-p 127.0.0.1:...` above)
# rather than exposing the container broadly. The token is still required on every request.
ENV GUBBINS_BRIDGE_HOST=0.0.0.0

CMD ["node", "bridge/serve.mjs"]
