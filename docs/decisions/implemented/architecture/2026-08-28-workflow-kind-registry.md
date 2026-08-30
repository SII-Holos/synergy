# Decision Record: Workflow kind registry — extension envelope keeps the persisted union narrowed

Status: implemented

## Problem

The four interactive workflow kinds (plan/lightloop/lattice/boss) were hardcoded across the persisted projection union (`session/types.ts`), the service-layer dispatch (`session/workflow.ts`), the invoke loop's Layer 2.5 switch, the user-message wrapper's mode tables, and recovery/working predicates. Inversion point P4: adding a workflow kind required editing L1 files in every one of those places, and the closed unions made test-only or product-extension kinds impossible without core edits.

## Decision

Implement H3 as a hybrid registry (S6):

- **Persisted envelope member**: `WorkflowInfo` gains a closed literal member `{ kind: "extension", extension: { kind: string; payload?: unknown } }`. A scratch typecheck experiment empirically rejected both `kind: string` and `kind: (string & {})` catch-all members — both destroy discriminant narrowing at `workflow.kind === "lightloop"`-style sites (the app has ~16). The envelope keeps every core member narrowed; legacy records parse unchanged (pure addition, covered by test).
- **`WorkflowKindRegistry` (L1)**: `Descriptor { id; conflicts; enable; disable? }` + `effectiveKind(workflow)` which resolves the envelope to its registered kind. `SessionWorkflowService.setExtension(sessionID, kind, args)` is the enable entry: it holds the workflow lock, asserts idle, rejects when any effective workflow is active (`WorkflowConflictError` naming the extension kind, not "extension"), checks the active-BlueprintLoop gate, then delegates projection to the descriptor.
- **Consumers route on `effectiveKind`**: invoke's Layer 2.5 switch gains an `extension` case resolving the registered kind's `buildSystem`; the per-turn `onModelCall` and the loop-exit `finalize` fan-outs key on `effectiveKind`; `setNone` releases both the prompt contribution's and the descriptor's `disable`; core `enable*` conflict errors name the extension kind; `working.ts` recovery and the wrapper's `activeMode`/`messageMode` resolve envelopes (modes are "known" when core or registered).
- **Wrapper `build` accepts any kind string**: `plan` keeps its in-module builders; everything else resolves through `WorkflowPromptRegistry` (already the case for lattice/boss/lightloop since S5).
- **`NoteBlueprintPolicy.WorkflowKind`** widens with `(string & {})` — safe here because the policy only compares against `plan`/`lattice`; extension kinds correctly fall into the Blueprint-write-blocked branch.
- **Route schema unchanged** (`server/workflow.ts` stays closed; no OpenAPI/SDK regeneration). CLI has no kind consumers beyond `--workflow lightloop`.
- **Acceptance**: `test/session/workflow-kind-registry.test.ts` mounts a test-only kind (descriptor + prompt contribution + continuation policy) entirely from test code and exercises enable/persist/wrap/conflict/disable; unregistered kinds are rejected loudly; legacy records parse unchanged.

## Alternatives considered

- **Open the union with `kind: string`** — rejected by experiment: breaks narrowing at every literal comparison site, which the Blueprint's mixed design exists to protect.
- **`kind: (string & {})`** — rejected by the same experiment: TypeScript still loses narrowing when a plain-string member is present in a discriminated union.
- **A second top-level `workflowKind` field** — rejected: duplicates the discriminant and complicates persistence.
- **Route-schema extension member** — deferred: S0–S10 exposes no new kind over HTTP; `setExtension` is a programmatic seam (superplan-style domains call it in-process), so OpenAPI/SDK stay frozen.

## Consequences

- Extension kinds mount with zero L1 edits: descriptor + prompt contribution + continuation policy from any product or test module.
- The persisted union stays closed for core kinds; the envelope is pure addition (old reads/writes unaffected, no migration entry).
- Core conflict errors now name the effective kind (`testonly_kind`) instead of the envelope tag.
- Snapshot: L1→product stays 45, product pairs 42, R3 violations 0 (the registry is L1-internal; only `lattice/register.ts` gained an L1 import it already owned).
