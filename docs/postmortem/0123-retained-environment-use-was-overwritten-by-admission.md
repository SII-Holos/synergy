# Retained Environment Use was overwritten by admission

## Executive summary

A fresh admission using an occupied Use ID resolved even while its original Execution remained running. A separate ready-allocation acquisition also resolved after native maintenance held new work. Resource ownership capabilities, transactional checks and a current worker reader fence close these paths.

## Summary

Real SQLite fixtures reproduced ordinary admissions with both another Host invocation and the original invocation against a retained execution Use. Both resolved instead of refusing the collision. A second fixture warmed the allocation, began native maintenance, then acquired another Use successfully. No real user Home or running product instance was used.

## Timeline

1. An Execution retained its canonical allocation Use while its actual executor receipt remained running.
2. New ordinary admissions with that Use ID resolved; replacing an operation with a disposable admission would transfer cleanup authority to the new caller.
3. Owner-bound acquisition and canonical retention made both collisions reject without changing the original Use or allowing deallocation.
4. A ready-allocation fixture exposed the maintenance bypass. Acquisition now checks admission before preparation and in the publishing transaction.
5. A real committed Execution transaction with a lost acknowledgement verified that ordinary error cleanup leaves its original operation Use retained.
6. Review reproduced current and cold recovery deleting a version-2 admission whose nested origin was unknown. Current admission and execution-preparation origins now use the Origin owner's strict current schema; rejected rows remain physically intact and historical outer unknown ownership remains supported.
7. A pinned literal-version-2 worker reached readiness against the intermediate Home even with no Uses. Advancing the current reader to version 3 made the same worker reject before readiness, alongside the previous Node reader.

8. Standalone Server testing failed before any request because Session history initialization entered an incomplete Session namespace. Pure schema and Rollout owner leaves removed high-level authority imports, but the original Server load stayed red until Gate received its sole Epoch authority from composition rather than importing the full transition module. The unchanged Server import order then passed its Scope guards; valid resource requests remain a separate caller-integration check.

## Root cause

The allocation Use key acted as both an occupancy address and permission to replace or remove its value. Preparation, durable operation retention and cleanup lacked separate native evidence. Allocation readiness also bypassed the admission check performed only when allocating compute. Native admission checks imported the full Session transition lifecycle into common history loading; the full Presets import order hid that initialization dependency.

## Guardrails

- [x] Machine check: Harness `test/environment/use-ownership.test.ts` preserves running ownership across collisions and a real lost commit acknowledgement.
- [x] Machine check: the same suite checks ready-allocation admission, original cleanup, 130 historical records, current/cold nested unknown-origin rejection with preserved bytes, foreign-Store escapes and unknown ownership blocking maintenance.
- [x] Machine check: Local Runtime mount and operation suites retain original receipts through native save, response loss and recovery.
- [x] Machine check: Organization Runtime pinned agent/policy and Node fixtures reject the prior reader before readiness; explicit frozen legacy migration preserves keys.
- [x] Machine check: the original Server Workspace-file import order passes its Scope guards, while transfer and aggregate-mutation suites verify the composition-selected Epoch authority preserves native fences.
- [x] Procedure: the [persistence workflow](../../.synergy/skill/change-persistence/SKILL.md) requires canonical resource publication before retention and original native evidence before retirement.

## Lessons

An occupancy address is not resource authority. Separate preparation, durable retention and original cleanup, and protect new writer admission independently of persisted-reader compatibility. The [decision](../decisions/implemented/architecture/2026-11-12-retain-environment-uses-under-canonical-native-owners.md) records this ownership model and its remaining portability limits.
