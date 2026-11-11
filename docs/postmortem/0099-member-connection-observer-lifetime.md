# Member connection observers outliving their socket

## Executive summary

Resident bridge callbacks received the lifetime of the whole bridge, so synchronization subscriptions could survive a disconnected socket. The fix gives each connection an abort lifetime and awaited cleanup before reconnect. No production data loss was established during this investigation.

## Summary

Code inspection found that earlier exporters could enqueue concurrent writes in the same Runtime Home after transient reconnect. Release observers also failed to retain their asynchronous index scans through stop.

## Timeline

A new real WSS test reproduced the missing cleanup before implementation. The first change also exposed an abort-feedback hazard: forwarding a connection's abort back to its transport labelled offline closure as intentional shutdown. Separating callback lifetime from transport cancellation restored reconnect. The fixed connection and Runtime suites passed with heartbeat and shutdown checks.

## Root cause

`startMemberBridge` supplied its bridge-wide signal to `onConnected`. That signal intentionally survives reconnect, and the callback had no returned cleanup contract. A release scan that began before stop could also enqueue settlement work afterward because the scan itself was untracked.

## Guardrails

- [Connection tests](../../packages/organization-runtime/test/connection.test.ts) verify old-signal abortion, subscription cleanup before a second authenticated WSS connection, absence of stale callback writes, continuing heartbeat and awaited shutdown.
- [Runtime tests](../../packages/organization-runtime/test/runtime.test.ts) exercise real resident export, resource settlement, reconnect and cleanup.
- Connection drainage attempts all owners and preserves structured cleanup failure; explicit shutdown cannot report successful cleanup merely because the bridge was aborted.

## Lessons

A reconnecting transport and its per-connection observers have different lifetimes. Unsubscribing stops new work; draining proves that already accepted work can no longer race its replacement. See the [decision](../decisions/implemented/bug-fix/2026-11-11-drain-member-connection-observers-before-reconnect.md).
