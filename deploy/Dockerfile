# Aegis Gate escrow engine, for an always-on host (Railway or any Docker host).
#   docker build -f deploy/Dockerfile -t aegis-engine .
# Persistent state (deals, escrow wallets, relay certificates) lives on a volume at /data.

# ---------- build the Zcash and FROST tools from pinned sources ----------
FROM rust:1-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends cmake clang protobuf-compiler git \
    && rm -rf /var/lib/apt/lists/*
ENV CMAKE_POLICY_VERSION_MINIMUM=3.5 CARGO_NET_GIT_FETCH_WITH_CLI=true
WORKDIR /src

# frostd + frost-client (Zcash Foundation), same revision and lockfile as the local build.
RUN git clone https://github.com/ZcashFoundation/frost-tools.git \
    && git -C frost-tools checkout 06c0dbdbb1bac9b99cd255e74ba2f387c295e660
COPY deploy/frost-tools.Cargo.lock frost-tools/Cargo.lock
RUN cd frost-tools && cargo build --release --locked -p frostd -p frost-client

# zcash-devtool, ported to librustzcash 9c5705f for NU7.
RUN git clone https://github.com/zcash/zcash-devtool.git \
    && git -C zcash-devtool checkout 5a26ee854e634a4e88d1d79dab13f8fbb1eac6b8
COPY patches/zcash-devtool-nu7.patch /src/
RUN cd zcash-devtool && git apply --whitespace=nowarn /src/zcash-devtool-nu7.patch \
    && cargo build --release --locked

# aegis (escrow derivation, PCZT signing requests).
COPY Cargo.toml Cargo.lock /src/aegis/
COPY packages /src/aegis/packages
RUN cd aegis && cargo build --release --locked -p aegis-core

# ---------- runtime ----------
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends bash openssl ca-certificates python-is-python3 procps \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /src/frost-tools/target/release/frostd /src/frost-tools/target/release/frost-client /app/bin/
COPY --from=build /src/zcash-devtool/target/release/zcash-devtool /app/bin/
COPY --from=build /src/aegis/target/release/aegis /app/bin/
COPY apps/engine /app/apps/engine
COPY apps/web/protocol.js /app/apps/web/protocol.js
COPY poc/escrow.sh /app/poc/escrow.sh
COPY deploy/run.sh /app/run.sh
RUN chmod +x /app/run.sh /app/poc/escrow.sh /app/bin/*

ENV AEGIS_BIN=/app/bin \
    AEGIS_DEALS=/data/deals \
    AEGIS_SHARED_DIR=/data/work \
    AEGIS_SHARED=/data/work \
    HOME=/data/home \
    HOST=0.0.0.0 \
    NODE_ENV=production
CMD ["/app/run.sh"]
