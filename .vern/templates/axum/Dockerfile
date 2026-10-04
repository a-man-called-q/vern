# syntax=docker/dockerfile:1
# Production image for {{ name | kebab_case }}:
#   moon run {{ name | kebab_case }}:docker
# or, from the repository root:
#   docker build -f services/{{ name | kebab_case }}/Dockerfile -t {{ name | kebab_case }} .
{% if worker %}# It serves only /healthz, for a probe, and needs no ZITADEL settings.
{% else %}# Configure it with ZITADEL_ISSUER and ZITADEL_PROJECT_ID, and mount the API
# application's key file at /run/secrets/zitadel-api-key.json.
{% endif %}
# Alpine's Rust targets musl, which links a fully static binary.
FROM rust:1.98.1-alpine AS build
RUN apk add --no-cache musl-dev
WORKDIR /src
# The Cargo workspace: its manifest and lockfile, the shared crates, and the APIs
# (Cargo reads the manifest of every member, though it builds only this one).
# Dockerfile.dockerignore keeps everything else out of the context. Cargo.lock
# pins every dependency; commit it after the first build of a new API, which
# adds the API to it.
COPY Cargo.toml Cargo.lock ./
COPY crates crates
COPY services services
# A smaller binary for the image only; `cargo build --release` elsewhere is unchanged.
ENV CARGO_PROFILE_RELEASE_STRIP=true \
    CARGO_PROFILE_RELEASE_LTO=true \
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release -p {{ name | kebab_case }} && \
    cp target/release/{{ name | kebab_case }} /usr/local/bin/{{ name | kebab_case }}

# CA certificates, time zones, and a non-root user; no shell or package manager.
FROM gcr.io/distroless/static-debian13:nonroot
COPY --from=build /usr/local/bin/{{ name | kebab_case }} /usr/local/bin/{{ name | kebab_case }}
ENV HOST=0.0.0.0 \
{% if worker %}    PORT=4000
{% else %}    PORT=4000 \
    ZITADEL_API_KEY_FILE=/run/secrets/zitadel-api-key.json
{% endif %}EXPOSE 4000
ENTRYPOINT ["/usr/local/bin/{{ name | kebab_case }}"]
