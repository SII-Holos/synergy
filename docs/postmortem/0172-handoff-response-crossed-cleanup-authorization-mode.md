# Handoff response crossed cleanup authorization mode

## Executive summary

A pending ordinary target inspection could return a private native difference page after the requester lost its project role. The final authorization check admitted the narrower cleanup mode but response filtering still used the earlier ordinary mode. An authorization result must remain valid for the exact pending response.

## Summary

The real TLS regression holds an actual Target response containing a nonempty native difference page. The source commits cancellation and the target loses its project role while its account and Runtime stay active. Releasing the original response returned HTTP 200 with the private page, even though a new request was authorized only to reconcile its own inactive cleanup.

## Timeline

Independent review identified the two authorization snapshots. The actual held-frame regression reproduced HTTP 200 and a private page, then completed original physical cleanup. Requiring identical authorization modes at the final service snapshot changed that same regression to HTTP 403 without a difference page. New cleanup inspection and retirement still completed through the original owners.

## Root cause

The response projection used the first `machineAccess` result. After awaiting the machine reply, the service rechecked current access but only required an active Runtime connection. Ordinary access could become cleanup access, unintentionally lending cleanup authorization to an already formed private response.

## Guardrails

The final snapshot rejects a response when its ordinary/cleanup mode differs from the original request. The existing target role-cleanup regression holds a genuine signed machine reply, performs real source cancellation and role removal, delivers that original reply, and verifies denial before completing native cleanup. It does not infer that a rejected late response means no machine work occurred.

## Lessons

Reauthorization must protect the response that will actually be returned. A narrower recovery permission cannot authorize an earlier private result. See [original cleanup ownership](../decisions/implemented/architecture/2026-11-13-own-revoked-target-cleanup-through-original-handoff-evidence.md).
