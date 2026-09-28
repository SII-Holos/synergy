# Completed terminal blocked Runtime shutdown

## Executive summary

Local architecture acceptance found a Runtime shutdown hang after a remote terminal completed successfully. The terminal output, file checkpoint and Environment reclamation were correct, but Bun 1.3.14 retained the server-closed WebSocket. A dependency upgrade and a full-product process-exit regression address the defect.

## Summary

The terminal experiment disconnected and reconnected its client, drained a large Unicode output, verified physical and saved bytes, and reclaimed the allocation. Its controller then exceeded the deadline while closing the HTTP server. A completed execution alone had hidden this resource lifecycle failure.

## Timeline

- On 2026-09-28, the new remote PTY acceptance experiment timed out after its file and process observations passed.
- Instrumenting the owned controller identified the unresolved server stop promise and one retained WebSocket.
- A minimal Bun server reproduced the same behavior without Synergy. Client-initiated closure succeeded; server-initiated closure stalled.
- The complete Runtime regression failed on Bun 1.3.14 and passed on the isolated Bun 1.4.2 executable.

## Root cause

The runtime dependency retained a WebSocket after the server had already closed it. Awaiting HTTP server shutdown therefore never completed. Unit assertions on output drainage and file persistence did not establish that the enclosing controller could close.

## Guardrails added

- The [Runtime shutdown regression](../../packages/presets/test/server/runtime-websocket-shutdown.test.ts) separately observes terminal output, socket close, Runtime close and child-process exit.
- The [runtime dependency decision](../decisions/implemented/bug-fix/2026-09-28-runtime-websocket-shutdown.md) aligns source, CI, image and published requirements.
- The acceptance runner freezes the executing binary and rejects a different runtime before starting a driver.
- The [testing workflow](../../.synergy/skill/testing-guide/SKILL.md) requires actual transport and process shutdown evidence.

## Lessons

Logical completion, durable save, resource release and controller shutdown are distinct observations. A timeout after successful tool work remains a failed experiment and must retain its partial evidence for diagnosis.
