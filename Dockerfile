# Dockerfile
# Multi-stage: builds the Angular editor → serves it from nginx under /editor/.
#
# Build context is the repository root. The image stands alone, but it is meant
# to sit behind virtual-lab's nginx (docker-compose.editor.yml there), which is
# what gives the editor the platform's origin — and with it /api/.

# ── Stage 1: build ────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

COPY app/package.json app/package-lock.json ./
# The engine arrives as a packed tarball; there is no registry to fetch it from.
COPY app/WebEngineTS-0.1.0.tgz ./

# `npm install`, not `npm ci`: the lockfile is generated on Windows and cannot
# record the optional native packages Alpine resolves instead.
RUN npm install --no-audit --no-fund --prefer-offline

COPY app/ .
RUN npx ng build --base-href /editor/

# ── Stage 2: nginx ────────────────────────────────────
FROM nginx:alpine
COPY --from=build /app/dist/browser /usr/share/nginx/html/editor
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
