# Decision Record: Generate product icons from one canonical source

Status: implemented

## Problem

Synergy's product icon was copied independently into Web, shared UI, notification, social, and Desktop platform formats. Those copies could retain an older panda, inconsistent edges, or a different resolution after a partial replacement.

## Decision

The transparent 1024×1024 product icon in `packages/ui/src/assets/brand` is the only visual source. The root brand generator derives every committed Web, shared UI, notification, social, and Desktop PNG plus the Web favicon formats. Its read-only check is part of the static gate cluster.

Desktop packaging consumes the generated PNG directly and lets electron-builder create platform-specific application formats. Prebuilt ICNS, ICO, and Linux icon directories are not committed. Product screenshots remain historical documentation and are not generator outputs.

## Alternatives considered

**Keep replacing binaries manually.** This preserves the smallest script surface but cannot prove that all formal icon copies came from the same artwork or prevent platform drift.

**Commit every Desktop platform format.** Prebuilt formats avoid conversion during packaging, but duplicate the same visual source across opaque binary containers and recreate the drift this decision removes.

**Regenerate the panda for each target.** Model-generated variants can change anatomy, styling, or sunglasses between sizes. Deterministic resizing preserves the approved artwork instead.

## Consequences

Brand changes now require updating one transparent source and running `bun run brand:gen`. The repository carries a small generator and social-card template, while electron-builder conversion remains part of platform packaging. Static checks fail when a derivative is missing, stale, or when a retired Desktop icon source reappears.
