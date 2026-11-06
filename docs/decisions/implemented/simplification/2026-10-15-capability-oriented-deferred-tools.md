# Decision Record: Capability-oriented deferred tools

Status: implemented

## Problem

Every primary request carried complete interactive-rendering, native Computer and built-in search definitions even when the task needed none of them. Server-name-only deferred discovery did not explain web versus AI-paper retrieval, and the broad remote web-search instructions competed with the dedicated paper tool. Reducing the initial payload without improving discoverability would preserve that ambiguity.

## Decision

Media owns a deferred `visuals` group containing only `render`. Computer Runtime owns `computer` with its three native tools. These defaults apply across primary identities; `runtime_reload`, existing delegation/DAG behavior and ordinary file/execution tools are unchanged.

MCP owns concise presentation for exactly six known tools from the built-in Anysearch and Scholight connections. They share `online` by default, while per-server and global `expandByDefault` settings retain their precedence. Actual supervisor provenance, not a matching server name, determines eligibility. Unknown tools and user-owned connections retain their original descriptions and per-server groups.

The registered MCP source supplies presentation metadata to both discovery and model resolution. The remote tool definition, schema, execution callback, authentication and timeout handling remain unchanged. Available-member summaries describe web search, AI-paper discovery and supported source reading only when their corresponding tools remain eligible after permissions, user settings and host policy. English and targeted Chinese keywords support the existing literal discovery algorithm; no semantic router is introduced.

The built-in paper contract prefers Scholight for AI literature discovery without claiming non-AI coverage. Web search covers general facts, documentation, code and broader sources. URL readers state format/rendering differences and credential requirements. No primary prompt repeats these rules. Old server expansion keys do not activate `online`; the normal unavailable-group response lists current groups without mutating stored history.

This supersedes [the resident built-in search default](../../archived/bug-fix/2026-09-06-builtin-mcp-search-expand-by-default.md). That decision's concern about added discovery cost remains relevant, but the product now supplies an actionable capability summary and explicit tool responsibilities rather than exposing only server brands.

## Alternatives considered

**Fold each server without changing discovery or descriptions.** Rejected because it preserves the vendor-selection problem and overlapping claims; reducing initial context alone does not establish correct retrieval.

**Add a universal research wrapper, an LLM router, or direct HTTP backends.** Rejected because MCP already owns connection, authentication and execution. Duplicate entry points would add failure paths and obscure actual source selection.

**Rewrite all MCP descriptions or infer ownership from server names.** Rejected because arbitrary and same-name user servers remain authoritative for their contracts. The presentation list requires built-in provenance and own-property matches for known tools.

**Hard-code provider selection or force both searches.** Rejected because known URLs, non-AI subjects, explicit user sources, mixed research and unavailable services need different valid routes. Tool descriptions express the preferred scope; execution remains an explicit model decision.

## Consequences

Fresh requests omit the deferred definitions and retain concise group summaries. First use requires expansion; expanded tools still cost context and persist through the existing Session tool state. Static tokenizer measurements describe serialization size, not provider billing or improved model outcomes. Real-provider selection evidence remains separate from deterministic catalog, transport and model-loop tests.

Raw MCP diagnostics retain remote descriptions and public IDs. Existing user overrides can keep tools resident. No persisted configuration format, execution backend, permission rule or history migration changes.
