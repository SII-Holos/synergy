# Surrendered sync source disconnected the return target

## Executive summary

A surrendered Runtime retained a shared transcript root in its exporter queue. Its next synchronization request reached the service after ownership moved to the other Runtime. The service correctly rejected the old driver; that bridge then closed, preventing the original member from receiving the same Session back.

## Summary

The real two-Runtime return fixture completed outbound transfer and captured the updated cloud Workspace. Return target preparation failed because the original member was offline. Diagnostic tracing identified a retained sync-state request and the canonical `Runtime is not the current Session driver` rejection.

## Timeline

The return fixture reproduced the disconnection. A focused test installed a real surrendered native epoch while retaining the old Core binding and exporter queue: the exporter dispatched one sync-state request instead of zero. A second test held an already accepted request across source drainage. Both pass after filtering through the canonical epoch and draining accepted exporter work before final source freezing.

## Root cause

The exporter retained registered roots across ownership changes and started flushSession with a remote request before checking its current local source admission. Core history intentionally preserves the old source binding after surrender, so that binding alone cannot authorize another projection dispatch. The Session's permanent native epoch is the missing check.

## Guardrails

Projection resolution checks the canonical frozen source epoch, including draining and surrendered states. Actual sync-state, blob and batch dispatches recheck that admission and the original binding. The existing organization portability owner's freeze waits outside SQL for accepted exporter work to settle before its final closure. Retained queue data is preserved for a legitimate later epoch. The service's old-driver rejection remains unchanged; no new driver authority or replay is introduced.

## Lessons

Exercise a handoff's original Runtime as the next destination. Successful outbound activation does not prove that its old background observers have relinquished the transferred Session.
