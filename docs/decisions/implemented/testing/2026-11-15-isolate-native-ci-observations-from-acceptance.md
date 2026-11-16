# Decision Record: Keep native CI observations outside acceptance

Status: implemented

## Problem

A registered public tunnel can fail before an HTTP request reaches its origin, and a native capacity producer can spend different amounts of time in JavaScript, asynchronous storage and other processes. Aggregate errors and total durations cannot identify those stages. Extending product deadlines, changing networking or reducing the original workload would obscure the failure instead of measuring it.

## Decision

The original cross-OS stderr reader remains the owner of first-URL selection and registration readiness. Its existing callbacks record bounded lifecycle facts: selection versus a complete observed banner, capped private hostname comparisons, original EOF and child exit, and the actual listener-port comparison. Reports serialize fixed labels, booleans, counts and times. The failure snapshot precedes cleanup; a separate snapshot records the original cleanup callbacks afterward. A cleanup exit cannot establish that the tunnel had exited during the failed request. The existing [transport-phase decision](2026-11-15-observe-original-transport-phases-in-acceptance-tests.md) retains ownership of error redaction, request phases and protocol limits.

The existing CI diagnostics workflow offers a default-off native capacity sampling input. It accepts only the original capacity test as a single file, without task or package selectors. Only that explicit diagnostic execution samples the original hundred-message transaction and its Part-write flush at offset one thousand with the pinned [Bun asynchronous sampling API](https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/packages/bun-types/jsc.d.ts). The original window body exists once. All later messages, attachments, shared publication, replay and cleanup continue under the original workload and deadlines. Sampling adds no mutation retry or authority cache.

The original child writes the raw sampling data and finite metadata while it is alive. Metadata records the observed window, transaction and marker-scan counts, callback settlement and raw-file digest. The original mutation error takes precedence over a profiler or output error. The separate short-lived artifact contains diagnostic evidence; the existing diagnostic plan remains unable to satisfy required checks or package coverage acceptance. Ordinary Main execution does not enable the sampler or produce this artifact.

## Alternatives considered

**Sample a shortened producer or treat the profile as normal acceptance.** A prefix omits later workload and cleanup, while sampling and function extraction can change optimization and timing. The full original case and its normal acceptance remain separate.

**Add a full diagnostic case after a long Main failure.** The remaining job budget can be shorter than the original whole-case guard and cleanup. The existing isolated diagnostic workflow provides its own unchanged job budget without adding a workflow or extending the Main critical path.

**Change DNS, TLS, proxies, protocol deadlines or retry mutations.** None follows from a missing HTTP response or a hot sampled function. Passive callbacks preserve the original operation and leave those hypotheses unproven.

## Consequences

Real child-process controls can qualify fragmented stderr, readiness rejection, natural EOF and exit independently of public networking. They do not prove a hosted tunnel works. A one-window JavaScript profile includes other work in the same process and excludes the separate SQLite worker; it cannot assign total latency or establish a capacity improvement. Raw source metadata stays in the diagnostic artifact rather than publication text. Exact-head successful CI, full workload results and original cleanup proofs remain required.
