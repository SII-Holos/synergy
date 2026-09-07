# Rollout Execution and Experiments

Every normal task records execution evidence. Recording is independent of operational telemetry and requires no additional database or service. A Session can contain multiple runs; a run can include delegated sessions and auxiliary inference. A successful execution status is not a task-quality score.

## Run and compare

```bash
synergy send --experiment experiment.json --format json --non-interactive "Implement the requested change"
synergy send --attach http://127.0.0.1:4096 --experiment experiment.json --format json --non-interactive "Implement the requested change"
synergy stats --run <runID>
synergy stats --compare <runID-A> <runID-B>
synergy export <sessionID> --format rollout --run <runID> --output trajectory.zip
synergy import trajectory.zip
```

`send` creates a session unless `--session` or `--continue` explicitly selects existing history. JSON events have a version, increasing sequence number and session/run identity. The final result reads durable execution status and accounting. Session idle alone does not complete the command: associated child tasks, workflows and auxiliary calls must settle. Continuing history records its initial message count and fingerprint; inspect that context before comparing runs.

Exit codes are `0` for completed execution, `2` for execution/command failure, `3` for timeout, `4` for required interaction, `5` for failed authoritative recording and `130` for cancellation. The default timeout is six hours. Non-interactive execution rejects permission requests and questions instead of granting access. Cancellation targets the selected root and its descendants, drains auxiliary work and terminates its owned background processes.

One-shot execution and the persistent server use the same Home lock, strict configuration, migrations, workers and awaited shutdown. One-shot omits resident Agenda, Channels, Boss and autonomous recovery services. Attach mode only connects to the specified server. Help/version read command metadata without booting the runtime. A second writer cannot use an already owned Home.

## Experiment file

```json
{
  "version": 1,
  "label": "pruning-disabled",
  "overrides": {
    "compaction": { "prune": false }
  },
  "runtime": {
    "execution": { "agentWorkers": 2 }
  }
}
```

`overrides` accepts the existing task-local compaction, prompt, tool exposure, model-role and LSP diagnostic settings, `execution.continueOnDeny`, `execution.messageCache` and `cortex.primaryOnlyTools`. Unknown fields fail validation. Overrides do not grant permissions. Explicit command model selection wins over the experiment; delegated and auxiliary calls inherit the immutable task snapshot.

`runtime` accepts shared execution resource settings, `cortex.maxConcurrentTasks`, LSP and formatters. One-shot applies these before resource creation. Attach validates them against the server's actual configured values, including worker defaults. A mismatch fails and requires a separately configured runtime. Live algorithm configuration changes do not alter an active task's snapshot; security and authorization remain live. Tool evidence records the evaluated profile/capabilities and resolved authorization before execution, while transport records retain authentication-recovery attempts without credential headers.

Snapshots include winning configuration layers, effective task/runtime settings and a fingerprint. Run provenance records source version/commit, available Git state hashes and installed plugin versions/manifests. Loaded skills retain original content and its hash. These are evidence of the observed environment, not a reproducible image of arbitrary external services or untracked file contents.

Canonical configuration lives in the [configuration domains](configuration.md). The former experimental block is migrated into owning domains. Legacy experimental environment flags have one centralized deprecated input converter for the next release cycle; new experiments should use versioned files. Built-in LSP enablement can use a partial entry; custom servers need a command and extensions, and environment overrides require an explicit command.

## Evidence and accounting

A logical call contains semantic model input and SDK output. Each actual inference request has its own attempt with the final provider-facing body, response body/stream, safe response headers, timestamps, raw usage and captured pricing basis. Internal retries count independently. Non-chat embeddings, reranking and voice calls use the same ledger; independent background work belongs to a Scope operation rather than a fabricated session.

Tools retain original results separately from model-visible observations and bounded message previews. Process streams preserve stdout/stderr channel order in framed binary chunks before display truncation. Original attachments and received MCP resources are retained before extraction. Pruning changes model history projection; it does not remove original evidence. Explicit owner deletion removes its rollout storage. Retained legacy output files are not automatically deleted by age.

Accounting separates known API estimates, unknown quantities/prices, provider-reported charges, historical calculations and subscription API equivalents. Reasoning is included in normalized output tokens and is never charged twice. Cache creation duration, cache reads and audio units retain their categories. Unresolved audio/cache overlap or nonstandard service-tier pricing produces an unknown estimate instead of a fabricated total. Forked/imported historical calls retain their source identities and contribute no new spend.

A terminal run independently reports execution status and recording completeness; missing usage is an accounting gap, not zero usage. Failed authoritative writes stop new execution. Recovery closes interrupted calls without replaying side effects. Deliberately backgrounded processes may outlive a successful task in a persistent server; its terminal export is partial while their streams remain active.

## Archives and historical data

Rollout ZIP uses a versioned manifest, fixed journal revisions, transcripts, workflow/history evidence and referenced artifacts with byte lengths and SHA-256 hashes. CLI and HTTP export share the implementation. Active runs and missing originals produce explicit partial manifests. Import validates entry paths, duplicates, sizes and hashes before creating sessions, remaps local identities, preserves original call provenance, and never executes imported tools or workflows. Each committed output prefix retains its own boundary after import.

Archive limits are 64 MiB per entry, 16 GiB total uncompressed content and 100,000 entries. Binary artifacts use 1 MiB chunks. Plain and gzip transcript imports remain supported with a 64 MiB decompressed limit, but cannot supply omitted rollout artifact files. Imports retain the existing same-Scope constraint.

The versioned session migration preserves historical costs with their old calculation label, associates trusted retained outputs and available attachments, records gaps and supports reentry. Historical requests and provider usage cannot be reconstructed if they were never recorded. Operational log cleanup does not remove rollout evidence.
