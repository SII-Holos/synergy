# 0175: A returned Session retained an old message order

## Executive summary

A complete native roundtrip published both canonical messages, but an ordinary history read returned only the message known before departure. Core replacement bypassed the public message writer and retained an internally consistent destination order index. Derived ordering must be invalidated when the canonical aggregate is replaced.

## Summary

The return transfer preserved Session identity, files and paused activation. The defect affected history discovery rather than transport or stored message bodies, but could hide work accepted on another machine.

## Timeline

- A real two-Member HTTPS/WSS fixture completed both transfers and reached the final history assertion after checking current files and epoch three.
- A bounded diagnostic verified two canonical messages on both machines. The returning Home retained one ordering marker and an internally consistent count of one.
- Its paged history, imported Display timeline and direct second-message details contained both messages. The first ordinary history snapshot still contained one.
- Core publication uses the original message-order invalidation owner in the activation transaction, allowing canonical reconstruction.

## Root cause

The canonical aggregate stores messages and Display records under the Session prefix. The local message-order index lives outside that prefix. Core imported records directly and invalidated the model working-set cache, which does not own ordinary message ordering. The old order therefore survived a valid aggregate replacement.

## Guardrails

- [x] Machine check: `packages/organization-runtime/test/handoff-controllers-http.test.ts`, `workspace-roundtrip`, warms old history and verifies canonical, ordinary, paged and Display reads after a complete return transfer.
- Keep ordering invalidation inside the original activation transaction and use its public owner instead of writing derived keys directly.
- See [the decision](../decisions/implemented/bug-fix/2026-11-13-invalidate-destination-message-order-after-transfer.md).

## Lessons

A successful canonical replacement must also retire local derived state that was built from the replaced records. Transport completeness alone does not prove that every read surface discovers the new history.
