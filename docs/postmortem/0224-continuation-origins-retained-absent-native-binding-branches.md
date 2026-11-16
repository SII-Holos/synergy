# Continuation origins retained absent Native binding branches

## Executive summary

Two Environment handoff scenarios reached their original independent Continue, then rejected the first Hosted cloud execution while encoding its retained Native binding. The canonical origin helper returned both optional properties, leaving the absent branch as an own `undefined` value. Signed JSON hid that value, but the strict Native record codec correctly rejected it. The correction validates exclusivity first and emits only the present branch.

## Summary

A continuation has exactly one original Handoff or recovery publication. Its schema accepts either origin, and the helper selected only those known inputs. Constructing both properties before parsing nevertheless preserved the absent property as `undefined`. The Native cleanup owner spread that origin into `authority.control`; the Environment source retained that authority inside a binding whose persistence requires JSON data.

## Timeline

- The original Linux CI failed both complete Environment Main cases after 27 assertions, in 32.229 and 31.182 seconds. Each reported `ZodError` at `binding` with `Expected a JSON value`; neither 180-second whole-case guard fired.
- The assertions cover original Native tool completion, the complete first handoff, resource selection and accepted independent Continue. The next operation is the first Hosted cloud Bash invocation. The original reports contain no source stack, so this stage qualification is kept separate from a lower-level reproduction.
- Source tracing followed `continuationOrigin` through `Leases.reference`, the Organization Environment binding and `EnvironmentExecutionSource.Record`. The Workspace-file path serialized its authority before persistence and could hide the same absent branch; it did not validate this Environment path.
- The unchanged production helper failed the new Protocol JSON-data control and both extended real Native Handoff persistence cases. The latter reproduced the original `binding` / `Expected a JSON value` failure through signed Continue and the original temporary Store. After correction, official selected verification passed all seven files, 31 cases and 504 assertions, including both real Native persistence controls and both complete Environment scenarios. The latter completed in 47.050 and 37.415 seconds with unchanged assertions and guards. New-head CI remains a separate requirement.

## Root cause

The XOR refinement checks whether one value is present; it does not remove an explicitly supplied optional property. TypeScript's optional fields also do not guarantee that an in-memory value is JSON. The helper created both properties, and its callers correctly preserved their received authority. Handoff origins therefore carried `recovery: undefined`, while recovery origins carried `handoffID: undefined`. Canonical signature and cleanup-identity serialization already omitted those properties, so successful signing and transport did not expose the persistence defect.

The owning helper keeps its original known-field projection and strict XOR validation, then returns only the validated branch. It changes no route, DTO schema, reader floor, stored version or authority check. JSON wire and signature bytes remain unchanged. Native record validation remains strict, and no general serialization fallback is introduced.

## Guardrails

- [x] Machine check: `packages/organization-protocol/test/execution.test.ts` requires both origin branches to remain valid nested JSON with exact present keys and unchanged wire bytes; invalid neither/both origins and the existing strict-schema versus helper-projection distinction remain checked.
- [x] Machine check: `packages/organization-runtime/test/execution-handoff.test.ts` obtains the original signed Continue and actual Native binding proof in both existing source-cancel/target-activate cases, constructs `Leases.reference`, and writes/reads its canonical Environment source record through the original temporary Store.
- [x] Machine check: both complete `packages/organization-runtime/test/handoff-environment-main.test.ts` cases pass without changing their process, file, resource, permission, handoff or 180-second assertions and guards.
- [x] Machine check: owning Protocol/Runtime TypeScript and official selected canonical checks pass; prior successful subcases do not replace these results.
- [ ] Machine check: final CI at the published head passes, including complete package coverage and platform acceptance.

## Lessons

Validate persisted owner metadata before serialization can erase invalid in-memory values. Keep exclusive-origin validation ahead of projection, preserve original signing input bytes, and test the actual Native persistence boundary. The [original-root continuation decision](../decisions/implemented/bug-fix/2026-11-16-continue-original-roots-after-native-recovery.md) owns the correction.
