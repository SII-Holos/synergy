# Decision Record: Bounded cooldown for a first credential rejection

Status: implemented

## Problem

One 401 from a provider was enough to record its stored credential as `dead` with `failureCode: "credential_rejected"` (issue #1413). Because a dead pool entry is no longer selectable, later requests carried no credential at all and kept failing with 401-shaped errors: the first failure became self-sustaining and the provider — including the session's selected model — stayed broken until a human rewrote the credential or reconnected. The configured environment fallback was never consulted, and the reported `action_required` health gave no hint that a working key was still available. Control measurements showed the same key succeeding end to end outside Synergy, so the rejections were transient gateway noise, not genuinely invalid credentials.

## Decision

An unclassified 401 is now treated like a rate limit: bounded cooldown, escalating to dead only after repeated rejections within a window, plus success reactivation.

- The generic 401 classification in `ProviderAuthRecovery` returns `credential_rejected` with a `rejectedAt` anchor. A credential pool entry gains an optional `rejectedAt` field, so the cooldown anchor persists across processes and reloads.
- `Auth.markRejected` records the first rejection as `exhausted` with a bounded cooldown (default 60 s, honor `retry-after`/`retry-after-ms` but capped at 600 s) instead of `dead`. The credential is still selected once the cooldown elapses.
- A second rejection recorded only after that cooldown has elapsed, and within a 30-minute escalation window, marks the credential `dead`, triggers the provider reload, and surfaces `action_required` with the existing reconnect UX. A burst of concurrent 401s cannot escalate because they arrive inside one cooldown. A rejection after the window has expired restarts the cooldown rather than killing the credential, so a genuinely broken key still converges to `action_required` at the next boundary.
- A successful request through a rejected-and-selected credential calls `Auth.markRecovered`, which restores `active` and clears the rejection anchor and cooldown, so one good response fully reverts the state.
- While a stored credential is cooling, a 401 that arrives with no selectable credential observes a bounded `exhausted` health instead of the terminal `action_required` observation, and missing-credential errors during that cooldown do not overwrite the observation — this breaks the self-sustaining loop where the absence of a credential produced the next 401 that justified the first one.
- Confirmed rejections keep the old immediate-dead semantics: provider-profile classifiers and thrown errors with `reloginRequired` (grok, codex, minimax, anthropic, plugin providers, refresh-confirmed rejections) go straight to `markDead`, because those paths verified the rejection beyond a bare status code.

## Alternatives considered

- **Never disqualify on 401** — rejected: a genuinely revoked key would then retry forever, hiding a required reconnect behind unbounded failures; repeated rejections must still converge to `action_required`.
- **Retry the same credential immediately on 401** — rejected: the response already told us the credential was refused; retrying without new information burns request budget and the issue asked for 429-style bounded cooldown semantics, not an extra same-request attempt.
- **In-memory cooldown only (no `rejectedAt` on the pool entry)** — rejected: the observed incidents followed provider reloads; an in-process anchor would not survive the reload that accompanied the failure and would let the escalated state re-arm after a restart.
- **Consult the environment fallback when the stored credential is rejected** — rejected for this change: the environment resolution is owned by profile `env` wiring, and mixing a silent credential-source switch into the recovery path would change which key bills usage without user-visible accounting. The cooldown instead keeps the stored credential selectable so the existing resolution keeps working.

## Consequences

A single transient 401 now costs one bounded cooldown (up to 600 s worst case) instead of a persistent provider-wide outage, and any later success fully restores the credential with no human intervention. Genuinely dead keys still reach `action_required` within roughly one cooldown cycle plus one retry boundary. `PoolEntry` gains an optional `rejectedAt` field; the store schema stays backward compatible because the field is optional and legacy entries without it behave exactly as before. The `exhausted` health state now covers auth rejections during cooldown, which is visible in the UI as a temporary, self-healing condition rather than a reconnect prompt.
