# Vite fixtures shared default ports

## Executive summary

The shared UI Markdown browser fixture failed during post-merge CI because Vite attempted to bind an occupied default port. Its configuration used zero, which looked isolated but did not request an ephemeral Vite port. Reusing the repository's explicit port allocator removes this dependency on package scheduling.

## Summary

The CI job completed its other checks and failed the UI suite before browser assertions with an occupied-port error. Inspection also found three Web fixtures using zero and two shared UI fixtures using fixed ports. The same tests had passed in earlier runs, so a green run alone had not established port isolation.

## Timeline

- On 2026-10-04, post-merge CI failed the Markdown fixture while Web and shared UI tasks overlapped on one runner.
- Occupying the default and two fixed ports reproduced failures in the Markdown, Tooltip and ProviderIcon suites locally.
- Replacing those configurations with the existing allocator allowed the same eight UI cases to pass with the ports still occupied.

## Root cause

[Vite 7.1.4's server startup](https://github.com/vitejs/vite/blob/v7.1.4/packages/vite/src/node/server/index.ts) treats a zero configuration port as absent and falls back to its default. The fixtures assumed the underlying HTTP server's ephemeral-port convention applied through that wrapper. Existing testing guidance already required a nonzero allocated port, but these fixtures did not use the helper. Distinct Homes, processes and temporary directories did not isolate their listeners.

## Guardrails added

- The affected Web and shared UI fixtures use the shared [port allocator](../../packages/testing/src/fixture.ts).
- The existing browser assertions are verified while the previously selected ports are occupied, including all three shared UI suites that reproduced the conflict.
- The [testing workflow](../../.synergy/skill/testing-guide/SKILL.md) requires this occupied-port verification for isolation changes.
- The [decision record](../decisions/implemented/testing/2026-10-04-isolate-vite-fixture-ports.md) records the choice to retain explicit allocation and strict listener behavior.

## Lessons

Wrapper configuration can differ from the underlying networking API. Verify actual listener behavior under contention, and audit adjacent fixture owners when a supposedly isolated resource turns out to be shared.
