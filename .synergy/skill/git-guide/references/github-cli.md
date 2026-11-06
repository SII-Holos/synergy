# GitHub CLI permissions and authentication

## GitHub CLI Permission Matrix

The permission system classifies `gh` commands before applying the active control profile. The table shows the base profile decision before user rules, approval cache, SmartAllow, GitHub authorization, or ordinary runtime failures.

| Command                              | Capability             | Guarded | Autonomous | Full Access |
| ------------------------------------ | ---------------------- | ------- | ---------- | ----------- |
| `gh pr view/list/status/checks/diff` | `shell`                | ⚠️ ask  | ✅ allow   | ✅ allow    |
| `gh pr create`                       | `shell_remote_publish` | ⚠️ ask  | ✅ allow   | ✅ allow    |
| `gh pr comment` / `gh pr review`     | `shell_remote_publish` | ⚠️ ask  | ✅ allow   | ✅ allow    |
| `gh pr edit` / `gh pr ready`         | `shell_remote_write`   | ⚠️ ask  | ❌ deny    | ✅ allow    |
| `gh issue view/list/status`          | `shell`                | ⚠️ ask  | ✅ allow   | ✅ allow    |
| `gh issue create/comment`            | `shell_remote_publish` | ⚠️ ask  | ✅ allow   | ✅ allow    |
| `gh issue edit/close/reopen`         | `shell_remote_write`   | ⚠️ ask  | ❌ deny    | ✅ allow    |
| `gh pr merge/close/reopen`           | `shell_destructive`    | ⚠️ ask  | ❌ deny    | ✅ allow    |
| `gh api <endpoint>` (GET, no fields) | `shell`                | ⚠️ ask  | ✅ allow   | ✅ allow    |
| `gh api -X GET` / `-X HEAD`          | `shell`                | ⚠️ ask  | ✅ allow   | ✅ allow    |
| `gh api -f/-F/--input` (auto-POST)   | `shell_remote_write`   | ⚠️ ask  | ❌ deny    | ✅ allow    |
| `gh api -X POST/PATCH/PUT/DELETE`    | `shell_remote_write`   | ⚠️ ask  | ❌ deny    | ✅ allow    |
| `gh api graphql` (mutation possible) | `shell_remote_write`   | ⚠️ ask  | ❌ deny    | ✅ allow    |

Read-only `gh` commands sit at the `shell` risk floor rather than a read-only tier: there is no `shell_read` capability, because a shell command string carries no precise input for the gate to reason about. Every `gh` command also carries `network_request`. Under `guarded`, `network_request` alone is allowed but `shell` is a medium capability outside the allowed set, so the combination asks; `autonomous` allows both. Use the table as the base profile decision — it is not the resolved one.

Checkout type does not change ordinary `shell_remote_publish` into `shell_remote_write`. Unknown write-capable `gh` subcommands default to `shell_remote_write`. Full Access silently allows permission-system capabilities but does not override task authorization, protected-branch rules, GitHub permissions, validation failures, or network/runtime errors.

## Bash tool GitHub CLI credential injection

When a bash tool invocation contains a `gh` command and no `GH_TOKEN` or `GITHUB_TOKEN` is already present in the child environment, the local backend injects the managed GitHub credential (from `GH_TOKEN`/`GITHUB_TOKEN` env or the Synergy auth store) as `GH_TOKEN` in the child process environment.

Behavior:

- The token is passed through the environment only — it never appears in the
  command string, argv, or process listings.
- Injection applies to any invocation that contains at least one `gh` command,
  including mixed, chained, and piped commands (`echo ok; gh api user`, `gh repo view owner/repo | head`).
- The injected `GH_TOKEN` is inherited by every process in the invocation —
  any command can read it via `$GH_TOKEN`. An explicit `GH_TOKEN=...` prefix assignment or `export GH_TOKEN=...` earlier in the command takes precedence; use `env -u GH_TOKEN <cmd>` to clear it for a single command. An explicit `GITHUB_TOKEN=...` does not override the injected `GH_TOKEN`, because gh prefers `GH_TOKEN`.
- When no Synergy GitHub credential is connected, the invocation runs without injection or an output notice. The CLI can use its own stored login; the macOS sandbox permits the native Keychain service lookup described in [Execution boundaries](../../../../docs/architecture/execution-boundaries.md#sandbox-enforcement).
- If a credential is injected, telemetry emits `bash.github.token.injected`;
  if injection is skipped, `bash.github.token.skipped` records the reason.

For a host login that fails only inside the macOS sandbox, inspect injection metadata and correlate the reproduction with kernel `mach-lookup` denials for `com.apple.SecurityServer`, including the CLI's credential-helper subprocess. The Bash denial collector filters out Mach lookups and selects the direct child PID, so an empty collected denial is not evidence that native auth succeeded. Keep credential output discarded; use [Find logs](../../find-logs/SKILL.md) for isolated reproduction and redacted evidence.
