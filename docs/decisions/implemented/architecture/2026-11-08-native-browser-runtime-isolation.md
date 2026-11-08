# Decision Record: Isolate native Browser identities by their owning Runtime

Status: implemented

## Problem

Multiple local Runtime brokers share one Electron application and page pool. Runtime-local owner, page and profile identifiers can collide. Using those identifiers directly would let unrelated hosts share native pages or Chromium partitions, and comparing only a profile ID would keep one member's temporary data alive because another member has the same ID. Per-host page limits also cannot enforce the Desktop's total capacity.

## Decision

The broker accepts an optional Runtime key selected by main. For member brokers it hashes the Runtime key with each canonical owner key or partition before passing it to native owners. It preserves persistent versus temporary partition lifetime. Personal brokers retain their exact existing keys and partitions, so established website identities need no migration. Protocol responses, popup attribution and events keep the original server identities.

Profile-data preparation, release, clearing, outstanding import drains and saved data use the same native mapping. Each broker receives its own profile-data context registry. Native pages from every broker share one pool, which reserves the global 64-page limit before asynchronous creation. Temporary cleanup compares physical partitions rather than Runtime-local profile IDs.

## Alternatives considered

**Require globally unique IDs from every server.** Server IDs describe their own catalogs. Main must isolate native resources even when two hosts choose the same valid identifiers; identifier conventions cannot supply that guarantee.

**Give each Runtime an independent native page pool.** Separate pools would lose the shared Desktop capacity and presentation owner. Namespaced keys let the existing pool continue owning native lifecycle and recovery.

**Rename all personal partitions.** This would unnecessarily move existing website state. An absent Runtime key preserves personal identities exactly, while explicit member keys establish new isolated partitions.

## Consequences

Browser cookies, localStorage, saved data and page destruction remain scoped to their native Runtime. Broker behavior tests exercise duplicate IDs, canonical event routing, revocation and pending import cancellation; native Electron tests exercise actual storage, reuse, restart, independent closure and temporary cleanup. This mapping supplies the native adapter capability; member composition, main-owned broker startup and organization presentation must select it explicitly. It does not enable member execution or add a renderer-selected partition.

Native smoke fixtures use a unique Electron application name as well as userData, so OS encryption cannot reuse another application's keychain identity. Cleanup removes only that fixture's named Safe Storage item and waits for its process to exit before deleting files.
