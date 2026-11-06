# Parallel Workspace checkpoint settlement measurements

## Question and disposition

This investigation, conducted on 2026-10-21, asks whether independent Workspace endpoint captures can overlap while retaining snapshot ownership and whether that improves the complete pause, rollback and next-input interaction. The reference revision is `8c98fdead778fc482543675192de0eff82b81545`. The implementation rationale is in [parallel checkpoint settlement](../decisions/implemented/bug-fix/2026-10-21-parallel-workspace-checkpoint-settlement.md); the implementation invariants remain in [Workspace and files](../architecture/workspace-and-files.md#snapshots-rollback-and-restore).

The candidate is implemented and passes focused correctness verification, but it is **not performance-accepted for deployment or merge**. Two comparison rounds show shorter pause medians, while all three show longer next-input medians. The last round reduces pause P50 by 25.35%, but increases next-input provider admission by 17.30%, subsequent reply drainage by 15.01% and sampled server CPU by 7.57%. Host contention changes the magnitude substantially; it does not establish that the regressions are absent or acceptable.

Measured-stage totals also matter: the last round improves their medians, but the two preceding rounds do not. Neither a favorable pause percentage nor a successful correctness suite establishes a stable whole-interaction win. The running user instance was not restarted or modified.

## Source and environment identity

The candidate changes three production files: `packages/harness/src/session/file-changes.ts`, `packages/harness/src/session/snapshot-store.ts` and `packages/harness/src/session/stored-snapshots.ts`. A tracked-file comparison of the isolated source archives found exactly those differences. Both archives and the task checkout use the same lockfile, SHA-256 `a51497fda20b5b4c95777c993871b80118b6993513b8ab2faed330cab873768d`. The native PTY library and receipt are identical copies.

Source fingerprints hash the ordered basenames `file-changes.ts`, `snapshot-store.ts`, `stored-snapshots.ts`, each followed by NUL and its exact bytes:

| Version   | SHA-256                                                            |
| --------- | ------------------------------------------------------------------ |
| Reference | `5f992880bcdc7b6c9d3bf33128338d8ccdd2820241adb42d32853534cf64f658` |
| Candidate | `5586fc6b63cc286318313efa16573ea0b36bd6fa0e4efe6ffe821f835f058da0` |

Every reported round uses those production fingerprints. Earlier development probes are not pooled into the results. The machine is an Apple M5 Pro with 18 CPUs and 48 GiB RAM, running macOS on APFS, Bun 1.4.3 and Git 2.55.0. It is a shared development machine, not a dedicated performance runner. No cache flush or claim of cold operating-system state is made.

## Frozen real-data corpus

Three repository directory trees were copied once, preserving regular-file bytes, executable modes and directory layout. The selection excludes generated dependencies, build outputs, media, databases, archives, environment files, links and files above the existing 2 MiB capture size policy. Original repositories, user configuration and live databases are not benchmark fixtures. The independent copies sit outside active Workspace ancestors to avoid unrelated native ownership conflicts.

| Corpus               | Frozen files | Frozen bytes | Files captured | Bytes captured |
| -------------------- | -----------: | -----------: | -------------: | -------------: |
| A, primary Workspace |        9,144 |   70,258,347 |          9,144 |     70,258,347 |
| B                    |       14,159 |  115,992,028 |         14,158 |    115,992,018 |
| C                    |        9,193 |   88,176,680 |          9,190 |     88,174,780 |
| Total                |       32,496 |  274,427,055 |         32,492 |    274,425,145 |

Normal ignore processing accounts for the difference between frozen and captured content; both versions capture exactly the same counts and bytes. Corpus identity hashes sorted relative path, NUL, Git executable mode, NUL and raw content:

| Corpus | SHA-256                                                            |
| ------ | ------------------------------------------------------------------ |
| A      | `c1ccb7bb150f9e19236db2d4a36246063bdb632f07355aacb42caa5239fd4ef1` |
| B      | `4cde4f003054ae2f5441f943bc27c98270c71160868b6793b9ba6baf3f03faf0` |
| C      | `a7c0ab03eb0ef279508bb88768b250f6873d2fa9f49dfdb62c91d997ef836bd0` |

A final rehash verified that all frozen bytes and executable modes were unchanged.

## Real-process method

Each process starts the source development server with an independent Home and explicit alternate loopback ports, confirms the actual Home through the generated SDK, registers the three directory Workspaces and selects either one or three for sharing. Only inference is replaced by a deterministic local provider. Native execution, Bash, Workspace coordination, snapshot capture, durable storage, public HTTP handlers and SDK input admission are real.

Each cycle submits a turn that executes real Bash, waits until the provider has received the tool result and holds its stream open, requests pause and waits for canonical `working.status` to become `paused`. It then reads the root checkpoint parts, requires the expected Workspace count, complete status, endpoint hash and no changed files, performs rollback, submits a new reply-only input, observes the first provider request and waits until that reply execution drains. The subsequent reply touches only the primary Workspace; it does not execute another Bash tool.

The measured fixture has unchanged file content. It does not substitute tool-entry spies for real capture and does not intentionally modify or shrink capture policy. Changed-file attribution, failure and restoration behavior are checked separately by the behavioral suites.

Each scenario uses sequential ABBA processes: reference, candidate, candidate, reference. Every process has one separately retained first-use cycle and ten warm cycles, yielding twenty warm observations per version and scenario. First-use is not genuinely cold capture: the initial baselines already ran before the measured pause. P50 is the median; P95 is nearest rank, the nineteenth sorted observation of twenty. These small samples do not establish a latency SLA or a cross-machine distribution.

- Pause API time ends at acknowledgement; pause drainage ends only after the execution is actually paused.
- Next-input provider time begins when the new input is submitted, after pause and rollback. It includes input admission and the new baseline, but not the preceding pause.
- Reply drainage begins at the same new input and includes that turn's endpoint settlement.
- Derived stage sums add pause, rollback and either next-input provider time or reply drainage **per sample before taking quantiles**. They exclude checkpoint-fetch and other unrecorded inter-stage overhead, so they are not directly measured end-to-end wall times.

R1 launches the candidate from the task worktree and the reference from an archive. R2 corrects that asymmetry using sibling source archives. R3 repeats the three-Workspace sibling-archive comparison. R2 and R3 record host load, aggregate CPU busy time, free memory and swap before and after every cycle. R3 is a follow-up, not an assertion that the host stayed quiet: its first baseline window again encountered high load. Compilation and this task's test suites did not run alongside the timed matrix. Other users' processes were neither stopped nor reconfigured.

## Three-Workspace results

All values below are milliseconds, P50 / P95; each table cell summarizes twenty warm observations. Rounds are kept separate rather than pooled or selected for a favorable result.

| Round                   | Metric                      |           Reference |            Candidate |
| ----------------------- | --------------------------- | ------------------: | -------------------: |
| R1, mixed source layout | Pause drainage              | 2,698.40 / 4,929.11 |  2,354.06 / 2,685.54 |
| R1                      | Next input reaches provider |   966.62 / 2,286.23 |  1,257.10 / 2,019.41 |
| R1                      | Next reply drains           | 1,882.12 / 4,312.59 |  2,633.46 / 3,576.28 |
| R2, sibling archives    | Pause drainage              | 2,452.65 / 5,391.57 | 3,063.62 / 16,004.25 |
| R2                      | Next input reaches provider |   927.67 / 1,265.74 |  1,589.76 / 6,507.28 |
| R2                      | Next reply drains           | 1,820.08 / 2,450.04 | 3,157.32 / 13,727.24 |
| R3, sibling follow-up   | Pause drainage              | 2,527.53 / 3,792.82 |  1,886.79 / 3,013.03 |
| R3                      | Next input reaches provider |   903.80 / 1,145.46 |  1,060.15 / 1,531.07 |
| R3                      | Next reply drains           | 1,806.83 / 2,423.22 |  2,078.02 / 3,074.43 |

R3 also measures pause API acknowledgement at 13.29 / 22.25 ms versus 14.26 / 27.93 ms, rollback at 24.79 / 41.83 ms versus 26.73 / 46.70 ms, and new-input API acknowledgement at 48.44 / 82.59 ms versus 64.11 / 87.21 ms. An acknowledged pause is not completed filesystem settlement.

| Round | Derived measured-stage sum             | Reference P50 / P95 |  Candidate P50 / P95 |
| ----- | -------------------------------------- | ------------------: | -------------------: |
| R1    | Pause + rollback + next provider       | 3,707.65 / 7,297.77 |  3,801.53 / 4,622.75 |
| R1    | Pause + rollback + next reply drainage | 4,766.12 / 9,293.10 |  5,061.10 / 6,378.58 |
| R2    | Pause + rollback + next provider       | 3,423.18 / 6,676.10 | 4,767.60 / 22,848.75 |
| R2    | Pause + rollback + next reply drainage | 4,244.90 / 7,889.54 | 6,268.24 / 28,523.30 |
| R3    | Pause + rollback + next provider       | 3,470.66 / 4,966.00 |  3,078.88 / 4,606.27 |
| R3    | Pause + rollback + next reply drainage | 4,326.45 / 6,243.77 |  4,194.64 / 6,149.62 |

The R3 reply-stage total improves by only about 3%, despite the 25% pause reduction. The earlier rounds' total medians regress. This is not evidence of a stable net improvement without an input-latency regression.

## Single-Workspace control

The primary Workspace uses direct endpoint processing rather than batch admission. Single-Workspace controls were run in R1 and R2, with the same source fingerprints. Their medians are broadly similar or lower, but several tails are worse; they cannot support an assertion that every percentile is unchanged.

| Round | Metric                      | Reference P50 / P95, ms | Candidate P50 / P95, ms |
| ----- | --------------------------- | ----------------------: | ----------------------: |
| R1    | Pause drainage              |         759.12 / 994.45 |         763.41 / 897.02 |
| R1    | Next input reaches provider |       869.22 / 1,057.66 |       872.73 / 1,221.49 |
| R1    | Next reply drains           |     1,679.61 / 1,927.95 |     1,648.59 / 2,712.43 |
| R2    | Pause drainage              |         744.73 / 968.45 |         716.84 / 834.12 |
| R2    | Next input reaches provider |       878.90 / 1,059.90 |       833.54 / 1,183.68 |
| R2    | Next reply drains           |     1,680.58 / 2,014.60 |     1,595.97 / 2,480.01 |

## Resource costs and host uncertainty

Resource samples are taken once per second. CPU below is the sum of each process's sampled server CPU-counter delta across its whole observation window, including first-use work; it is not warm-only CPU, elapsed time or whole-process-tree CPU. RSS is the largest sampled server RSS across the two processes. Native workers and Git children are excluded, and between-sample memory peaks may be missed.

| Three-Workspace round | Reference CPU, s | Candidate CPU, s | Reference peak RSS, MiB | Candidate peak RSS, MiB |
| --------------------- | ---------------: | ---------------: | ----------------------: | ----------------------: |
| R1                    |           311.58 |           350.47 |                  557.14 |                  600.27 |
| R2                    |           315.09 |           403.25 |                  595.94 |                  614.53 |
| R3                    |           300.79 |           323.55 |                  585.11 |                  604.27 |

R2 single-Workspace server CPU is 128.95 versus 129.12 seconds across the corresponding two-process windows. The larger multi-Workspace CPU costs therefore cannot be dismissed solely by pointing to the direct single-Workspace path.

The shared machine experienced substantial changing pressure, including load averages above its 18 CPUs, approximately 11 GiB compressed memory during a probe, and approximately 3.6 GiB swap throughout the instrumented comparisons. R2 baseline A begins around load 31 and baseline D around load 11; R3 baseline A begins above load 40. R3 candidate B and C have median machine CPU busy fractions around 31% and 37%, versus about 25% for baseline D. These are host-wide observations, not proof that all additional load comes from unrelated work. Existing allocated swap alone does not prove active swapping; its cumulative size and changing load are retained as context.

Replacing the candidate worktree with a sibling archive did not remove the observed regressions. Capture counts and byte counts match exactly. Those checks rule out extra capture work and source-layout asymmetry as sufficient explanations, but do not isolate a single cause for the remaining next-input and CPU differences. The full regression cannot be causally assigned to the patch from these shared-host samples, and stable no-regression acceptance cannot be inferred either.

## Correctness and evidence audit

The reported matrix comprises twenty sequential server processes and 220 complete cycles, including twenty first-use and 200 warm observations. A post-run audit verifies 1,408 actual captures and 484 complete pause checkpoints. Each three-Workspace process performs exactly 88 captures; each single-Workspace process performs exactly 44. The primary corpus is captured four times per cycle and each additional corpus twice. The driver checks that the pause checkpoint Workspace count, before/after hashes, status and unchanged-file list match; the resulting evidence digest agrees across versions in every round.

Each process has exactly eleven Bash-producing provider requests, eleven held continuations and eleven reply requests. Asynchronous auxiliary requests vary between ten and eleven; they are recorded, not assumed to be a fixed invariant. R1 and R2 three-Workspace processes each have ten auxiliary requests; R3 has eleven in each baseline process and ten and eleven in the candidate processes. There is no extra candidate tool execution explaining the later-input difference.

Focused verification passes forty Harness tests with 217 assertions and twelve Local Runtime tests with 81 assertions. Coverage includes actual post-index overlap, same-index serialization, session lifecycle exclusion, queued maintenance, context expiry and foreign Runtime isolation, failure drainage, summary settlement, identical-root references, durable restoration, changed-file attribution, rollback input and passive admission. Harness strict typechecking passes. Independent follow-up review reports no additional actionable defect after fixing duplicated durable preparation for concurrent identical roots. Correctness and performance acceptance remain separate conclusions.

The final corpus rehash succeeds and both benchmark ports are released. Raw fixtures, run logs, provider journals and observability databases are excluded from version control; none are copied from or written back to the active user Home. Source and corpus identities, per-cycle measurements and audit summaries form the compact private evidence record. Isolated Homes, source archives and frozen directory copies are disposable and can be reclaimed after the audit. The [local verification guide](../../.synergy/skill/testing-guide/references/local-verification.md#local-performance-experiments) describes the reproduction requirements without publishing private paths or Runtime identities.

## Remaining scope

These experiments are native, local, full-access, deterministic-provider backend comparisons with unchanged content. They do not establish real-model latency, Desktop composer responsiveness, guarded execution, Docker or remote/object-store performance. Changed-file semantics have behavioral coverage but not an additional dirty-corpus process matrix. Resource observations do not include children or isolate external CPU and disk activity.

No timer, capture size policy, content-verification rule, historical retention guarantee or Workspace coverage was weakened to lower the numbers. No new global scheduler, adaptive concurrency policy or timestamp-based shortcut was introduced. The next implementation must explain and eliminate the later-input/resource regression under comparable host conditions before this candidate can be called a reasonable whole-interaction optimization. The current measurements are not deployment approval.
