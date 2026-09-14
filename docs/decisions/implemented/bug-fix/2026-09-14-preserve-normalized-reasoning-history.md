# Decision Record: Preserve normalized reasoning history

Status: implemented

## Problem

Provider message normalization participates in both prompt budgeting and final request preparation. Moving interleaved reasoning out of message content made a second pass replace the encoded reasoning with an empty string, changing the history sent to the model.

## Decision

Normalization retains a string-valued `openaiCompatible.reasoning_content` when no reasoning parts remain in the assistant content. Explicit reasoning parts are authoritative, including an empty part; absent reasoning still produces the required empty field. Other provider options remain intact. The invariant lives in [the LLM loop](../../../architecture/llm-loop.md#prompt-budget).

## Alternatives considered

**Remove one normalization stage.** Budget estimation and final preparation both consume provider-ready messages. Removing either transformation would require a broader pipeline change and could make estimation differ from the actual request.

**Mark messages as already normalized.** An extra marker would introduce state across stages and could skip fresh content inserted by later transforms. Preserving the actual encoded value keeps normalization repeatable without an additional protocol.

## Consequences

Reasoning survives repeated normalization while later explicit reasoning can replace it. Regression tests cover repeat application, fresh and empty overrides, unrelated metadata, and assistant messages without reasoning. The fix does not reconstruct reasoning lost from earlier requests; historical experiments retain their original evidence.
