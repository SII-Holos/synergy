# Synergy Link Rebrand Migration

This note covers the persisted-state and consumer cutover from MetaSynergy to Synergy Link protocol v2. For current behavior, see [Connections](../product/connections.md).

The repository retains the former `packages/meta-protocol` and `packages/meta-synergy` source trees for cutover reference. They are outside the root Bun workspace and are not release packages.

## Identifier and Package Changes

| Retired                        | Current                                |
| ------------------------------ | -------------------------------------- |
| MetaSynergy                    | Synergy Link                           |
| `meta-synergy`                 | `synergy-link`                         |
| `@ericsanchezok/meta-protocol` | `@ericsanchezok/synergy-link-protocol` |
| `@ericsanchezok/meta-synergy`  | `@ericsanchezok/synergy-link`          |
| `META_SYNERGY_HOME`            | `SYNERGY_LINK_HOME`                    |
| `~/.meta-synergy/`             | `~/.synergy-link/`                     |
| `envID` / `env_…`              | `linkID` / `link_…`                    |
| `meta.execution.request`       | `synergy_link.execution.request`       |

Protocol envelopes use `version: 2`, `requestID`, `linkID`, a typed tool/action, and strict schemas. Error codes use Link terminology such as `link_not_found` and `link_inactive`.

## State Migration

Synergy Link runs the `20260705-meta-synergy-to-synergy-link` migration before normal state hydration. It checks `META_SYNERGY_HOME` first; otherwise, migration from the default legacy directory occurs only when the destination is the default `~/.synergy-link` directory.

The migration:

- refuses to run while the recorded legacy runtime PID is alive
- refuses to merge legacy data into a populated destination without its migration manifest
- rewrites `envID` to a valid `linkID`
- resets connection and service state to stopped/disconnected
- copies the owner registry and migration log
- archives the old runtime log as `logs/legacy-runtime.log`
- imports legacy Holos credentials only when the shared destination has no credentials, then removes the duplicate legacy auth file
- records `migration-manifest.json`
- quarantines a partially written destination if migration fails

Stop the legacy runtime before first Synergy Link startup. Do not manually merge the two state directories.

## Tool Consumers

Use `linkID` for `connect`, remote `bash`, and remote `process` calls. Open an explicit Link session with `connect` before remote shell or process work.

Current Bash payload fields are `background` and `yieldSeconds`. Current process actions are `list`, `poll`, `log`, `write`, `send-keys`, `kill`, `clear`, and `remove`.

The Synergy Bash and process tool schemas still accept `envID` as a deprecated compatibility alias, but new code and stored calls should use `linkID`. An omitted Link ID intentionally selects local execution; an invalid or unavailable supplied ID produces a warning and follows the tool's documented local fallback. `connect` itself requires a valid `linkID` and never falls back locally.

## Protocol Consumers

Update imports to `@ericsanchezok/synergy-link-protocol`, emit v2 envelopes, and validate the strict request/result schemas. Do not preserve unknown v1 fields in v2 records.

Remote execution is classified as the non-bypassable `shell_remote_execute` capability when a valid Link target is present. Permission and control-profile rules must allow that capability explicitly.
