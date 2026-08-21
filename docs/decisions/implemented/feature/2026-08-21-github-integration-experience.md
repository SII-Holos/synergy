# Decision Record: GitHub integration experience (identity sync, silent gh CLI, agenda GitHub triggers)

Status: implemented

## Problem

The GitHub integration in Settings → Integrations had three experience gaps:

1. **No git identity management.** Users connecting GitHub had no entry point to align `git config user.name / user.email` with their GitHub account, no sync toggle, and no override fields.
2. **Noisy gh CLI injection.** When no Synergy GitHub credential was connected, every bash command containing `gh` was prefixed with `[GitHub CLI token skipped: ...]` output noise. The local `gh` CLI may be logged in on its own; the notice was wrong advice repeated on every invocation.
3. **No GitHub agenda hook.** Agents and humans could not ask "wake me when PR #N merges / workflow run fails / CI check completes" — the agenda system only had time, file, webhook, and session triggers.

## Decision

- **`github` config domain** (`config/schema.ts` `Github`, domain id `github`, file `115-github.jsonc`, key `github`) with two optional sections: `identitySync {enabled?, name?, email?}` and `watch {enabled? (default true), defaultIntervalMs?}`. Registered in `ConfigDomain.definitions` so settings save routing, import, and the Config Files panel work with zero route changes.
- **`GithubIdentity` service** (`provider/github-identity.ts`) reads git's global identity, derives the target identity (explicit `name`/`email` overrides win; otherwise the connected GitHub account's login + `{login}@users.noreply.github.com`), exposes `state()` with `pendingChanges`, and applies it through `git config --global` on explicit `sync()`. Routes `GET /provider/auth/github/identity` and `POST /provider/auth/github/identity/sync` serve the settings panel. Sync is user-initiated (button) — never a background loop that rewrites user config unattended.
- **Silent gh CLI fallback** (`tool/bash/local.ts`): when no managed credential resolves, the injection is skipped silently. The `bash.github.token.skipped` observability trace (level warn) remains for diagnosis; the agent-visible output notice is removed because a locally-logged-in `gh` keeps working and the notice repeated per command was pure noise.
- **Agenda `github` trigger source** (`agenda/types.ts` `TriggerGithub`, `agenda/github-trigger.ts`): `{type:"github", resource:"pr"|"issue"|"workflow"|"check", repository:"owner/repo", number?, interval? (default 5m, min 30s), states?}`. A fifth agenda trigger source polls the GitHub REST API per entry with the managed token, baselines states on the first poll (no fire), and fires a `FiredSignal` whose payload carries `{resource, repository, number, title, state, previousState, url, ...}`. Zero-cost idle: entries without a resolved credential or with `github.watch.enabled=false` schedule no API call. Exposed through `agenda_schedule` triggers and `agenda_watch`'s new `onGithub` option (delay xor onSessionEnd xor onGithub); dedup treats (resource, repository, number) as the structural key; `inferSessionMode` treats github triggers as recurring.

## Alternatives considered

- **Auto-sync git identity on every GitHub connect** — Surprising side effect on machine-level git config; the user may intentionally keep a different identity. Rejected in favor of an explicit toggle plus Sync-now button; `enabled` gates only the `pendingChanges` hint, while `sync()` is always explicit.
- **Inject a fake `gh` wrapper or shell function** — Fragile shell-path games and would shadow the real CLI. The existing env-based `GH_TOKEN` injection is kept; only the failure notice changed.
- **Reuse the GitHub channel's App-installation polling** — Requires SYNERGY_GITHUB_APP credentials and serves conversations, not agenda wake-ups. The agenda trigger reuses the user OAuth/PAT token from `GitHubProvider.resolveToken()`, matching what agents already use via gh CLI.
- **Webhook-based GitHub triggers** — No public webhook ingress for arbitrary repos without a GitHub App; polling with 5m default interval matches the existing channel's cadence and needs zero setup.

## Consequences

- Settings → GitHub gains "Git identity" (toggle + optional overrides + current/target summary + Sync now) and "Agenda GitHub watch" (global enable toggle) sections backed by the `github` config domain; the panel participates in the standard settings save flow.
- `SessionAgendaTriggerType` and the generated SDK/OpenAPI gained the `"github"` trigger variant; wake-indicator shows "On GitHub".
- Polling cost is per-entry and bounded by the configured interval (min 30s); unauthenticated setups never touch the API. State baselines are in-memory only — a restart re-baselines without firing.
- `agenda_watch` with `onGithub` uses autoDone delivery into the origin session, matching the delay/session watch UX; agents cancel with `agenda_cancel`.
- First poll of a repository-wide watch (no `number`) covers the 10 most recently updated items; newly created items after registration are picked up because their numbers are not in the baseline map (treated as fresh state transitions into their current state).

## Review follow-ups (PR #1234)

- `AgendaGithubTrigger.start()` arms before registering so items restored from storage poll immediately after a restart.
- `agenda_watch` `onGithub` one-shot items complete after their first successful fire: the reactor passes `autoDone` into `updateRunState`, which marks the item done (dropping it as a continuation blocker) — matching the delay/session watch UX.
- `interval` is validated by the trigger schema (`^(\d+)(ms|s|m|h|d|w)$`) before persistence; an invalid value can no longer poison `Agenda.start()`.
- GitHub-controlled fields (PR/issue titles) are attribute-escaped in the `<github-event>` prompt block.
- Transitions observed in one poll dispatch sequentially through a per-entry chain so the Agenda inflight guard cannot drop later changes; filtered-out transitions still advance the baseline.
- Poll failures auto-pause the item after five consecutive errors instead of retrying forever; detached entries (unregistered or stopped mid-request) are never rescheduled.
- Triggers without `interval` fall back to `github.watch.defaultIntervalMs` (the config key is now honored).
- Repository-wide PR watches detect merges via `merged_at`; workflow/check state is the run `status` (`completed` matches the documented filter) with the conclusion carried separately and the run URL included.
- Workflow/check targeting gained a `ref` field (branch/tag/commit) instead of overloading `number`.
- Identity derivation fetches the account for credentials without stored metadata (env tokens), so the derived identity is still available.
- Settings: blanking a name/email override sends an explicit `null` (schema nullable) so the merge actually clears it; Sync now flushes the pending github-domain draft first; the Refresh action and connect/logout callbacks also refetch identity state; the no-op sync toast uses the localized descriptor instead of the server reason string.
- Agent-facing tool descriptions (`agenda-watch.txt`, `agenda-schedule.txt`) and the synergy-config skill's domain table were updated with the new trigger/domain.
