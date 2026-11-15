# Closed control history and restored Homes blocked backup

## Executive summary

Recovery accepted only a narrow subset of ordinary control and execution history. A real restored Service could also serve normally but could not complete another backup and recovery. The failure crossed history validation, signing rotation and native Home formats; accepted subcases did not establish the original full backup requirement.

## Summary

Review against the original recovery requirement found that completed Continue, Cancel and confirmed Question records were ordinary retained data, rather than an authorized exclusion. Real Hosted fixtures exercised their public writers and the original whole-cohort restoration. A real enrolled Member then exercised two independent Service recoveries, retaining its original command records while deployments and signing identities rotated.

## Timeline

- A queued task admitted while paused completed through public Continue before backup. Original recovery rejected its acknowledged control after 29 assertions; the first history correction passed 61 assertions without replay.
- Terminal Cancel and confirmed Question histories failed against the original implementation in two qualified restore cases. The correction passed both complete recoveries, preserving private answers under the Native owner and excluding them from Service command records.
- The repeated Member recovery fixture first failed because administrative backup required the initial Home format and the cohort compared offline historical Member incarnation with the current deployment. These failures occurred before historical signature validation.
- Restored-Home preparation exposed additional version-one selection and retirement-marker assumptions. The complete second recovery then reached the original signature mismatch, establishing a distinct signing-history regression.
- Versioned native and preparation records, exact retirement fields and original public signing identity lineage passed both real repeated-recovery cases. Original records, prior publication and retry key material remained unchanged.
- Independent review found that a generation-two grant could lose its first release receipt when that generation had no Gateway calls. A real release, reacquisition and second release now has a complete-history positive and a RAM-only missing-first-receipt negative.

## Root cause

The historical readers reused task-admission restrictions as a data inventory. They conflated one logical accepted request with its transmission attempts, the latest released generation with its full history, and the current signer with every retained deployment. Native backup entry points separately assumed that every ordinary Home still had the initial fenced marker. A successful first restoration did not test that the resulting ordinary Home remained a valid future backup source.

## Guardrails

- [x] Machine check: `packages/organization-runtime/test/backup/native.test.ts` restores real completed Continue, terminal Cancel and confirmed Question histories without replay; private decision answers stay Native.
- [x] Machine check: `packages/organization-runtime/test/backup/recovered-command-signing.test.ts` performs administrative capture of a genuinely restored Home and two independent Service recoveries with actual key rotations, exact retained command records and immutable retries.
- [x] Machine check: `packages/organization/test/execution-release.test.ts` uses real two-generation release and reacquisition, verifies complete historical acceptance and rejects a missing earlier receipt in an independent RAM copy.
- [x] Machine check: `packages/organization/test/execution-handoff.test.ts` validates original terminal Service Handoff and grant lineage, missing binding/index and correctly signed command-barrier corruption through fixed history copies. Its signed Native facts are Service fixtures, not an actual Native backup acceptance.
- [x] Machine check: `packages/organization-runtime/test/backup/member-command-history.test.ts` uses an actual enrolled Runtime, original query and signed Native skip before a public logical retry; missing skip/index and pending histories are refused. Its pre-reception transport fault returns no artificial acknowledgement.
- [ ] Machine check: actual Native Handoff backup, explicit post-restore continuation of the original unfinished Root and known paused/queued capture remain separate acceptance work.
- [ ] Machine check: coherent final canonical quality, installed acceptance, copied real Home and new exact-head CI remain pending.

## Lessons

Map requirements to ordinary user lifecycles before treating a reader refusal as an allowed limitation. Advance through each real failing owner and preserve the distinction between setup failures, format guards and signature evidence. Verify that a recovery result can itself be backed up again. Historical validation must preserve original facts while leaving fresh execution authority to the current owners. See [the decision](../decisions/implemented/bug-fix/2026-11-16-recover-closed-controls-and-repeated-backups.md).
