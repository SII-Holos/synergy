# Decision Record: Shared tool icon identity

Status: implemented

## Problem

Conversation activity, specialized tool cards and generic tool cards assigned glyphs independently. A single operation could appear with different icons, and settings used different identities for the same business. Adding a tool required maintaining several icon tables.

## Decision

The shared UI tool icon resolver owns tool identities, input-dependent variants and category defaults. Activity rows and tool-card triggers consume that resolver. Tool descriptions and specialized result renderers retain their existing responsibilities without their own glyph tables. Tools that represent settings or product entities reference the public semantic icon tokens. Reasoning has its own semantic identity instead of sharing performance tracing.

The selected icon vocabulary uses the existing Lucide dependency, one vendored Tabler outline and monochrome integration brand assets. Upstream provenance and the applicable license accompany the assets. The change preserves conversation ordering, grouping and detail expansion.

## Alternatives considered

**Update each renderer independently.** This would preserve the cause of the mismatch and require every future change to update several copies.

**Use one glyph for every external tool.** This loses the integration identity that helps users recognize which service is being used.

## Consequences

Icon changes have one owner and reuse settings identities across surfaces. Specialized renderers remain responsible for their content and summaries. The base icon registry continues to retain stable public glyph names even when a tool stops using them.
