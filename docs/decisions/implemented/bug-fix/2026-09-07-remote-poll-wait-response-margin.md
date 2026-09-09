# Decision Record: Remote blocking poll waits reserve the transport response margin

Status: implemented

## Problem

A healthy long-running remote process caused `process poll(block=true, timeout=30)` to fail as a transport timeout after ~30,011–30,469 ms with "The request was dispatched and its result is unknown." The Synergy Link host's blocking poll waited `min(max(timeout ?? 30, 1), 30)` seconds before returning a still-running result, while the sender's Holos transport arms a single 30,000 ms timer at dispatch. A process that stays alive for the whole wait consumed the entire end-to-end budget, leaving zero time for response delivery; a subsequent connect status verified the same collaboration session was still open, so the timeout did not establish connection or session death yet could push users to clear or reopen otherwise usable sessions. Remote bash already respected the deadline by clamping auto-background yields to five seconds; the blocking poll path had no such margin.

## Decision

Both sides now keep remote blocking-poll waits inside the transport deadline:

1. The host (`packages/synergy-link/src/exec/process-registry.ts`) caps blocking-poll waits at 25 seconds by default — the same five-second response margin remote bash yields reserve — regardless of the requested timeout. The cap is configurable per `ProcessRegistry`/`RPCHandler` (`maxBlockingPollMs`, exported as `ProcessRegistryOptions` and wired through `RPCHandlerOptions.registry`) so hosts with a different transport deadline can tune it and tests can exercise the ordering at millisecond scale.
2. The sender (`packages/runtime-local/src/tools/process/remote.ts`) clamps blocking-poll timeouts it sends to remote hosts at 25 seconds (defaulting omitted timeouts to 25 for remote polls) so even a host running an older binary that honors the full requested wait returns a still-running result inside the transport window.

An ordinary wait expiry returns a normal still-running result; process exit during the wait returns the terminal state; non-blocking polls remain immediate; real transport failures still reject as ambiguous without automatic replay. The wait is bounded at the start of remote handling so dispatch, handling, and network latency keep their share of the 30-second budget.

## Alternatives considered

- **Raise or remove the sender transport deadline.** Rejected: the deadline exists to surface liveness loss and bound ambiguous in-flight requests; lengthening it only postpones the same ordering problem and makes every genuinely dead transport wait longer.
- **Track a remaining budget from dispatch and echo it to the host.** Rejected as the initial fix: the wire protocol has no field for it, adding one changes the envelope contract and requires coordinated host and sender releases; the fixed 25-second cap delivers the same guarantee with no protocol change. A future remaining-budget field remains possible if the transport deadline ever becomes configurable end to end.
- **Sender-only clamping.** Rejected alone: the reported production hosts were not verified to run current upstream code, so the sender clamp must not depend on host behavior; the host cap is the authoritative fix for every caller of the RPC, including direct protocol consumers.
- **Return an error envelope instead of a still-running result on wait expiry.** Rejected: expiry of an ordinary poll wait is a normal outcome, not a failure; erroring would push callers toward the session-clearing and retry behavior the transport ambiguity path already misleads.

## Consequences

Bought: blocking remote polls now reliably return a still-running (or terminal) result before the 30-second transport deadline on both current hosts (host cap) and older hosts (sender clamp), the deadline-ordering convention for remote bash and process waits is unified, and the constant is overridable for hosts with different transport budgets. Regression coverage: host-side tests assert the cap applies to explicit and omitted timeouts, non-blocking polls stay immediate, exit-during-wait returns the terminal state, and a transport-level e2e reproduces the ordering with scaled timers and simulated request/response latency; sender-side tests assert the clamp and default. Cost: a remote blocking poll can now wait at most 25 seconds even when a caller requests 30 — callers who need a longer uninterrupted wait must poll again, which matches the pre-existing guidance to prefer shorter polls and other work between checks. Tool text, the qizhi runbook, and the builtin skill now state the 25-second remote cap.
