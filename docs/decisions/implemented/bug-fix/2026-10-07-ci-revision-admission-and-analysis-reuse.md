# Decision Record: CI revision admission and operation-local analysis reuse

Status: implemented

## Problem

CI planning repeats Git inventories, overlapping blob reads and TypeScript parses while deriving workspace, integration-task and leaf-test inputs. Equal base/head SHAs repeat immutable work, and separate readers cannot share parsed facts. A permissive batch decoder accepts missing headers, truncated bodies and malformed framing, allowing unverified inputs to become absent or empty source.

Measured catalog discovery takes 136 ms; repeated equal-SHA workspace analysis takes 19.71 s and 15.69 s, and task analysis takes 6.23 s and 8.40 s. The workspace reader loads 5,075 files / 37.27 MB overlapping the task reader's 5,397 files / 38.63 MB. The actual 5,397-object batch is fully framed and hash-correct in 1,280 ms. Truncation is a fault-injected decoder defect, not an observed cause of the planner timeout.

## Decision

`planInputs` owns one `RevisionSnapshot` per distinct full commit SHA for a single operation. Each snapshot admits one NUL-delimited inventory and one OID-addressed Git blob batch before exposing inputs. Inventory records validate mode, type, OID and path. Batch records validate the expected OID and blob type, safe decimal length, complete body and newline trailer, Git SHA-1 blob identity, exact order/count and absence of trailing bytes. Failures carry revision, stage, reason and optional path in `RevisionInputError`; partial admission never supplies a plan.

Snapshots preload JS/TS sources, package manifests, `tsconfig*.json` and an existing coverage manifest, not arbitrary resource bytes. An absent task root remains incomplete, and optional absent configuration retains its conservative interpretation. An inventory-present requested blob input that was not admitted fails instead of becoming empty source or triggering a full-plan fallback.

Valid Git gitlinks stay in the typed inventory but are not files, blob inputs or source-analysis candidates, regardless of their path extension or whether the linked commit exists locally. A task root or import that reaches a gitlink is incomplete, not empty source. A gitlink cannot authorize leaf-test reduction in either revision, including blob-to-gitlink and gitlink-to-blob changes.

`source-analysis.ts` produces ordered deduplicated specifiers, all literals, exports and separate dynamic-reference/read flags with one parse and traversal. Snapshots memoize these compact facts per path, without retaining ASTs. Workspace, task and leaf consumers use the snapshot directly; task/leaf differences, raw-text leaf prefiltering, Bun export precedence, type/module augmentation and tolerant AST parsing remain intact. The next operation rereads Git and reparses facts; there is no process-wide cache. TypeScript remains behind the planning import so execution workers can start `--help` without dependencies.

Plan serialization, digest algorithms, selection rules, queues and workflows are unchanged. Policy identity includes the revision admission and shared source-analysis owners, without absorbing the task catalog.

## Alternatives considered

**Only deduplicate equal-SHA reader calls.** This leaves overlapping inventories, blob batches and repeated parses across workspace, task and leaf analyses, and does not fix permissive admission.

**A global revision/AST cache.** This retains large parser trees across operations and obscures whether subsequent planning rereads its inputs. Operation-local compact facts supply the required reuse without lifecycle invalidation machinery.

**Increase fixture or planner deadlines.** This hides duplicated work and leaves invalid frames accepted. The 5 s fixture and 30 s preparation budgets remain unchanged.

**Fallback to empty source or full verification after a read failure.** A full plan still relies on admitted revision inputs; treating corruption as a valid conservative graph erases the input failure. Planning fails explicitly instead.

## Consequences

A tiny real-Git fixture proves equal-SHA planning performs one inventory, one batch, seven requested blobs and four source parses; distinct SHAs double those counts and a second operation repeats them. Isolated process instrumentation wraps physical Git/parser calls and returns real results, with no production telemetry. Fixed graph, task, leaf-selection, plan-body and independent SHA-256 digest oracles replace reader self-comparison. Protocol fault tests reject malformed/truncated responses, and plan-level injection proves no partial plan escapes.

Preloading all supported source/configuration inputs retains their bytes until planning finishes and hash verification adds work per admitted blob. This bounded cost replaces overlapping reads and repeated AST construction. Resource paths remain available in the inventory for dependency selection without loading their contents. See [CI operations](../../../operations/ci.md) for the maintained planning behavior and [Git automation workflow](../../../../.synergy/skill/git-guide/SKILL.md#maintain-repository-automation) for focused verification.
