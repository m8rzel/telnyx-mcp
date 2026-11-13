FROM node:20-alpine AS build

WORKDIR /app

# Dependencies first — this layer is only rebuilt when the manifests change.
# Every direct dependency is pinned exactly and the repository currently ships no
# lockfile (see README -> Development), so npm install is the working path today.
# Commit a package-lock.json and the build switches to the deterministic npm ci
# without any change here.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then \
      npm ci --no-audit --no-fund; \
    else \
      npm install --no-audit --no-fund; \
    fi

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json

# Unprivileged user that ships with the image (uid/gid 1000).
# If the host mount has a different owner, start the container with
# `--user $(id -u):$(id -g)` — see "File ownership" in the README.
USER node

# stdio transport: no port to expose, nothing a HEALTHCHECK could probe.
ENTRYPOINT ["node", "dist/index.js"]
