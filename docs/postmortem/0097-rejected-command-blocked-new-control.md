# Rejected command blocked a new control intent

## Executive summary

A stale Continue received a durable Runtime rejection, but a subsequent valid Continue with a new request ID was refused by the service's pending command slot. Active forwarding returned the conflict without obtaining the skip proof needed to close that slot. It now closes the rejected attempt within the active request and retains uncertainty if the closure acknowledgment is lost.

## Summary

Control integration exercised two accepted pauses sharing one native latch timestamp. An old control version correctly failed at the Runtime. Submitting the current version under a new logical identity then failed before dispatch because the earlier rejected attempt remained pending. Retrying its immutable stale payload could only produce another rejection, so the public flow could not reach the new intent.

## Timeline

- Independent service and Runtime databases accepted input and two pauses over HTTP and a real machine socket.
- The stale Continue returned a conflict with its retained rejection.
- A changed payload under the same ID was correctly refused, but a new valid request also failed because the old sequence was unresolved.
- Active forwarding was extended to request and observe a signed skip after a definitive rejection.
- The regression reached native continuation once; a lost skip acknowledgment remained queryable without replaying the rejected control.

## Root cause

Service observation clears a pending sequence only after acceptance or an explicit skip. That rule is necessary because not every Runtime rejection advances its watermark. The forwarding path handled skip on retries of an old logical request but omitted closure after the first definitive rejection, leaving a caller unable to replace an invalid intent through a fresh request.

## Guardrails

The organization integration suite tests a stale Continue followed by a different valid intent, changed-payload rejection, lost closure acknowledgment, receipt query and subsequent pause. Native tests retain skip-versus-delayed-Continue ordering and original actor evidence. The API Skill requires public recovery tests across different logical requests, rather than testing only retries of identical input.

## Lessons

Rejection and sequence closure are distinct durable facts. Preserve that distinction while giving the active request a complete path to close its rejected slot. Recovery must permit a new user intent without rewriting an old request or automatically executing it again.
