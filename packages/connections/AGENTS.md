# connections Package

Email, Channels, Holos and GitHub domains, each including its service, tools, routes, configuration, storage and commands. Keep Email tool and HTTP operations on the same service. Preserve ChannelHost Scope/Session ownership and provider lifecycle; do not create parallel session models. Read the root AGENTS.md and the owning architecture document before changes.

- Keep domain tools, routes, configuration and migrations with their implementation.
- Own configuration schemas, normalization, reference checks and secret handling in `src/config-schema.ts`; consumers use its typed reader and the host composes its registration.
- Import other packages only through declared public exports; preserve cancellation, permissions and persisted data.
- Own Holos CLI and SVG raster asset staging under `script/`, including SVG fonts and notices. Product packaging consumes these public helpers. Expose GitHub watch and Boss account facts through `workflow-settings`; the product connects them to Workflow ports.
- Tests live under test/ and use isolated homes through the testing support package.

Run bun run typecheck and the affected tests, then the root package and dependency checks.
