# Multi-stage image for enterprise / Helm deploys of rivetd.
FROM rust:1.86-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN cargo build -p rivet-runtime --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/rivetd /usr/local/bin/rivetd
ENV RIVET_DATA_DIR=/data
EXPOSE 8741 8742
VOLUME ["/data"]
ENTRYPOINT ["/usr/local/bin/rivetd"]
