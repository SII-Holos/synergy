# Global event subscription loss left the UI connected but stale

## Executive summary

Completed sessions remained running in the sidebar while another active session appeared to await execution. A failed WebSocket send removed the event subscriber without closing its socket, and direct pong replies concealed that loss. Tests covered registry size and sustained backpressure but missed whether every removal informed the client. Subscription ownership and connection liveness must be verified together.

## Summary

Canonical messages contained terminal replies, tools had settled, inboxes were empty, and the backend status endpoint reported no work for the affected project. The frontend retained older states across multiple sessions because all Scope events shared one global connection. Session execution and persistence continued while the UI stopped receiving updates.

## Timeline

- A burst of historical tool-part updates caused sustained backpressure; the server closed the connection and the client successfully reconnected.
- A subsequent pruning burst produced another send failure and removed the only subscriber. There was no corresponding disconnect or reconnect record.
- Sessions continued to produce terminal replies and release their execution runtimes, while the sidebar retained running states.
- A read-only investigation compared runtime logs, canonical session records, HTTP status, and the visible UI. Isolated fault injection reproduced an empty registry with an open socket after both zero send results and send exceptions.

## Root cause

The registry treated closed sockets, dropped sends, and send exceptions identically by deleting the entry. Only sustained backpressure requested an explicit socket close. A dropped send or exception does not establish that the socket has closed. The ping handler bypassed registry membership and could continue sending pongs, so the client neither reconnected nor observed later event sequence gaps.

The original tests verified stable socket identity, closed-socket cleanup, encoding reuse, and backpressure eviction. They did not assert that a client observes closure after a zero send or exception, and did not exercise pongs after subscription loss. The runtime log identified removal but omitted the exact send outcome; the incident cannot distinguish the zero-result and exception branches.

## Guardrails added

- [Registry regression tests](../../packages/server/test/server/global-event-clients.test.ts) cover failed broadcasts, heartbeats and replies, orphan pings, removal, cleanup, healthy subscribers, and reentrant close callbacks.
- [Real WebSocket coverage](../../packages/server/test/server/global-event-recovery.test.ts) checks observable closure and idle recovery after reconnect.
- [Transport verification guidance](../../.synergy/skill/change-server-api/SKILL.md) requires subscription and heartbeat behavior to be checked together.
- [The decision record](../decisions/implemented/bug-fix/2026-09-12-event-subscription-liveness.md) defines the recovery choice and its tradeoffs; the [sync reference](../architecture/frontend-data-sync.md) defines the resulting behavior.

## Lessons

An open socket and successful ping/pong exchange establish transport responsiveness, not event delivery. Removing an event subscription must produce a client-visible recovery signal. Backend terminal state and frontend projection should be checked independently before attempting session repair.
