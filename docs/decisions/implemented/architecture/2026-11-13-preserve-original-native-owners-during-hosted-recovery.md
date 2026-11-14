# Decision Record: Preserve original native owners during Hosted recovery

Status: implemented

## Problem

Service recovery needs proof that a registered native writer permanently fenced its original Home without depending on Organization Runtime implementations. A copied retirement description cannot prove the original frozen namespace, physical Home, primary Store or process-lock lifetime.

A fresh native target must establish its restoration intent before Bootstrap writes logical metadata. Its resulting physical identity must survive authenticated checkpoint restoration, while unrelated existing records must still prevent import. Capturing whichever metadata exists when the caller requests an exemption would certify replacements as original initialization.

## Decision

Expose `NamespaceRetirement` as the Kernel owner for callback-bound native source and physical retirement inspections. A composition-registered native owner recognizes its own captured material and original Snapshot archive. The reference fixes that namespace, archive, native digest, frozen operation, physical Home, dataset configuration and original service target request. Permanent reservation precedes the original descriptor-bound Home fence. Exact cold completion reuses that reservation; read-only inspection requires the completed original fence and cannot repair it.

Cross-Runtime consumers receive opaque inspections whose original callback, primary configuration and native process lock remain live. Runtime closure stops new retirement work and drains accepted fence effects and inspections before closing the Store or process lock. Invalid caller references do not create accepted native work or poison unrelated shutdown.

Add a trusted Bootstrap composition hook after Store attachment and before its first logical write. For a Store that was empty after that hook, Bootstrap captures only its exact identity and the zero-file completion facts returned by its original import and artifact-migration owners. Deferred initialization also consumes the Compat owner’s empty completion fact. Their exact keys, values and revisions are checked when initialization completes. Callback-bound restoration evidence rechecks those original rows; it cannot certify business records or metadata changed before the evidence was requested. Checkpoint import verifies the complete original archive, preserves only that exact target base and excludes source physical initialization records through the existing portable entry reader. All other emptiness, native binary and final commit guards remain in force. An attempted physical metadata mutation also invalidates final commit if its immediate error was caught.

## Alternatives considered

**Importing Organization Runtime into service recovery** would reverse the package dependency and make generic physical evidence depend on a particular native host.

**Caller descriptions or verifier callbacks** cannot establish installed native authority or retain its original lifetime.

**Ignoring physical record prefixes during emptiness checks** could admit unrelated state. Only Bootstrap's own unchanged captured rows qualify, and the default checkpoint path remains strict.

## Consequences

The reference proves original native physical retirement, not current service policy, target readiness or execution permission. Domain recovery still reconciles the complete writer roster and performs native publication before ordinary startup. Task settlement and explicit Continue remain separate; unsupported writers stay blocked.

## Verification

`packages/harness/test/lifecycle/namespace-retirement.test.ts` exercises actual frozen capture, format-four fencing, permanent intent, copied and expired inspections, exact retry and shutdown waiting on the real ownership descriptor's sync. `test/storage/checkpoint-bootstrap.test.ts` verifies authenticated import with target identity preserved, occupied namespaces, unknown physical-prefix records before initialization, original-row changes before and after evidence creation, and caught physical metadata write failure. Existing Bootstrap and checkpoint suites verify the default path.
