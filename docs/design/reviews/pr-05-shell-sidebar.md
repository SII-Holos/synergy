# PR 05 — Shell and sidebar hierarchy

## Intent

Make the sidebar feel like one navigation surface instead of a stack of competing cards. The active row now uses a quieter selected surface plus a thin focus rail, while the outer divider and header spacing recede.

## Changes

- Soften the sidebar divider using the existing border token.
- Reduce top chrome padding without changing the navigation structure.
- Reduce project/session fragmentation through consistent spacing and radius.
- Add a narrow active rail to project and session rows.
- Keep all focus, hover, collapsed, and responsive behavior unchanged.

## Review visual

See `assets/pr-05-shell-sidebar.svg` for the before/after strip.