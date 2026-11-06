# Decision Record: Keep Execution Host native resolution inside its image

Status: implemented

## Problem

The bundled Docker supervisor starts a separate Bun worker without inheriting the parent's `--no-install` flag. Without a local `node_modules` directory, native package lookup can download a newly published package into private state. That filesystem is deliberately `noexec`, so loading its shared library fails before command execution. The failure appeared in real Docker lifecycle, PTY and recovery tests after native packages became available.

## Decision

Create an empty immutable `node_modules` directory beside the bundled image entrypoints. Bun's [documented resolution rule](https://bun.sh/docs/runtime/auto-install) then retains local dependency lookup, allowing the existing native-library resolver to use the image's copied library. Keep the read-only root, private `noexec` state, user identity, capability removal and sandbox policy unchanged.

Only the separately built Docker recipe changes. It is absent from npm module archives and CLI/Desktop runtime assembly, so this correction does not replace an immutable package or alter retained native release artifacts.

## Alternatives considered

**Make private state executable.** This weakens an existing boundary and still allows runtime dependency downloads.

**Rely only on the parent Bun flag.** The worker is a new Bun invocation and does not inherit that command-line option.

**Change the shared native resolver or worker launcher.** Image assembly owns the missing local-resolution boundary; changing already published module code is unnecessary.

## Consequences

The image stays independent of registry visibility at runtime. Existing Docker command, PTY, Workspace save and recovery integration tests cover the observed failure and continue to require the same containment behavior. Native selection fixtures use the same local-resolution boundary so newly published npm packages cannot replace their explicitly staged ABI fixtures.
