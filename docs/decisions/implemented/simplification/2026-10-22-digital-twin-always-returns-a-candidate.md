# Decision Record: Always return a candidate instead of abstaining

Status: implemented

## Problem

Prediction could end in a third state besides a suggestion and a failure: the model declaring that no clear continuation existed. That state carried two internal enum values, its own transport field, its own client feedback path, its own evaluation denominator, and instructions in the prompt teaching the model to prefer it when a continuation would need unstated facts. It also asked the user to interpret a message that told them nothing about the conversation they were looking at.

The user does not need the product to decline on their behalf. A suggestion is an editable draft that only becomes a message when they accept it; ignoring a weak suggestion and typing their own sentence costs them nothing. Abstention therefore bought no safety the accept step did not already provide, while consuming a shared output contract, a client branch and evaluation accounting.

## Decision

The prediction schema has one outcome: `candidate` is a non-empty string. There is no abstention field in the model output schema, no abstention field in the public result contract, no abstention notice in the composer, and no `correctAbstentions` counter in evaluation reports.

The prompt states that a candidate is always returned, and that an unclear next step is answered with the most plausible operation the owner would take rather than a refusal, while inventing new facts to fill a gap remains forbidden. The grounding and verbatim-target rules are unchanged, so a candidate still has to be anchored in the current conversation.

Failure is now the only non-suggestion outcome, and it is reported as before: `source_unavailable`, `source_changed`, `model_unavailable`, `cancelled` and `invalid_prediction`. A malformed or ungrounded model response remains a failure rather than an abstention, because a response that violates the schema is not a decision the user could act on.

## Alternatives considered

**Keep abstention as the model's way to stay honest.** The honesty it protected is already protected by the accept step: an editable draft that the user declines costs nothing, and the grounding rules still forbid plausible-looking invention. What abstention actually produced in practice was a dead-end message in the toolbar and a metric that let weak coverage look intentional.

**Keep the field but always populate the candidate.** A nullable field that is never null keeps the client branch, the transport shape and the evaluation denominator alive for a state that cannot occur, and leaves a future caller guessing whether null is reachable. Removing the branch is what makes the guarantee checkable.

**Turn abstention into a failure.** Reporting "nothing to suggest" as an error would tell the user the prediction system is broken when it simply had a weak idea, which is worse than showing that weak idea as a draft they ignore.

## Consequences

Every completed call now yields text, so a prediction that would previously have abstained surfaces an editable draft the user may dismiss. Quality is measured by whether emitted suggestions are good, not by whether the model correctly declined; the evaluation report keeps predictable coverage, ambiguous-candidate and failure denominators, and provider failures stay distinct from emitted candidates.

The contract change is visible to API consumers: `DigitalTwinPrediction.candidate` is a non-empty string and `abstention` is gone from the generated SDK and OpenAPI document. This supersedes the abstention portion of [the next-input feature record](../feature/2026-10-21-digital-twin-next-input.md); its prediction, evidence and evaluation decisions remain current.
