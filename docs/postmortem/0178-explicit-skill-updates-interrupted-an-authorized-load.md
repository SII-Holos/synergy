# PM-0178: Explicit Skill updates interrupted an authorized load

## Executive summary

Applying a newer Skill collection while a version-one invocation waited for permission made the deferred guard reject that invocation. The guard confused the current desired version with current reading authority. The load now retains its original verified collection and reauthorizes it without changing the active pointer.

## Summary

The code already supported explicit collection updates, complete staged downloads and previously activated fallback. Its deferred Skill callbacks nevertheless called the latest-collection loader and demanded that the latest reference still match the older entry. Public application of a new version therefore interrupted an authorized operation even when access remained valid.

## Timeline

1. Read-only R5 tracing identified the entry-selection, permission-wait and deferred-read boundary.
2. A genuine enrolled Member and signed accepted task used public upload, publication and collection-update APIs. Applying version two during the permission wait reproduced PERMISSION_DENIED: zero pass, one fail, three assertions, 1.498 seconds.
3. The original verifier gained a read-only mode for the exact retained activated collection. Deferred body and reference reads reauthorize before and after reading.
4. The regression was strengthened so another legitimate invocation first activates version two; the old invocation must still finish version one without moving the active pointer backward.
5. The original knowledge and signed-machine files passed ten tests and 81 assertions, including public withdrawal and exact loaded-version evidence.

## Root cause

The deferred entry guard called the current desired-collection loader after the entry had already selected an immutable version. It then used equality with that newer desired reference as a proxy for permission. A version-selection update and publication/access revocation are distinct facts.

## Guardrails

- Resolve the version at a new model or Skill-entry boundary; retain it through the complete invocation.
- Reauthorize retained versions through the original activated-selection and current execution owners. A local cache or an old selection DTO grants no reading authority.
- Retained verification streams the complete original manifest and actual cached bytes without publishing an old active pointer.
- [x] Machine check: `packages/organization-runtime/test/knowledge-execution.test.ts`, selector `an applied Skill update preserves the authorized load awaiting permission and rechecks withdrawal`, proves overlapping version-two activation, complete version-one loading, exact provenance, pointer preservation and public withdrawal rejection.

## Lessons

Keep immutable version identity separate from mutable selection metadata and current permission. A deferred read needs both its original complete version and fresh authorization.
