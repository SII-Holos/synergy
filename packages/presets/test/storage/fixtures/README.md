# Released product upgrade evidence

Each migration ledger records a published tag and exact source commit. Its completed IDs were extracted from literal migration definitions in that tag's `packages/synergy/src/**/migration.ts` files, retaining the released tracking domains. The ledgers are frozen evidence, independent of the current registry: 2.0.0 has 21 IDs, 2.4.4 has 75, 3.0.21 has 85 and 3.0.22 has 88.

[Released project upgrade tests](../released-project-upgrade.test.ts) combine these ledgers with the [schema-derived Harness records](../../../../harness/test/storage/fixtures/README.md), a released project and its Session, and real temporary directories. Every release covers available, missing, file-replaced, dangling-symlink and looping-symlink folders. Each case opens the complete Runtime, checks readiness and the public health/project APIs, reads retained Home and project transcripts, creates new work, and reopens the migrated store. These are synthetic compatibility fixtures, not captured user data or executions of historical binaries.

[Staged upgrades](../released-staged-upgrade.test.ts) verify deferred history and held workflows separately. [History evidence tests](../released-history-evidence.test.ts) retain legacy tool output and artifact evidence through import and restart.
