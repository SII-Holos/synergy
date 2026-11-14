# Active file authority crossed the final inspection

## Executive summary

An active file mutation rechecked authorization before its final asynchronous mount inspection. Project access could disappear during that wait, yet the physical write still happened before the response rejected. The separate receipt path also required fresh project visibility and blocked completion after an accepted write lost its acknowledgement.

## Summary

Two real HTTP and NativeFileHost cases reproduced the boundaries. The first held the final inspection, removed project membership and observed one physical write where none was allowed. The second committed a write, replaced its HTTP acknowledgement with a timeout, removed membership and observed rejection of the original signed metadata receipt.

## Timeline

The first behavioral regression failed on the actual write counter. The second preserved the existing not-found privacy response for fresh reads and writes before reproducing the receipt rejection. Both passed after changes to their original authority owners; native CAS and independent cleanup-authority neighbors also passed.

## Root cause

The dispatch check preceded one remaining awaited native read. A synchronous frame check afterward did not reload changed project authority. Receipt inspection also reused project visibility rules despite having a separate signed original-retention purpose.

## Guardrails

The file owner reloads current authority after the final inspection and before dispatch. Metadata receipt and acknowledgement inspection retains exact machine signatures, window, connection, primary, original Session/grant/generation, resource attribution, reference and operation identity. It grants no content read or new mutation. Accepted physical saving and Use release retain their original native owners. Tests require zero writes after pre-dispatch revocation and exactly one write after lost acknowledgement and subsequent metadata completion.

## Lessons

Current effect authorization belongs after the last awaited inspection. Completion facts need their own restricted authority without inheriting fresh content access.
