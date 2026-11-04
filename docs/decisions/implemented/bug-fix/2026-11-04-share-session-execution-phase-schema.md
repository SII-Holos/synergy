# Decision Record: Share the Session execution phase schema

Status: implemented

## Problem

Performance summaries validate live Session execution counts. A separately maintained phase enum can reject an active phase such as resource admission waiting, making the summary fail only while that transient state is present.

## Decision

`SessionManager.ExecutionPhase` owns the Zod schema and inferred TypeScript type. Workbench validates its phase counts with that public schema. A regression keeps a real Session lease in resource waiting while computing the performance summary.

## Alternatives considered

**Add the missing value to the Workbench enum.** Rejected because future phases would still require synchronized edits across two owners.

**Accept arbitrary string keys.** Rejected because it hides invalid execution states and weakens generated API types.

## Consequences

The read model stays aligned with the execution owner without changing phase transitions or persistence. Generated API schemas retain a closed set of phases. See [resource admission](../../../architecture/resource-admission.md).
