# Handoff View hid committed cancellation requests

## Executive summary

The service durably recorded a Handoff cancellation request, but the public View discarded its canonical `cancelRequested` flag. If the cancellation acknowledgement was lost, a later read could not distinguish the committed request from an untouched nonterminal Handoff.

## Summary

The real TLS fixture commits cancellation through the service, replaces its successful response with an unknown-outcome error, and reads the same Handoff. Before the fix, that read retained the prepared phase but omitted `cancelRequested: true`. A safe client had to keep its request unresolved; replaying cancellation or inferring success from the phase would not repair the missing read contract.

## Timeline

UI reconciliation exposed the missing observation. A service-backed lost-ack regression reproduced it. The current public View now retains the required canonical flag; the legacy View and stored records remain unchanged.

## Root cause

The stored Handoff already required `cancelRequested`. The service constructed its response from that record, then parsed it through a public schema that omitted the field. The parser stripped the observation before serialization.

## Guardrails

Read back the canonical flag after uncertain cancellation. The flag confirms the request only: source cancellation still requires its actual signed native fact, and the Handoff lock remains until that fact commits. The fixture checks false before the request, true after the lost acknowledgement, and the separate eventual cancelled phase without issuing a second cancellation request.

## Lessons

Unknown command outcomes need sufficient canonical read observations. A successful durable writer and a safe pending UI cannot compensate for a response schema that removes the reconciliation fact.
