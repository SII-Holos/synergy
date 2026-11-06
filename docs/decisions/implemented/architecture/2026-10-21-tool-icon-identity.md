# Decision Record: Shared tool icon identity

Status: implemented

## Problem

Conversation activity, specialized tool cards and generic tool cards assigned glyphs independently. A single operation could appear with different icons, and settings used different identities for the same business. Adding a tool required maintaining several icon tables.

## Decision

The shared UI tool icon resolver owns tool identities, input-dependent variants and category defaults. Activity rows and tool-card triggers consume that resolver. Tool descriptions and specialized result renderers retain their existing responsibilities without their own glyph tables. Tools that represent settings or product entities reference the public semantic icon tokens. Reasoning has its own semantic identity instead of sharing performance tracing.

Workbench presentation uses the same resolver in its activity summary and specialized card. Its category classifier supplies descriptive metadata without overriding the tool glyph, so integrating new presentation tools cannot silently fall back to the generic icon in only one surface.

Execution surfaces keep separate identities instead of borrowing performance tracing. The trajectory panel and its toolbar and Kanban entries use `execution.trajectory` (footprints), execution details uses `execution.details` (logs), and task details keeps `session.context` (chart-pie) in both the toolbar trigger and the workbench launcher, because they open the same panel and must not present two glyphs for one destination. The trajectory and execution-details panels therefore no longer share a single `activity` glyph.

The selected icon vocabulary uses the existing Lucide dependency, one vendored Tabler outline and monochrome integration brand assets. Upstream provenance and the applicable license accompany the assets. The change preserves conversation ordering, grouping and detail expansion.

`ToolDisplay.icon` carries owner-declared icons through the existing tool definition and Part metadata path, including automatically expanded tools. Both presentation surfaces use that declaration before their semantic default. Plugin glyphs resolve in the plugin namespace and react to registry changes. The unused fallback-metadata lookup and its template overrides are removed instead of preserving a second presentation path.

MCP conversion prefers tool icons, then server icons. The MCP owner accepts bounded data images and same-origin HTTPS images without credentials or redirects, validates image types, rejects active SVG content and persists normalized image data. Fetch failures fall back to the semantic identity. Cached results belong to the tool-definition and connection generations. A Runtime-scoped resolver coalesces simultaneous identical icon requests and admits at most four loads at once. Queue waiting shares the original two-second deadline, so a large catalog cannot multiply that budget. Pending lookup state is released after settlement. The UI supports theme variants and image-error fallback without loading external origins while replaying a conversation.

## Alternatives considered

**Update each renderer independently.** This would preserve the cause of the mismatch and require every future change to update several copies.

**Use one glyph for every external tool.** This loses the integration identity that helps users recognize which service is being used.

## Consequences

Icon changes have one owner and reuse settings identities across surfaces. Specialized renderers remain responsible for their content and summaries. The base icon registry continues to retain stable public glyph names even when a tool stops using them.

Stored tool Parts can contain up to three image variants, each limited to 64 KiB before base64 encoding. Local MCP servers can declare data images; remote images require a matching configured HTTPS origin. Historical Parts without image metadata use semantic or known-brand defaults. No stored-state migration or replay-time network lookup is required.
