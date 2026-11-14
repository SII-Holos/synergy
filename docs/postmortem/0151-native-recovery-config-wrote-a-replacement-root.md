# Native recovery configuration wrote a replacement root

## Executive summary

An isolated recovery test replaced the target root immediately before its configuration write. Readiness failed, but the replacement directory had already received the restored settings. Publication must bind the filesystem effect to an opened directory, rather than rely on a later identity check.

## Summary

The service recovery coordinator committed a new deployment and retained its maintenance hold correctly. Its native completion then used absolute-path directory creation and atomic file replacement. That protected the destination from partial file contents, but did not preserve which directory owned the destination.

## Timeline

Review added a real root substitution at the configuration write boundary. The replacement contained a distinct configuration value. The original implementation overwrote it before rejecting the native Home check. Descriptor-relative publication preserved the replacement value and retained the actual original target. Native tests also exposed an incorrect variadic FFI call on Darwin: the file mode was not passed through the platform's variadic convention. The existing C bridge now supplies that convention explicitly.

## Root cause

Path validation and a later absolute-path replacement did not describe one filesystem object. Configuration may be absent at H0, so opening an existing destination descriptor could not cover every installation. An atomic rename alone prevented partial data, but could still rename into a substituted directory.

## Resolution

The Local file owner opens the original root descriptor. The domain then verifies its actual opaque publication permit before effects. Relative directory opening, creation, temporary writing and replacement use retained directory descriptors. Temporary files are synchronized before replacement and directories afterward. Failure preserves the old destination and cleans only that operation's temporary entry. Accepted work drains before its descriptors close. Native target preparation checks platform support before Source retirement; unsupported platforms cannot proceed to that irreversible step.

## Guardrails

The service fixture substitutes the real root, observes the actual Home owner's refusal, and checks that replacement configuration retains its original value. The original root is restored during test cleanup so the original native lock can be released. Local tests verify descriptor-relative replacement, original file permissions, failed replacement cleanup, symlink refusal, escaped-token refusal and accepted-work drainage in both JIT modes. Existing installation tests still observe the format-three fence before the actual configuration effect through the new owner.

## Lessons

Filesystem atomicity and physical destination ownership are separate requirements. Retain the original directory across publication, including when the destination does not yet exist. Keep the C function's actual variadic calling convention when binding native creation APIs. See [service-only publication](../decisions/implemented/architecture/2026-11-12-publish-service-only-recovery-after-current-policy-and-native-completion.md).
