# Decision Record: Layer render authoring guidance

Status: implemented

## Problem

The render tool combines two authoring modes, native components and HTML. Its description repeats the mode preference and enumerates native fields already exposed by the parameter schema, while nonstandard host APIs and execution rules must remain available for correct output. Removing prose indiscriminately would hide relationships and safety conditions that the schema does not convey.

## Decision

The description separates mode selection, shared lifecycle and output, native UI relationships, and HTML authoring. Mode selection appears once. The native section retains a minimal example and the ordered references, parent and control-state relationships, stable identities, numeric requirements and size limits that need prose. The parameter schema continues to define component fields, enums and structural constraints.

HTML guidance retains sandbox and resource restrictions, the exact host API signatures, state and confirmation semantics, canonical theme tokens, responsive behavior and motion/accessibility requirements. Saving state or changing local controls does not request inference. Follow-ups require the existing human confirmation, and a successful tool call proves source creation rather than rendered verification.

No tool schema, host API, execution callback, validation limit, source-version format or state persistence changes. The existing visual group loads the complete description; no additional Skill or help tool is required.

## Alternatives considered

**Drop the host API reference to minimize tokens.** Rejected because these interfaces are not standard HTML and the model cannot infer their signatures, callbacks or authority from the tool's input schema.

**Move the authoring guide into another mandatory Skill.** Rejected because it adds a selection and loading hop without an existing independent consumer or evidence that the added indirection improves results.

**Loosen the native schema or remove nonstructural constraints.** Rejected because authoring compactness does not justify losing deterministic validation or hiding cross-field requirements until execution fails.

## Consequences

The loaded description is shorter and each section owns one decision or behavior. The strict native schema remains the larger part of the expanded definition. Token counts measure serialized instructions, not provider billing or visual quality. Existing tool, state and browser fixtures verify unchanged behavior; real-model generation quality requires separate provider evidence.
