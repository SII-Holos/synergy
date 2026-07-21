# Frontend Component Domains

Product components are grouped by the surface or domain that owns their behavior:

- `app-shell/` — desktop and mobile application chrome
- `session/` — conversation, Context, progress, and Session-only controls
- `workspace/` — shared Side Workspace shell and built-in panel registration
- `file-workbench/` — file tabs, viewer, source mode, previews, and Explorer
- `prompt-input/` — composer UI and submission behavior
- `status-bar/` — status bar, Context status button, indicators, and runtime state
- `note/`, `library/`, `agenda/`, `performance/`, `settings/` — product domains
- `dialog/` — reusable modal workflows

The component root is reserved for primitives that are genuinely shared across
multiple product domains. New product features should use a named domain directory
with a small `index.ts` only when a public import boundary is useful.
