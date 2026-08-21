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
  - Polling cost is per-entry and bounded by the configured interval (min 30s); unauthenticated setups never touch the API. State baselines are in-memory only — a restart re-baselines without firing, and the first post-restart poll of a previously-run item is a silent restore baseline.
  - `agenda_watch` with `onGithub` uses autoDone delivery into the origin session, matching the delay/session watch UX; after a successful fire the item is marked done and its poll registration is torn down. Agents cancel with `agenda_cancel`.
  - First poll of a repository-wide watch (no `number`) covers the 10 most recently updated items (issues fetch three pages then filter PRs). For **states-filtered** watches, items first observed in a targeted state (including brand-new items and already-satisfied conditions) fire immediately; **unfiltered** repository-wide watches baseline first observations silently, so a PR/issue created and merged entirely between two polls is first observed in its terminal state and does not fire — the tradeoff for not spamming all 10 recent items on registration. Point watches (`number`) always see transitions.
  - Per-entry polling baselines are bounded (256 entries) so repository-wide watches cannot accumulate memory for the lifetime of a trigger.
  - PR state is derived as `merged` (via `merged`/`merged_at`) > `closed` (terminal state wins over `draft`) > `draft` > `open`; workflow/check state is the run `status` (`queued`/`in_progress`/`completed`) with the `conclusion` carried separately (null normalized away), and the `states` filter matches either. `ref` targets a branch/tag/commit for workflow/check watches and is URL-encoded in the API path.
  - Repeated poll failures (5 consecutive) or `github.watch.enabled=false` after creation pause the item and release any continuation holding it (same hook as `Agenda.pause`); creation is rejected up front while the switch is off. Triggers without `interval` fall back to `github.watch.defaultIntervalMs`.
