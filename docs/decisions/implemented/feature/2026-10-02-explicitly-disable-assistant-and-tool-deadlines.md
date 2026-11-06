# Decision Record: Explicitly disable assistant and tool deadlines

Status: implemented

## Problem

Host applications can select provider watchdogs but cannot disable generic assistant-step or Tool wall-clock limits. Substituting a very large number is an undocumented limit and may exceed native timer bounds. Zero must have a consistent meaning across configuration and execution.

## Decision

Assistant-step, default Tool and per-Tool seconds accept zero to disable that deadline. Positive values and existing defaults retain their behavior. The assistant loop creates no wall-clock timer for zero. The Tool resolver returns the owned Session abort signal for zero. Cancellation, provider watchdogs, permission deadlines and bounded settlement remain active and independently owned.

The real Session regression drives a registered Tool and model through explicit release/cancel events. It verifies disabled completion, caller cancellation, positive Tool expiry and positive assistant expiry. The timeout configuration regression covers numeric resolution and rejects negative values.

## Alternatives considered

**Raise the limit.** A large fixed duration remains a policy choice and is subject to timer overflow.

**Copy the loop into each host.** This duplicates cancellation and settlement mechanisms instead of expressing policy through the existing configuration contract.

## Consequences

Zero is an explicit opt-in; the default six-hour assistant and two-hour Tool bounds are unchanged. Hosts selecting zero own their operational lifetime policy. A disabled generic wall clock does not disable caller cancellation or tool-specific operation deadlines.
