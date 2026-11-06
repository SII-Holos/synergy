# Decision Record: Remove the unreachable ExecPolicy rule engine

Status: implemented

## Problem

`packages/harness/src/enforcement/exec-policy.ts` carried a rule engine — prefix rules, network rules, approval-mode parsing, and a `KNOWN_SAFE` / `KNOWN_DANGEROUS` allow/ask/deny heuristic — reachable only through `GateOptions.execPolicy`. The gate consumed it at `evaluate()`: an `allow` rule short-circuited to an allow envelope, a `forbid` rule produced a `shell_hardline` refusal, and an `ask` rule forced the decision to `ask`.

No caller ever populated that option. The three production construction sites — `session/tool-resolver.ts`, `enforcement/policy-worker/runner.ts`, and `plugin-host/src/plugin/host-services-runtime.ts` — all construct the gate without it, and no configuration path supplies rules. The engine was therefore unreachable, while two test files (`exec-policy.test.ts` and `exec-policy-gate.test.ts`, 344 lines together) maintained it and eight exported symbols carried it in the module's public surface.

The option also implied a capability the product does not have: a Codex-style prefix allowlist that could authorize a bash command before classification. That is a second authorization path beside the profile ruleset, and nothing implemented it.

## Decision

The rule engine is deleted. `exec-policy.ts` exports exactly the refusal-amendment factory and its type: `ExecPolicyAmendment` and `generateAmendmentForCapability`. `GateOptions.execPolicy` and the `evaluate()` short-circuit it gated are removed, so admission flows through one path — capability classification, then the profile ruleset.

`generateAmendmentForCapability` stays because it is reachable: an `autonomous` denial attaches a profile-transition suggestion so the refusal tells the operator how the operation could be authorized. It still returns no amendment for `shell_hardline`, which no profile can bypass. Its name and the `{ type: "execPolicy", commandPrefix }` wire shape are unchanged because an approval response can echo the amendment back, so the discriminator is part of that contract; the module is retained rather than renamed so nothing that references the amendment type has to move.

## Alternatives considered

- **Implement the prefix-rule path instead of removing it.** Rejected: nothing asks for it. A second authorization path beside the profile ruleset would need its own persistence, precedence, and audit semantics, and it would let a rule authorize a command that classification never saw — the opposite of the ownership rule that the classifier decides and the profile layer authorizes.
- **Keep the engine as configuration-without-callers for a future Codex-parity feature.** Rejected: unreachable code is not staged capability, it is maintenance cost and a false signal. The decision record that introduced the module is superseded by this one; if prefix rules are wanted later, they should be designed against the profile layer rather than revived around a constructor option that nothing reads.
- **Delete the module entirely, including the amendment factory.** Rejected: `generateAmendmentForCapability` is reached from `Envelope.refusal.amendment` on every autonomous denial, and the amendment's `type` discriminator is echoed by an approval response, so removing it would drop a live refusal affordance and change a wire shape.
- **Keep the `KNOWN_SAFE` / `KNOWN_DANGEROUS` table as a classifier input.** Rejected: it is policy-layer vocabulary (`env`, `find`, `which`), not classification. The earlier read-only-catalog record rejected the same merge for the same boundary reason, and the classifier's decisions now come from tokenized operands and the git/gh taxonomy rather than a command-name allowlist.

## Consequences

Removing the option and its short-circuit means the gate has one admission path, so the `allow`-without-capabilities envelope it could produce no longer exists; every allowed decision now carries the capabilities that were classified, which is what the audit record and the sandbox's approved-path accumulation already assumed. Eight exported symbols and 344 lines of tests are gone, along with the module's implied but unimplemented prefix-rule capability.

The cost is that Codex-style prefix rules are no longer approximated anywhere. Reintroducing them is a design decision about the authorization layer, not a matter of re-adding an option, and this record exists so the next reader does not treat the deletion as an oversight.
