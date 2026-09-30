# syntax=docker/dockerfile:1
# Production image for {{ name | kebab_case }}. Build it from the repository root,
# which holds the Bun workspace and the shared UI package:
#   moon run {{ name | kebab_case }}:docker
# or: docker build -f apps/{{ name | kebab_case }}/Dockerfile -t {{ name | kebab_case }} .
# Configure it at runtime with the variables from .env.example plus the shared
# ZITADEL_ISSUER, ZITADEL_PROJECT_ID, and REDIS_URL.

FROM oven/bun:1.4.2-alpine AS build
WORKDIR /repo
COPY . .
RUN bun install --frozen-lockfile --filter ./apps/{{ name | kebab_case }}
WORKDIR /repo/apps/{{ name | kebab_case }}
RUN bun run build
# The server bundle imports the app's npm dependencies at runtime; keep only those.
WORKDIR /repo
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules && \
    bun install --frozen-lockfile --production --filter ./apps/{{ name | kebab_case }}

FROM oven/bun:1.4.2-alpine
WORKDIR /repo/apps/{{ name | kebab_case }}
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
COPY --from=build /repo/node_modules /repo/node_modules
COPY --from=build /repo/apps/{{ name | kebab_case }}/node_modules ./node_modules
COPY --from=build /repo/apps/{{ name | kebab_case }}/package.json ./
COPY --from=build /repo/apps/{{ name | kebab_case }}/dist ./dist
COPY --from=build /repo/apps/{{ name | kebab_case }}/scripts/serve.ts ./scripts/serve.ts
USER bun
EXPOSE 3000
CMD ["bun", "scripts/serve.ts"]
