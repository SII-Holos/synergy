# Service recovery request omitted its Snapshot facet

## Executive summary

The native service and Snapshot installers could not consume the same original recovery request. Their isolated tests hid the mismatch. A real service checkpoint exposed the missing required facet; joint adoption also needed both callback lifetimes at the actual import commit boundary.

## Summary

The service-native request strictly accepted a native hash and cohort mapping, while the Snapshot owner required `payload.snapshot.manifestHash`. Adding a field after the native intent began changed its durable request identity. Independent generic Snapshot fixtures and service-native fixtures therefore proved different installation requests.

## Timeline

1. A real initialized service retained a physical Snapshot blob/tree and captured its actual namespace, native configuration and Snapshot segment through the cohort owner.
2. After source Home and encrypted-container removal, a restricted target completely verified the Snapshot segment and read its Git tree bytes.
3. Joint native installation then failed because the original production request lacked the Snapshot field.
4. The production request gained a required typed Snapshot manifest and source/cohort association checks; the joint import succeeded with an unchanged signer and retained recovery hold.
5. A directly supplied strict request with a forged cohort ordinal bypassed the convenience constructor and incorrectly installed native files. Repeating association checks at the actual native installation entry closed that path.

## Root cause

Each native facet retained its own real owner, but no service-owned original request described their joint installation. The service adopter also lacked a production operation that retained both installed callbacks through the original importer. Constructor-only validation could not constrain directly supplied request DTOs.

## Guardrails

- [x] Machine check: `packages/organization/test/backup/service-snapshot-install.test.ts` installs real service and Snapshot archives through one intent and verifies cold identity, physical history, unchanged signer and recovery-held admission.
- [x] Machine check: the same suite rejects changed Snapshot replay, actual foreign checkpoints, wrong facet roles and directly forged cohort association before native effects.
- [x] Machine check: the same suite holds the actual last raw cleanup write, closes only the Snapshot callback while Home and native evidence remain live, and verifies complete namespace/hold/receipt rollback. Last-write cancellation and a cold retry retain the original installation.
- [x] Machine check: `packages/organization/test/backup/authority.test.ts` prepares its inactive signer only after the joint native installation and import, retaining archived H0 while the source has H1.

## Lessons

Mandatory native facets must share the actual original installation request before any durable intent begins. Every owning callback must guard the physical commit that publishes its namespace. The [decision](../decisions/implemented/bug-fix/2026-11-12-bind-service-native-and-snapshot-installation.md) defines this joint unit without granting active recovery authority.
