# Attached client rejected canonical Home Scope

## Executive summary

The attached CLI rejected valid Home metadata because its reply validator accepted only project Scopes. Validate the existing server union at the adapter and exercise it through the real SDK transport.

## Summary

A source-measured adapter test served canonical Home metadata through HTTP. The current adapter failed with a project-type and missing-project-time validation error. The server route, generated response type and Local Runtime client already supported Home.

## Timeline

The unchanged adapter failed before its response assertion. Replacing its project-only validator with `Scope.Runtime` made the same HTTP scenario and the adapter's error and cancellation neighbors pass.

## Root cause

The adapter selected the project persistence schema rather than the current Runtime Scope response schema. Project-only fixtures and separate child execution left this union boundary unverified in the measured process.

## Guardrails

- [x] Machine check: `packages/cli/test/cli/remote-client.test.ts` verifies canonical Home replies, forwarded mutations and Scope metadata, rejection of malformed successful data, preserved structured errors, supported SSE events and actual transport cancellation.

The [decision](../decisions/implemented/bug-fix/2026-11-14-validate-the-attached-runtime-scope-union.md) preserves the original API and storage owners.

## Lessons

Validate a public response with its canonical response schema. Execute adapter behavior in the measured process while retaining independent installed and child-process acceptance.
