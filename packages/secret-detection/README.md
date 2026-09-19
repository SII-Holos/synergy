# Secret detection

Runtime-independent detection and evaluation for Synergy. The package exports a typed asynchronous detector, the `standalone-regex` version 1 baseline, shared redaction patterns and evaluation functions. It does not read credentials, access the filesystem, register secrets, load models or make network requests. Executable evaluation scripts own their input/output separately.

## Detector contract

```ts
import { RegexDetector, SecretDetection } from "@ericsanchezok/synergy-secret-detection"

const result = await SecretDetection.detect(
  RegexDetector,
  {
    text: "original message or tool output",
    source: "user_message",
  },
  { timeoutMs: 5000 },
)
```

`Detector` has `id`, `version` and `detect({ text, source, signal })`. A successful scan returns `{ complete: true, findings }`; a truncated or unsupported scan returns `{ complete: false, reason, findings }`. Each finding has `start`, `end`, `kind` and optional `score`. Offsets are zero-based UTF-16 code units into the exact input, with an inclusive start and exclusive end. Findings must be sorted, non-overlapping, non-empty, within the input and outside surrogate pairs. Consumers extract `text.slice(start, end)`; adapters never regenerate the secret value. A score is adapter-specific and is not assumed calibrated across implementations.

The runner validates results and exposes sanitized `SecretDetection.Error` codes for failure, invalid output, cancellation and timeout. Cancellation is cooperative: it forwards an `AbortSignal` and bounds the caller's wait, but cannot preempt synchronous JavaScript or forcibly stop a model process. A model adapter must honor cancellation and own loading/disposal outside individual detection calls; its version must identify weights, preprocessing, thresholds and other effective settings. No model adapter ships in this package.

The regex baseline scans the whole input with the shared standalone prefix inventory and merges overlapping hits. It does not parse arbitrary credential fields, measure entropy, validate credentials or use the separate log/SmartAllow rules. Example keys can be false positives; unknown formats can be false negatives. These cases are retained in the evaluation corpus.

## Harness integration

The Harness `secrets/detector-source` entry accepts `SecretDetectorSource.register(detector)` during runtime composition; `register(undefined)` restores the regex default. Harness owns capture, Vault persistence, masking and execution-time resolution. An empty detection result does not disable matching already registered values. Incomplete scans, timeouts, invalid results and registration failures stop the capture operation instead of being treated as clean text. The production capture deadline is five seconds.

Harness retains its eight-character minimum for global value replacement. An adapter returning a shorter candidate is rejected before registration rather than reporting success while leaving it unmasked. Offline evaluation supports shorter spans independently. Changing this host policy needs separate false-positive and masking evaluation.

## Evaluation commands

Run from this package:

```bash
bun test
bun run typecheck
bun run evaluate --output results/regex.json
bun run evaluate --detector /absolute/path/to/adapter.ts --dataset fixtures/corpus.json --output results/candidate.json
```

An adapter module exports `detector: SecretDetection.Detector`. It is explicitly selected executable code; the runner does not scan for plugins or instantiate a model SDK. `--samples` defaults to 100, `--warmup` to 20, and `--timeout-ms` to 5000. `--help` lists all options.

[The synthetic corpus](fixtures/corpus.json) has independent original-text span labels, recognized prefixes, unknown credentials, Unicode, JSON, URLs, multiple hits, ordinary code, hashes and benign example keys. These deliberately small fixtures validate the evaluator and expose baseline gaps; they are not a representative quality benchmark or training set. Future training and holdout splits must separate source/template and credential families, rather than only changing random key bytes.

Reports include detector/version, dataset version/hash, evaluator source hash, optional adapter module hash, runtime/hardware, per-case outcomes and aggregate/group metrics. Gold labels are never passed to detectors. Exact precision/recall score span boundaries; full-coverage recall requires a finding to contain the whole labeled secret, so a prefix-only hit fails protection. Clean-message false-positive rate uses only completed negative cases; failed/incomplete negatives are reported separately. Failed positive cases remain in recall denominators. Null ratios mean no denominator, not perfect quality. Reports omit sample text, detected values and raw exception messages; use non-sensitive case identifiers and adapter metadata too.

Timing scenarios use synthetic 1 KiB, 64 KiB and 1 MiB inputs with 0, 1 or 32 candidates. They measure the detector plus asynchronous result validation, first-call time per scenario after accuracy evaluation, warm p50/p95, throughput, process CPU and RSS snapshots. Adapter import and first-call times are not full process cold-start or peak-memory measurements. Failed/incomplete scenarios remain visible and produce a nonzero command exit. Misses and false positives are reported metrics, not infrastructure failures.

The real masking pipeline has a separate isolated runner:

```bash
bun run --cwd packages/harness benchmark:secrets --samples 20
```

Run that command from the repository root. It varies Vault size, input length, hit count and first-registration versus already-registered paths. Each run owns and removes a temporary home. It includes detection, validation, Vault and replacement, excludes fixture resets from latency, and never starts a server or calls a model. Use [the task benchmark](../../benchmark/README.md) for session-level latency and task outcomes; detector microbenchmarks cannot establish those effects.
