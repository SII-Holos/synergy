# Linux controlled TMP hid an admitted Workspace

## Executive summary

Linux sandbox commands with an admitted Workspace below `/tmp` failed before their child payload. The final controlled-TMP mount hid the physical cwd. Restore only authorized strict subroots with their effective policy while keeping broad host temporary data isolated.

## Summary

Observed cold native recovery and external-token cases advanced beyond target temporary-directory preparation, then stage two reported `Failed to exec /bin/sh: No such file or directory`. This identifies those cases, not every Runtime failure. The [missing Session directory incident](0198-target-sandbox-missed-controlled-session-temporary-directory.md) is separate: its approved directory did not exist on the target; this incident concerns an existing directory hidden inside the sandbox mount view.

## Timeline

The earlier directory-preparation correction exposed the later command failure. Source inspection found the admitted physical cwd below `/tmp`, followed by a controlled ancestor bind. An initial repair draft moved that overlay before writable mounts; review rejected it because a subsequent writable `/` or `/tmp` exposed host temporary files. The exact-subroot policy counter failed against the original helper. After the scoped correction, the complete 37-test `bwrap::tests` module passed on macOS. That result proves pure policy and compilation, not Linux kernel execution.

## Root cause

The original plan mounted the Workspace and its restrictions, then bound `<workspace>/.synergy/tmp` at `/tmp`. That final ancestor mount hid every earlier `/tmp/...` Workspace bind. Rust's `Command.current_dir(cwd).exec()` reports chdir and exec errors through the same wrapper, so the error did not establish that `/bin/sh` or its ELF interpreter was missing. The real-helper fixture used only a cwd outside `/tmp`, leaving this directory placement untested.

## Guardrails

The controlled overlay still follows broad roots. Reconstruction never appends `/` or `/tmp`; it requires declared read or write authorization for each exact strict subroot. The last original ancestor controls visibility and mode, with later local overlays retained. Effective ancestor and descendant denies, protective read-only mounts and glob covers cannot be bypassed, while the original explicit deeper-writable exception remains available. The original selected Executor, operation, policy receipt and cleanup remain unchanged. The [decision](../decisions/implemented/architecture/2026-11-12-retain-native-environment-operation-origins.md) records the rationale.

- [x] Machine check: Linux helper `bwrap::tests::controlled_tmp_restores_only_precise_authorized_children_after_writable_ancestors` failed against the original plan; all 37 `bwrap::tests` pass after the correction on macOS, including original deny, protected-path and glob policies.
- [ ] Machine check: `packages/local-runtime/test/sandbox/linux-readable-roots.test.ts`, selector `real helper executes a selected native child`, must execute all nine cases on Linux with the rebuilt matching helper. They retain physical cwd, mode-appropriate file effects, direct and symlink denies, unchanged host-TMP sentinel bytes, controlled temporary writes and original preparation release.
- [ ] Machine check: original cold native recovery and external-token cases must pass through the actual Linux helper before those Runtime scenarios are accepted.

## Lessons

Distinguish a missing target filesystem input from an existing input hidden by a later mount. Test actual temporary placements and broad writable ancestors together. A directory moved outside the failing namespace or a passing pure mount plan cannot replace kernel execution evidence.
