# syntax=docker/dockerfile:1
#
# Thin, build-free image for the Gubbins bridge.
#
# The bridge runs TypeScript *directly* via Node's built-in type-stripping (Node ≥ 24,
# or ≥ 22.16 LTS — NOT any Node v23.x build; see README.md -> Requirements for why)
# and a zero-dependency ESM loader — there is nothing to compile and there are no runtime
# dependencies, so a single `node:slim` stage with no `npm install` is all it needs.
#
# IMPORTANT: the build context is the REPO ROOT, because the bridge imports the app's pure
# search/DB modules from ../src via the `@/` alias. Build it like this:
#
#   docker build -f bridge/Dockerfile -t gubbins-bridge .
#
# Then run it, mounting your synced snapshot read-only and passing config via the
# environment (NEVER bake a token or a snapshot into the image — see .dockerignore):
#
#   docker run --rm \
#     -p 127.0.0.1:8787:8787 \
#     -e GUBBINS_BRIDGE_TOKEN=your-long-random-token \
#     -e GUBBINS_SNAPSHOT_PATH=/data/gubbins-sync.json \
#     -v /path/to/synced/folder/gubbins-sync.json:/data/gubbins-sync.json:ro \
#     gubbins-bridge
#
FROM node:24-slim

WORKDIR /app

# The only two things the bridge needs at runtime: its own package, and the app's pure
# source modules it imports via `@/`. No node_modules — the bridge has zero runtime deps.
COPY bridge/ ./bridge/
COPY src/ ./src/

# Run as the image's built-in unprivileged user, never root.
USER node
EXPOSE 8787

# Inside a container the process must bind all interfaces for Docker's port mapping to
# work; keep it host-local by publishing to 127.0.0.1 (see the `-p 127.0.0.1:...` above)
# rather than exposing the container broadly. The token is still required on every request.
ENV GUBBINS_BRIDGE_HOST=0.0.0.0

CMD ["node", "bridge/serve.mjs"]
