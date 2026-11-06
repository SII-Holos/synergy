# Decision Record: Single-source discovery guidance

Status: implemented

## Problem

Group registrations carry a capability description and a separate expansion hint, but the current model directory and discovery search consume only the description. The unused hint can contain the only explanation of a useful selection condition. Unused table builders and an independent MCP directory port preserve a second representation with tests that do not exercise the model-visible path.

## Decision

Group descriptions own capability scope and the conditions that distinguish a group from its neighbors. The initial `expand_tools` directory and `search_tools` use that same description after caller availability filtering. Expansion mechanics stay in the discovery-tool instructions. Built-in registrations, normalized group information and orchestration folding do not carry `whenToExpand`.

The unused group-table builders, MCP snapshot directory and its Harness port are removed. Live MCP entries remain the source for discovery and model definitions. Tests retain actual discovery, complete authorized member lists, expansion, transport and model-loop behavior rather than obsolete rendering limits.

Plugin API4 keeps accepting and preserving the public `whenToExpand` property. It is deprecated authoring metadata, not a discovery signal. Harness normalization drops it before building group information; the declared description remains authoritative. No stable plugin field, manifest family, tool permission or execution behavior changes.

## Alternatives considered

**Display both descriptions and expansion hints.** Rejected because it repeats each capability's purpose and the common expansion operation, while creating two places for routing information to drift.

**Delete the public plugin property.** Rejected because source compatibility belongs to the stable API4 promise. A narrow normalization step preserves old definitions without retaining a second internal model.

**Retain the old MCP directory as a fallback.** Rejected because no production consumer needs it and the current available-entry pipeline already owns permission and workspace filtering.

## Consequences

Selection information has one model-visible home. Removing the unused hints reduces maintenance rather than model tokens; shorter group descriptions independently reduce the directory's actual serialized cost. Full schemas still load after expansion, and their invocation conditions remain useful because expanding a group is not invoking a tool. Stored expansion state and remote MCP contracts are unchanged.
