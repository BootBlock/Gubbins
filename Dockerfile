# syntax=docker/dockerfile:1
#
# Self-hosted Gubbins — the PWA, built and served from your own hardware.
#
# WHAT THIS DOES AND DOES NOT CHANGE
#
# This image serves the same browser app the hosted build serves. Your data still lives
# in *your browser's* OPFS storage, exactly as it does on the hosted site — this is not a
# server-backed deployment, and it does not raise the storage ceiling, change how photos
# are compressed, or store attachment files. What it does buy you:
#
#   * Real COOP/COEP response headers, so the `coi-serviceworker` polyfill that GitHub
#     Pages forces is no longer load-bearing (see docker/nginx.conf.in).
#   * A configurable base path, instead of the hard-coded `/Gubbins/` Pages needs.
#   * Hosting on your own LAN, with no dependency on GitHub Pages — including air-gapped
#     networks.
#
# Build it from the REPOSITORY ROOT:
#
#   docker build -t gubbins .
#
# To serve it under a sub-path instead of the domain root:
#
#   docker build --build-arg GUBBINS_BASE_PATH=/gubbins/ -t gubbins .
#
# Then run it (the app is entirely static — no token, no volume, no state):
#
#   docker run --rm -p 8080:8080 gubbins
#
# See docker-compose.yml to run it alongside the optional bridge.

# ---------------------------------------------------------------------------
# Stage 1 — build the static bundle.
# ---------------------------------------------------------------------------
FROM node:24-slim AS build

WORKDIR /app

# Playwright is a devDependency used only by the browser smoke tests; its postinstall
# would download several hundred MB of browsers that this image never runs.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV CI=1

# Install dependencies from the lockfile first, so this layer is reused whenever only
# application source changed.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# `public/ocr/` is git-ignored (several MB of Tesseract binaries), so a fresh checkout has
# none of it. Building without this step produces an image whose on-device receipt/label
# OCR can never load — and says nothing, because the feature degrades gracefully when its
# assets are absent. `--require` makes a missing asset a hard build failure instead, which
# is what the published deploy does too (.github/workflows/deploy.yml).
RUN npm run ocr:assets -- --require

# Google Drive sync is compiled in only when a client ID is present; without one the app
# still builds and simply hides that sync provider. It is an OAuth *client* ID — public by
# design, not a secret — but it is still passed in rather than baked into the repo.
ARG VITE_GOOGLE_CLIENT_ID=
ENV VITE_GOOGLE_CLIENT_ID=${VITE_GOOGLE_CLIENT_ID}

# The base path is baked into every asset URL at build time, so it must be a build arg —
# it cannot be changed when the container starts. Normalisation matches src/base-path.ts.
ARG GUBBINS_BASE_PATH=/
ENV GUBBINS_BASE_PATH=${GUBBINS_BASE_PATH}
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2 — serve it.
# ---------------------------------------------------------------------------
# The unprivileged nginx image listens on 8080 and runs as a non-root user out of the
# box, rather than needing the standard image's root master process.
FROM nginxinc/nginx-unprivileged:alpine AS runtime

ARG GUBBINS_BASE_PATH=/

# The base-path shell below needs to write into /usr/share/nginx and /etc/nginx; the base
# image has already dropped to uid 101, so step up for the build and drop back after.
USER root

COPY --from=build /app/dist /tmp/dist
COPY docker/nginx.conf.in /etc/nginx/conf.d/gubbins.conf.in

# Place the bundle at the base path it was built for, and stamp that same path into the
# nginx config, so the two can never disagree. The normalisation mirrors resolveBasePath()
# in src/base-path.ts: strip surrounding slashes, then re-add exactly one of each.
RUN set -eu; \
    inner="$(printf '%s' "$GUBBINS_BASE_PATH" | sed 's#^/*##; s#/*$##')"; \
    if [ -z "$inner" ]; then base='/'; else base="/$inner/"; fi; \
    mkdir -p "/usr/share/nginx/html$base"; \
    cp -a /tmp/dist/. "/usr/share/nginx/html$base"; \
    rm -rf /tmp/dist; \
    if [ "$base" = '/' ]; then redirect=''; else redirect="location = / { return 302 $base; }"; fi; \
    sed -e "s#__BASE__#$base#g" -e "s#__ROOT_REDIRECT__#$redirect#g" \
        /etc/nginx/conf.d/gubbins.conf.in > /etc/nginx/conf.d/default.conf; \
    rm /etc/nginx/conf.d/gubbins.conf.in; \
    nginx -t; \
    chown -R 101:101 /usr/share/nginx/html /etc/nginx/conf.d

USER 101
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD ["/bin/sh", "-c", "wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1"]
