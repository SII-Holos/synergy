# Connections

Email, Channels, Holos and GitHub domains, each including its service, tools, routes, configuration, storage and commands.

Keep Email tool and HTTP operations on the same service. Preserve ChannelHost Scope/Session ownership and provider lifecycle; do not create parallel session models.

Cross-package imports use the explicit entries in `package.json`. Tests and fixtures belong in this package’s `test/` tree. Full API composition tests belong in `product-runtime/test/`.

Run `bun run typecheck`, `bun run test`, and `bun run test:coverage` from this package. Build an importable library with `bun script/build-workspace.ts packages/connections` from the repository root; `bun script/pack-workspace.ts packages/connections .artifacts/packages` builds its workspace dependency closure.
