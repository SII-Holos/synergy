# Decision Record: Preserve external implementation provenance

Status: implemented

## Problem

Synergy implementations may be shaped by papers, standards, upstream code and discussions, benchmarks, experiments, or research documents. When that context exists only in a conversation, commit, or pull request, the maintained code no longer explains why a formula, workaround, threshold, or copied structure exists.

## Decision

An implementation materially derived from an external source records a stable locator in a nearby `Provenance:` marker and explains the repository-specific use or deviation in `Local adaptation:`. Multi-file and generated implementations place the marker at the single authoritative source, generator, template, or manifest. Cross-cutting sources also appear in the owning decision record and pull request, while copied code, data, themes, and assets preserve applicable license obligations.

Routine language usage, direct official API calls, and general patterns without a specific material source do not require citations. Review evaluates whether provenance is required; no CI gate attempts to infer missing sources.

## Alternatives considered

- **Keep sources only in pull requests or commits** — rejected because later maintainers should not need history archaeology to understand a live constraint.
- **Maintain one central bibliography** — rejected because it separates a source from the exact formula, workaround, threshold, or asset it informed.
- **Require citations for every external document consulted** — rejected because routine documentation lookup is not material implementation provenance and would create comment noise.
- **Add an automated provenance gate** — rejected because a keyword or URL check can validate an existing marker but cannot determine whether an uncited source materially informed code.

## Consequences

External reasoning remains discoverable from the code it constrains, and reviewers can evaluate both the original source and Synergy's adaptation. Contributors carry a small documentation obligation only when a source materially informs implementation. Shipped code carries the same obligation as new code: the implementing change backfilled the known material adoptions — OKLab and WCAG color math in `packages/plugin/src/theme/color.ts`, PKCE S256 challenges across provider OAuth flows, the MCP authorization provider, the Preflight-derived reset in `packages/ui/src/styles/base.css`, and the pinned upstream workaround sites (tree-sitter-nix WASM mirror, Bun spawn/fetch/install-cache bugs) — so no legacy exemption exists. The policy does not change runtime behavior or CI.
