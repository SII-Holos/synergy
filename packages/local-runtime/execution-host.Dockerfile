FROM rust:1.94.0-bookworm AS native
WORKDIR /build
COPY native/ .
RUN cargo build --locked --release

FROM oven/bun:1.3.14-slim
ENV BUN_INSTALL_CACHE_DIR=/var/lib/synergy-executor/bun-cache BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
RUN apt-get update && apt-get install -y --no-install-recommends bash ca-certificates git python3 ripgrep util-linux && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt/synergy/bin /workspace /var/lib/synergy-executor && chown 1000:1000 /workspace && chmod 700 /var/lib/synergy-executor
COPY --from=native /build/target/release/libsynergy_pty.so /opt/synergy/libsynergy_pty.so
COPY execution-host.js owned-worker.ts /opt/synergy/bin/
WORKDIR /workspace
EXPOSE 7443
ENTRYPOINT ["bun", "--no-install", "/opt/synergy/bin/execution-host.js"]
