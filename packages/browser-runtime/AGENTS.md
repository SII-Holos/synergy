# browser-runtime Package

Browser backend state, page ownership, profiles, tools, routes, installation, lifecycle, and recovery. Keep one page per session. Native WebContentsView and WebRTC/data-channel modes are both supported. Browser cleanup consumes generic session terminal events; native hosting stays in apps/desktop and shared schemas in packages/browser. Read the root AGENTS.md and the owning architecture document before changes.

- Keep domain tools, routes, configuration and migrations with their implementation.
- Import other packages only through declared public exports; preserve cancellation, permissions and persisted data.
- Tests live under test/ and use isolated homes through the testing support package.

Run bun run typecheck and the affected tests, then the root package and dependency checks.

Independent hosts call `registerBrowser()` from `./register` before opening Harness, then connect `disposeBrowser()` to their runtime extension cleanup. Registration restores no page and launches no Chromium process; Browser sessions and pages remain lazy. Routes are a separate host transport contribution.
