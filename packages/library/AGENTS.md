# library Package

Knowledge storage, memory and experience retrieval, embedding, encoding, Chronicler, tools, routes, configuration and migrations. Register the capability explicitly. Model work must retain cancellation, usage, budget and execution provenance through Harness. Core context receives a typed contribution without owning retrieval policy. Independent hosts compose the package through `registerLibrary()` from `./register`; routes and CLI presentation are separate exports. Read the root AGENTS.md and the owning architecture document before changes.

- Keep domain tools, routes, configuration and migrations with their implementation.
- Own compiled embedding build plugins, ONNX shims and asset staging in `script/`; product packaging consumes the explicit script exports. Keep payload runtime paths stable and verify the compiled standalone probes.
- Own configuration schemas, normalization, reference checks and secret handling in `src/config-schema.ts`; consumers use its typed reader and the host composes its registration.
- Import other packages only through declared public exports; preserve cancellation, permissions and persisted data.
- Own Anima daily scheduling policy in `AnimaSchedule.create()`. Its named Agenda host interface is supplied by product composition; Library must not import Workflows to obtain the scheduler.
- Tests live under test/ and use isolated homes through the testing support package.

Run bun run typecheck and the affected tests, then the root package and dependency checks.

Independent hosts connect `disposeLibrary()` from `./register` to their runtime extension cleanup after execution and background jobs drain. It disposes embedding resources and closes the Library database; repeated disposal is safe.
