# Decision Record: Structured auxiliary Tool output

Status: implemented

## Problem

Embedded domain operations need schema-bound auxiliary model output. Calling the SDK directly bypasses native inference ownership, cancellation, capacity and rollout capture; replacing forced Tool output with free-form JSON weakens the domain contract.

## Decision

AgentCall accepts one optional schema-only output Tool and returns its collected Tool arguments. It passes the forced choice through the typed AgentTurn protocol to LLM, including rollout request capture. No domain executor is installed. The existing inference lane, accepted owner, cancellation, timeout and retry lifecycle remain shared. Both text and Tool arguments count toward the output bound. The domain validates the returned arguments with its owning schema.

## Alternatives considered

A second direct SDK call duplicates inference behavior. Free-form JSON repair changes validation guarantees. A registered executable business Tool would grant effects to an output-only model request.

## Consequences

Structured generation can use the same public inference mechanism and evidence producer. The native worker protocol carries the choice explicitly. Tests verify the forced choice, absent executor, returned arguments and output bound; ordinary text behavior remains unchanged.
