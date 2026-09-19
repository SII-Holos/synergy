# Decision Record: Replaceable secret detection and isolated evaluation

Status: implemented

## Problem

Secret capture called one concrete regex inventory and interleaved each match with Vault reads and writes. Replacing detection with an asynchronous classifier would entangle quality, inference latency and persistence costs. A boolean classifier would not identify the original substring to mask, and treating timeouts or truncated scans as empty results would turn infrastructure failure into undetected disclosure.

## Decision

The [secret-detection package](../../../../packages/secret-detection/README.md) owns a versioned asynchronous detector interface, validated UTF-16 spans, the regex baseline, shared redaction patterns and an offline evaluator. Harness registers a detector through its typed source and retains Vault, context masking, policy and execution-time resolution. The existing standalone patterns remain the production detector; model loading and transports are future host adapters rather than Harness dependencies.

The detector returns original-input spans and completion status. The runner validates ordering, ranges and surrogate boundaries, forwards cancellation and supports deadlines. Harness requires a complete result within five seconds and rejects spans below its existing eight-character global replacement minimum. Detection or registration failure stops capture. This refines the heuristic failure behavior in the [vault decision](../feature/2026-09-19-secret-vault-and-context-masking.md); incomplete output must not silently become an unmasked successful message. Known-value matching remains independent of detector findings.

Capture deduplicates values and registers missing entries in one locked batch. Known entries retain policy and provenance, and the resulting Vault snapshot is reused for replacement. Longer values precede their substrings. The store format and token identity do not change.

The evaluator receives independent labeled synthetic cases and does not expose labels to detectors. It reports exact span precision/recall, full-secret coverage, completed-negative false positives, failures and incomplete results. Timing distinguishes detector/validation from the real isolated capture pipeline; task-level effects remain owned by the existing benchmark workspace. Corpus and source hashes, detector version and runtime conditions accompany measurements. No real credentials or transcripts are included.

## Alternatives considered

**Move the whole secret subsystem into a package.** Rejected because Vault, session ownership and execution permissions would couple offline detector experiments to the product runtime.

**Return only a contains-secret boolean.** Rejected because masking needs the original value's position. A classifier can be wrapped with candidate extraction or span labeling while preserving the same interface.

**Add a remote or trained detector immediately.** Deferred until a candidate and labeled holdout exist. Regex remains the only supplied implementation; pending inference does not add a production dependency or send unmasked text to a service.

**Compare only end-to-end request time.** Rejected because disk access, registration and full agent/model latency can obscure detection cost. Separate runners expose their scopes without attributing an unmeasured improvement to the detector.

## Consequences

Detector experiments can run without a Synergy home or server and can be compared against one versioned corpus. A host adapter can replace the detector without changing message ingress or tool settlement. A model's two-way classification is insufficient by itself; adapters must supply valid original-text spans and cooperate with cancellation. The deadline bounds asynchronous waiting, not CPU execution, so heavyweight inference adapters need their own worker/process lifecycle.

The baseline retains known false positives and false negatives, and the small synthetic corpus is evaluator validation rather than a claim about real-world recall. Filesystem cache and hardware affect pipeline timings. Failed capture can stop a user submission or tool settlement; it never silently certifies an incomplete scan. Performance reports do not contain detected values, but caller-supplied dataset identifiers and detector metadata must also be non-sensitive.

Review hardening preserves existing entries when rotation targets an already registered value, and reports that conflict separately from a missing entry or storage failure. Local Bash standalone tokens expand through a quoted environment reference so spaces and metacharacters stay one argument. Quoted or embedded tokens and remote commands retain literal substitution only for shell-inert credential characters; other values fail explicitly and require a standalone unquoted token in local Bash. This avoids introducing command syntax while keeping the existing simple-key path.
