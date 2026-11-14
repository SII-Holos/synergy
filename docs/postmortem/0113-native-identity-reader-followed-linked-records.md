# Native identity reader followed linked records

## Executive summary

Organization Runtime identity readers accepted a linked record or a record inside a linked parent. A bounded stream constrained bytes but did not prove the native path being read. The owning reader now retains an ordinary-file descriptor and verifies its pathname and immediate parent before returning the exact validated bytes.

## Summary

Two temporary filesystem fixtures reproduced foreign record acceptance through file and parent symbolic links. No user Home or active Runtime was involved. This gap appeared while preparing native Hosted recovery material, where validating and archiving the same original bytes is necessary.

## Timeline

1. Both ordinary-file and linked-parent fixtures resolved successfully when rejection was expected.
2. The record owner gained one bounded descriptor snapshot and normal readers delegated to it.
3. The same fixtures rejected linked inputs. Additional checks verified pathname replacement, exact bytes and original cancellation with descriptor cleanup.
4. Enrolled Hosted backup fixtures verified independent cold identity and signature readers after closing and removing their source Home.

## Root cause

The original stream reader checked the resulting text length and schema after following the path. Neither check established a regular native file, retained descriptor identity or stable parent directory. Parsing alone could therefore validate bytes from a different location.

## Guardrails

- [x] Machine check: `packages/organization-runtime/test/record.test.ts` exercises linked file/parent rejection, pathname replacement and cancellation cleanup.

The [native recovery decision](../decisions/implemented/architecture/2026-11-12-capture-hosted-native-identity-and-connection-state.md) keeps native identity parsing and recovery snapshots with the original owners. Complete captures also retain canonical Home and namespace evidence through sealing.

## Lessons

A valid native identity schema does not prove file provenance. Preserve the relationship between the original descriptor, validated bytes and retained pathname through the operation that consumes them.
