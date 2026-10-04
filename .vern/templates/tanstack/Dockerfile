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

# The server build bundles its npm dependencies (see vite.config.ts), so the
# image needs only the build output and the server script.
FROM oven/bun:1.4.2-alpine
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
COPY --from=build /repo/apps/{{ name | kebab_case }}/dist ./dist
COPY --from=build /repo/apps/{{ name | kebab_case }}/scripts/serve.ts ./scripts/serve.ts
USER bun
EXPOSE 3000
CMD ["bun", "scripts/serve.ts"]
