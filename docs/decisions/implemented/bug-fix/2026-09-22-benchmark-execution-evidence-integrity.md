# Decision Record: Preserve benchmark environments, serial order and admission evidence

Status: implemented

## Problem

The release adapter isolated Synergy data by replacing both the task's operating-system home and the product home. The modern adapter replaced only the product home. This made preinstalled dependency caches resolve differently between the two versions. Public rollout reconciliation used request-body digests, which cannot distinguish repeated identical completed requests. The scheduler serialized resource use but interleaved pairs despite a frozen serial schedule. A connectivity probe could also report success after cleanup made its terminal evidence invalid. These defects limit experimental interpretation and admission; none justifies changing retained native rewards or costs.

## Decision

Both Synergy adapters preserve the task image's `HOME` and XDG settings at CLI launch and isolate product data with `SYNERGY_HOME`. Native shell filtering remains measured product behavior. An offline build in the same dasel image verifies that the task's original dependency cache works without a network; adapter tests separately exercise inherited configuration and actual native tool execution. Other harness adapters retain their existing documented isolation until independently audited.

The gateway assigns each dispatch a namespaced `X-Request-ID` on successful and HTTP-error responses. Synergy's public rollout already retains this header, so the evaluator matches it without modifying the measured program. A matched ID must also have a verified request-body digest and matching per-request usage. Conflicting bodies, duplicate response IDs and mismatching usage fail reconciliation. A missing body remains unverified.

Records without a response ID retain unique-body reconciliation. Early cancellation may precede response headers; repeated or missing bodies remain ambiguous or unknown. Historical archives receive no synthetic identifiers and retain their original coverage. This evaluator change requires a new experiment identity. Model failures remain observations; any change to a pilot's expansion policy is a separate prospective protocol decision.

When concurrency is one, execution traverses the entire frozen schedule directly, including after recovery. Parallel execution keeps per-pair ordering. Both paths share the existing attempt, cancellation and bounded pre-dispatch retry handling. A zero reward remains an observation and does not alter the schedule.

Doctor admission requires valid terminal evidence and no infrastructure error in addition to the actual tool roundtrip, completed-request usage reconciliation and verified archive. Partial recording and interrupted unknown usage remain distinct from invalid evidence; the fix does not turn missing usage into zero or reject a structurally valid partial recording merely for being partial.

Implementation: [adapter](../../../../benchmark/runtime/external.mjs), [gateway](../../../../benchmark/src/synergy_bench/gateway.py), [native evidence](../../../../benchmark/src/synergy_bench/native_usage.py), [scheduler](../../../../benchmark/src/synergy_bench/runner.py), [doctor](../../../../benchmark/src/synergy_bench/maintenance.py). The incident and missed controls are recorded in the [postmortem](../../../postmortem/0022-benchmark-execution-evidence-integrity.md).

## Alternatives considered

**Replace the candidate's operating-system home too.** Rejected because equalizing two altered task environments would still discard the native image's dependency-cache behavior. The products already have a separate data-home control.

**Repair or copy task caches before grading.** Rejected because it would change task inputs and hide an adapter error. Reference solutions remain confined to disposable oracle environments.

**Pair repeated bodies by time, order or aggregate usage.** Rejected because these do not independently identify a dispatch and can hide swapped usage. The response header supplies identity while the body and usage remain independent checks.

**Treat a single resource slot as proof of serial schedule order.** Rejected because separately queued pairs can alternate between their first and second sides. The declared list, rather than semaphore wake order, defines serial dispatch.

**Admit a probe whenever its model and archive complete.** Rejected because failed cleanup or another infrastructure error can leave the environment unready for further work even when model usage is fully known.

## Consequences

New runs preserve native dependency access, frozen serial dispatch and distinct completed-request identity. The added ID does not enter the model prompt or add a model call. Failed evidence blocks connectivity admission. Lost headers, incomplete request bodies and interrupted usage still limit precision. Existing pilot observations and their failed admission remain immutable; environment and dispatch-order confounding further limit release-to-candidate causal claims.
