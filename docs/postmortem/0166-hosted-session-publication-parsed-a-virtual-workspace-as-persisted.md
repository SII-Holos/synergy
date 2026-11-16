# Hosted Session publication parsed a virtual Workspace as persisted

## Executive summary

The first genuine completed-task recovery reached Hosted publication and failed while parsing its persisted Session header. The parser expected the virtual Workspace presentation field, which canonical storage omits. The earlier no-task recovery fixture had no Session and did not exercise that loop.

## Summary

Service history reconciliation and both source fences succeeded in the isolated recovery fixture. Publication then passed the raw canonical Session row directly to the public persisted-information projection and received a missing Workspace field error. It did not publish readiness or replay the task.

## Timeline

1. Finish an actual Hosted model task through its signed service grant and gateway EOF.
2. Restore its original namespace and reconstruct fixed current service authority.
3. Reach Hosted Session publication and observe the missing virtual Workspace field error.
4. Supply only the virtual presentation field while retaining every canonical stored field, then resolve the actual Session through its owner.
5. Verify paused ordinary startup, original completed Run/input actor and no additional model dispatch.

## Root cause

The publication loop treated a raw SQL Session header as the fully projected persisted-information input. The canonical reader supplies presentation fields separately; native Workspace identity and location remain owned by their original records and resolver.

## Guardrails

- Organization Runtime `test/backup/native.test.ts` includes an actual completed Session in the full service and Hosted recovery path.
- Publication preserves the raw canonical fields, supplies the virtual field and re-reads through `Session.get` before pausing.
- This projection cannot remove Workspace IDs, locations or locators, infer that no Workspace exists, or replace native Workspace portability validation.
- The source-delta tests reject unsupported task history before permanent source fencing and retain releasable original Homes.

## Lessons

Test recovery with actual domain records, and distinguish stored ownership from presentation fields. An empty-namespace startup test cannot verify a per-Session publication loop.
