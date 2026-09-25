# Managed SDK startup

The SDK now requires an explicit managed or attach mode. This is part of the next major package contract.

Replace `createSynergyServer()` with managed options containing the absolute executable, exact version, data home and component selection, or attach to an existing URL. Managed startup invokes `server`, uses a dynamic loopback port and authenticates with a private per-process credential. Use the client returned by `createSynergy()` or pass the returned `headers` into `createSynergyClient()`. Await `server.close()` to drain the owned process.

The old `createSynergyTui` helper is removed: the installed product has no TUI command matching that helper's flags. Use the supported CLI command or the SDK's session methods. Existing HTTP-only clients retain their constructor and generated methods.

See [Embedding](../reference/embedding.md) for current examples and the readiness/ownership contract.
