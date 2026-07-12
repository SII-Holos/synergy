# Frontend Context Domains

State providers stay at the narrowest route that owns their lifetime. Larger
domains keep their provider entry point, pure models, migrations, and tests in one
directory:

- `layout/` — global layout state, navigation projection, scroll persistence, and workspace sizing
- `workbench/` — panel registry state, tab model, and persisted layout migration
- `terminal/` — PTY session state and working-directory resolution
- `file/` — Scope-owned file documents, Explorer caches, watcher reconciliation, and file view state
- `prompt/` — prompt state, sanitization, composer intent, and model-variant persistence

The context root is reserved for small cross-cutting providers. Domain code should
import the public directory entry point and use a direct submodule path only for a
pure model that is intentionally shared outside its provider.
