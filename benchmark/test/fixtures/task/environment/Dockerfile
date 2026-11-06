FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY provider.py start.sh /fixture/
ENTRYPOINT ["/bin/sh", "/fixture/start.sh"]
