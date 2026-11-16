FROM oven/bun:1.4.3-slim
ENV SYNERGY_HOME=/var/lib/synergy BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
WORKDIR /opt/synergy
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --chown=bun:bun node_modules/ ./node_modules/
COPY release.json ./release.json
RUN mkdir -p /var/lib/synergy/.synergy/config/synergy.d && chown -R bun:bun /var/lib/synergy
USER bun
VOLUME ["/var/lib/synergy"]
EXPOSE 4080
ENTRYPOINT ["bun", "--no-install", "/opt/synergy/node_modules/.bin/synergy-org"]
CMD ["--help"]
