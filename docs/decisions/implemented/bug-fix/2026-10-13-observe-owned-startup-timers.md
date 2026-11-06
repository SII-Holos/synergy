# Decision Record: Observe polling timers independently of Runtime maintenance

Status: implemented

## Problem

Startup polling tests counted every fake timer in the process while opening and closing real Runtimes. Independent database maintenance could schedule another timer during disposal, making a correctly released polling operation fail the global count assertion.

## Decision

The Channel and Holos lifecycle tests observe scheduling within the polling call's asynchronous context and cancellation of those handles. The observer delegates to the actual fake timer functions. Both tests keep an unrelated timer active while verifying cross-Runtime disposal and successful connection; timeout and single-Runtime closure remain covered.

## Alternatives considered

**Increase the expected count or retry the test.** Maintenance timing changes the unrelated count and cannot establish polling ownership.

**Replace real Runtime fixtures.** This loses verification that component disposal reaches the correct Runtime's polling controller.

## Consequences

Tests require all polling handles to be cleared while allowing another owner to continue. The observer remains test-only, restores every wrapped timer function, and does not alter product scheduling or startup deadlines.
