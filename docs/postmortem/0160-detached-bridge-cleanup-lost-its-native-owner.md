# Detached bridge cleanup lost its native owner

## Executive summary

Freezing an actually connected Hosted bridge aborted its synchronization exporter outside Runtime async context. Exporter cleanup looked up its owner again through ambient context and failed instead of draining the original exporter.

## Summary

The real Hosted recovery fixture could capture an unconnected composition, but a connected TLS/WSS writer failed with `No runtime context` while native maintenance closed its bridge. No native ownership guard was removed to make the recovery proceed.

## Timeline

1. Run the actual enrolled Hosted writer with its listener and WSS bridge.
2. Begin native backup maintenance and close the accepted bridge/exporter work.
3. Observe detached cleanup fail while resolving the exporter registry through ambient Runtime context.
4. Retain the original exporter Set when the exporter is created and remove it from that same Set after drainage.
5. Verify the connected recovery chain and ordinary backup release/reconnection.

## Root cause

The exporter already owned its original Runtime registration, but its asynchronous abort cleanup called the Runtime-scoped registry accessor again. The native abort callback did not retain that ambient context.

## Guardrails

- Keep the actual connected Source4 and restored WSS writer fixture in `packages/organization-runtime/test/backup/native.test.ts`.
- Keep `test/hosted-runtime.test.ts` covering native maintenance release and reconnection of the original writer.
- Capture original owner collections before asynchronous native callbacks; do not retarget cleanup through an ambient fallback.

## Lessons

Installed composition alone does not exercise a resident bridge's native cancellation path. Recovery verification must include the actual connection and its accepted cleanup.
