## Debugging

- Prefer testing the Synergy app through the server-served Web UI after building:
  `http://localhost:4096`.
- Only start the Vite dev server at `http://localhost:3000` when actively
  debugging frontend/HMR behavior. Do not leave it running by default.
- Do not restart unrelated app or server processes unless the current task
  requires it.

## SolidJS

- Always prefer `createStore` over multiple `createSignal` calls

## Tool Calling

- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
