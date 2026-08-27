# Decision Record: Persisted default workspace preference for new sessions

Status: implemented

## Problem

Creating a new session chat offered no durable way to prefer a worktree workspace. The backend defaulted `Session.create` to the main checkout (`packages/synergy/src/session/index.ts`), and the Web composer hardcoded `workspace: { mode: "current" }`, keeping any worktree choice only in a transient per-scope store that reset after each submit. Users who want every session isolated had to re-pick "Worktree" from the start-options menu for every conversation.

## Decision

The default workspace for new sessions is a persisted general-domain preference, `defaultSessionWorkspace: "main" | "worktree"` (optional, default `main`), following the established config-domain pattern:

- The key lives in `packages/synergy/src/config/schema.ts` (`Config.Info`) and is registered under the general domain (`00-general.jsonc`) in `packages/synergy/src/config/domain.ts`, so global/project fragment merging and project-level overrides work for free.
- Runtime reload classifies it as client-side (`RuntimeReload.CONFIG_CLIENT_SIDE`): the server runtime never reads it; only the Web composer consumes it.
- The Web session page resolves the preference (`sync.data.config.defaultSessionWorkspace`) with safe fallbacks — home scope or non-git directories always resolve to `main` — and feeds it into `defaultNewSessionWorkspaceSelection` (`packages/app/src/components/session/worktree-session.ts`). Precedence: explicit in-composer selection > current directory already being a worktree (`existing`) > persisted preference > `main`. A `worktree` preference yields `{ mode: "create" }`, reusing the existing two-step create-and-bind flow, its progress UI, and its failure handling unchanged.
- Settings → General exposes a two-option control (Main checkout / Worktree) wired through the standard settings form/patch pipeline; the settings catalog gains a "New Session Workspace" row and search aliases.
- SDK types, `packages/sdk/openapi.json`, and `docs/reference/configuration.md` are regenerated artifacts.

The backend `Session.create` path is deliberately untouched: programmatic and channel sessions keep main-checkout semantics, and session creation stays fast; worktree creation remains an explicit post-create step owned by the composer.

## Alternatives considered

**Frontend localStorage only** (the model-draft layer-1 pattern) was rejected: no project-level override, not shared across surfaces, and inconsistent with the canonical config-domain rule for durable preferences.

**Backend consult in `Session.create`** (auto-worktree for every entry point) was rejected for now: `POST /session` would synchronously run `git worktree add` plus worktree setup commands (minutes-scale), break the composer's staged progress UX, and silently change semantics for channel and programmatic sessions. Revisit only if non-Web entry points need the default.

**Persisting on the session record** was rejected as a layer mismatch: `session.workspace` is materialized runtime state; a default belongs in config above it, the same relationship `modelOverride` has to the `model` config key.

**A dedicated config domain file** was rejected: one optional key does not justify a new domain file.

## Consequences

Setting the preference to `worktree` changes the trust boundary of every new session started from the Web composer: worktree sessions intentionally lose trusted access to the main checkout, and each session accumulates a worktree plus branch that must be cleaned up via worktree removal. Home-scope and non-git projects are unaffected (preference resolves to `main`). Existing users see no behavior change until they opt in. A future backend-side default can build on the same key without schema changes.
