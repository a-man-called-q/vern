# syntax=docker/dockerfile:1
# Production image for {{ name | kebab_case }}:
#   moon run {{ name | kebab_case }}:docker
# or: docker build -t {{ name | kebab_case }} apps/{{ name | kebab_case }}
# Configure it with ZITADEL_ISSUER and ZITADEL_PROJECT_ID, and mount the API
# application's key file at /run/secrets/zitadel-api-key.json.

FROM rust:1.98.1-slim AS build
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release && \
    cp target/release/{{ name | kebab_case }} /usr/local/bin/{{ name | kebab_case }}

FROM debian:trixie-slim
RUN apt-get update && \
    apt-get install --yes --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/{{ name | kebab_case }} /usr/local/bin/{{ name | kebab_case }}
ENV HOST=0.0.0.0 \
    PORT=4000 \
    ZITADEL_API_KEY_FILE=/run/secrets/zitadel-api-key.json
USER nobody
EXPOSE 4000
CMD ["{{ name | kebab_case }}"]
