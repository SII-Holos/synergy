# connections Package

Assembly and import-compatibility facade for Channels, Feishu Channel, GitHub, GitHub Channel, Holos, Clarus Channel and Email. `./component` exports `connectionComponents()` returning the independent leaf factories. This package owns no resident service, HTTP registration, worker selection, domain configuration or migration execution.

Keep compatibility exports pure and point them to declared public leaf exports. Never recreate a single factory that silently registers all leaves, and never infer cross-owner bridges from installed packages. Published preset metadata must match the factory array; full product bridge selection belongs to Presets.

Leaf behavior tests belong to their owning package. Keep only cross-owner assembly and compatibility checks here. Run `bun run typecheck`, focused package tests and the root installed-composition and dependency checks when facade exports change.
