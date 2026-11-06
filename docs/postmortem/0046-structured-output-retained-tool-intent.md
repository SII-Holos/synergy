# Structured output retained tool intent

## Executive summary

Real-model validation of the embedding integration found that schema-only AgentCall outputs retained the common workBrief field. Strict domain validation rejected otherwise valid objects. The integration test supplied only native arguments and missed the model-facing facade. Every consumer of a tool-call stream must decode its request-frozen input binding before domain validation.

## Summary

Both relevance selections returned the requested indices plus intent metadata. The collector forwarded the complete object, causing unrecognized-field errors. Enveloped schemas also needed decoding, including native schemas that define their own workBrief field. This defect belongs to the integration addition of outputTool support; the pinned official revision does not contain that interface.

## Timeline

- On 2026-10-05, a real-model business scenario failed two structured selections.
- Captured requests and responses showed that the model followed the augmented schema.
- Focused tests reproduced flat intent leakage and envelope leakage before the fix.

## Root cause

AgentTurn built the common tool facade, while AgentCall collected its output without passing through the ordinary Tool executor decoder. Independent tests verified the output tool choice and parsed native values but omitted actual model-facing arguments.

## Guardrails added

- [AgentCall tests](../../packages/harness/test/agent/call.test.ts) return intent metadata and a native workBrief field, preserve unknown business fields and retain output limits.
- The [intent decision](../decisions/implemented/architecture/2026-10-01-tool-intent-and-execution-evidence.md) defines decoding for schema-only outputs.
- The [model integration workflow](../../.synergy/skill/integrate-llm/SKILL.md) requires facade-aware structured-output tests.

## Lessons

A schema-only tool still uses the common model transport. Its response must cross the same decoding step as executable tools, while business validation and raw evidence retain their separate responsibilities.
