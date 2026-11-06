FROM node:22.14.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git python3 ripgrep ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY names.mjs ./names.mjs
RUN git init --quiet && git add names.mjs && git -c user.name=Fixture -c user.email=fixture@example.test commit --quiet -m fixture
