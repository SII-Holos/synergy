# Decision Record: Validate complete local message tables

Status: implemented

## Problem

The localization source checker rejected organization status tables selected through enum callbacks, record properties and signals. It recognized a local table only when a direct function parameter was declared as `keyof typeof table`, even though the descriptors and their extracted IDs were identical. This blocked the canonical localization gate and encouraged translation wrappers or allowlist entries without improving message validation.

## Decision

The checker recognizes a local object literal whose named entries all resolve to descriptor expressions. It resolves every entry at a table lookup and validates each ID and default message, including entries that the current index does not select. Invalid IDs, dynamic IDs, missing or empty defaults and unresolved messages remain failures. Table spreads, getters, computed keys, runtime construction and unresolved entries cannot establish a complete local table.

Index expressions do not determine whether message IDs are static. TypeScript owns index-domain validity; the localization checker owns the complete table's message content. Imported descriptors retain their existing extraction and source ownership. This rule does not infer a static local table from an unknown object or runtime factory result.

The organization catalogs include all newly extracted Simplified Chinese product copy. URL example placeholders use static descriptors with a literal URL passed as an ICU value. The optional permission-scope copy uses explicit descriptor branches.

## Alternatives considered

**Require a directly declared `keyof` parameter.** This rejects the same valid descriptors when their key comes from a typed object or reactive accessor, making syntax determine localization acceptance.

**Add typed translation adapters or allowlist entries.** These conceal an unsupported lookup without checking every descriptor in the table. Complete table resolution keeps the actual validation in the owning checker.

**Infer index types in the AST scanner.** Reconstructing imported and contextual types duplicates the TypeScript compiler's responsibility and creates partial guarantees unrelated to static message IDs.

## Consequences

Static message tables support ordinary reactive rendering while their full content remains checked. Invalid index domains remain TypeScript errors rather than localization errors. Focused checker tests cover enum, property, signal and arbitrary string indices, every invalid descriptor branch, and rejected table constructions. Canonical extraction, translation completeness and strict compilation still own catalog consistency.
