# Decision Record: Preserve URL-keyed plugin preferences during runtime identity adoption

Status: implemented

## Problem

Plugin shell and skin selections are now keyed by the stable runtime identity so a server URL change does not create a new preference bucket. Existing browser state, however, may still contain a selection under the server URL key. Reading only the new key makes that installed state appear to reset after the identity migration.

## Decision

`createShellPreference` accepts an optional legacy server accessor. The stable runtime identity remains the write key and takes precedence when it already has a selection; the URL key is read only as a fallback for the shell and skin preferences owned by `PluginHostProvider`. A later selection writes the stable key, so the compatibility path converges without a storage migration.

## Alternatives considered

**Migrate every stored URL entry at startup.** Rejected because the host may not know which URL aliases refer to the same runtime, and an eager rewrite would mutate unrelated historical entries.

**Keep URL keys as the permanent preference identity.** Rejected because URLs can change while the runtime remains the same, which would make user selections unstable.

**Reset old selections and require users to choose again.** Rejected because the existing selection is valid and can be preserved with a narrow read fallback.

## Consequences

New selections and stable-key state use the runtime identity. Existing URL-keyed selections remain readable during rollout and converge when the user changes them. The compatibility lookup is limited to the host-owned shell and skin preferences; plugin definitions and other persisted state are unchanged.

## Verification

The preference unit test covers stable-key adoption with a URL-keyed stored selection, and the real packed-skin browser test passes after rebuilding the Web application.
