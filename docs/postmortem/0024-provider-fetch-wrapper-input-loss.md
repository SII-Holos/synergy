# Provider fetch wrappers lost request inputs

## Executive summary

Provider wrappers discarded native fetch options and the representation of already-materialized request bodies. Evidence recording consequently sent chunked uploads where the original caller supplied a known-length body, and provider timeout overrides did not reach the transport. Tests that exercised recording or proxy selection separately missed their composition. Wire-level tests now cover the complete provider path and credential retries.

## Summary

Investigation of interrupted provider requests exposed three local defects: proxy selection rebuilt requests without forwarding native options, existing Request inputs ignored initializer overrides, and credential recovery replaced every initializer body with undefined. The network interruption itself was not reproduced as a deterministic consequence of these defects; endpoint handshake failures remain a separate failure class.

## Timeline

- 2026-09-22: A local receiver reproduced known-length bodies becoming chunked after authentication and recording wrappers.
- 2026-09-22: Provider-entry tests reproduced loss of the native timeout override with and without an explicit proxy.
- 2026-09-22: A held streaming producer exposed a Bun 1.3.14 stall when a cloned live request was reconstructed with `body: undefined`; explicitly passing that retry's own body preserved progress.
- 2026-09-22: Focused fixes restored initializer forwarding, known-length uploads, and streamed retry ownership.

## Root cause

A standard Request carries request semantics but not runtime-specific fetch initializer fields. Treating it as a complete replacement for the original invocation lost those fields. Authentication recovery then erased the body information that the recording transport uses to recognize materialized inputs. Existing recording tests supplied bodies directly, bypassing these production wrappers; existing proxy tests checked routing without checking the final wire representation.

## Guardrails added

- [Provider fetch tests](../../packages/harness/test/provider/fetch-transparency.test.ts) check native options, UTF-8 bytes, sliced byte views, Content-Length, explicit proxy routing, authentication replay, held streaming producers, inherited headers/cancellation, and Request initializer overrides.
- [LLM integration guidance](../../.synergy/skill/integrate-llm/SKILL.md#streaming-bounds) requires tests across the complete wrapper chain.
- [The decision record](../decisions/implemented/bug-fix/2026-09-22-preserve-provider-fetch-inputs.md) records why preserving materialized inputs is preferable to buffering arbitrary streams.

## Lessons

A successful isolated fetch or recorder test does not establish the behavior of their composed production path. Assert the final request observed by a receiver, and distinguish upload framing, response streaming, transport cancellation, and endpoint reachability when assigning a cause.
