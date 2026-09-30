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
ENV NEXT_OUTPUT=standalone \
    NEXT_TELEMETRY_DISABLED=1
RUN bun run build
# The image runs on Alpine (musl), so sharp only ever loads its musl build;
# drop the glibc builds the standalone output also traced.
RUN find .next/standalone/node_modules -type d \( -name "sharp-libvips-linux-*" -o -name "sharp-linux-*" \) -prune -exec rm -rf {} +

# The standalone output mirrors the repository layout and carries only the
# files the server needs. The server writes its cache under .next, so the files
# belong to the user it runs as.
FROM oven/bun:1.4.2-alpine
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
COPY --from=build --chown=bun:bun /repo/apps/{{ name | kebab_case }}/.next/standalone ./
COPY --from=build --chown=bun:bun /repo/apps/{{ name | kebab_case }}/.next/static ./apps/{{ name | kebab_case }}/.next/static
COPY --from=build --chown=bun:bun /repo/apps/{{ name | kebab_case }}/public ./apps/{{ name | kebab_case }}/public
USER bun
EXPOSE 3000
CMD ["bun", "apps/{{ name | kebab_case }}/server.js"]
