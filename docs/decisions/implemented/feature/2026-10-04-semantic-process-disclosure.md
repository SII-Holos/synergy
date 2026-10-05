# Decision Record: Semantic process disclosure and tool objects

Status: implemented

## Problem

One process entrance hides two separate reading tasks: following the assistant's intermediate explanation and inspecting one uninterrupted sequence of tool calls. Removing batch disclosures exposes all tools together. Model-authored intent can also replace existing path or command information, making it hard to identify what a call touched. A bounded window whose scrollbar is hidden by the operating system has little indication that more operations exist.

## Decision

The outer process retains intermediate prose in chronological order and leaves the final answer visible when closed. Each contiguous tool/reasoning batch owns a second disclosure and the existing bounded virtual scrolling window. Parent actions do not overwrite child choices. Stable logical identities survive prepend, virtual chunks and closed parents; active parallel calls and protected reading prevent automatic collection. Search reveals the outer process and the target batch.

Tool rows prioritize the existing registered action and structured object. Paths preserve directory context and filenames; commands and search targets use monospace text. Missing targets fall back to model intent or registered titles. Row activation continues to select the existing right-side execution panel by invocation identity. Dedicated renderers and approval actions keep their existing owners.

Both App and shared UI use the same deterministic summary presentation. Only completed calls contribute successful category facts; total counts retain failed and incomplete attempts. The compact summary API does not include qualified file identity, so the App counts file operations instead of guessing unique files or loading all bodies. No provider call, message migration or API contract is added.

Window presentation follows [Process stability](../bug-fix/2026-10-05-conversation-process-stability.md): stable native scrollbar space, flat alignment, layout-free edge fades and a quiet local Latest control. The existing scroll containment remains: changing edge chaining awaits actual trackpad and touch evidence. Desktop tool rows use a 32px minimum; coarse pointers use 44px. Bounds and reading-anchor ownership continue to follow the [bounded process window decision](2026-10-04-bounded-process-windows-and-system-event-details.md).

Provenance: [VS Code tool groups](https://code.visualstudio.com/docs/agents/run/tools), [VS Code display settings](https://code.visualstudio.com/docs/agents/reference/ai-settings), [Claude Code transcript inspection](https://code.claude.com/docs/en/interactive-mode), [Cursor file review](https://cursor.com/learn/reviewing-testing), and the user-provided Codex desktop screenshot informed the information hierarchy. Local adaptation: Synergy retains its own summary/body budgets, deterministic facts, semantic theme tokens and invocation-owned right panel. These references do not establish competitors' default expansion states, viewport measurements or scroll chaining.

## Alternatives considered

**One disclosure for the whole process.** It does not let users read intermediate prose while selectively inspecting only one batch.

**Remove the bounded window.** Very long tool sequences would dominate the conversation and obscure adjacent explanations.

**Use model-authored intent as every row's main label.** Intent explains purpose but does not reliably identify the concrete object or prove success.

**Load all results to count unique files.** This would defeat lazy body ownership and bounded rendering. Operation counts remain truthful with the existing summary contract.

**Add inline tool-result expansion.** This duplicates the existing execution panel and creates an unnecessary third disclosure layer.

## Consequences

Two controls serve different scopes and require explicit keyboard, reading-anchor and parent/child state coverage. Compact summaries cannot claim exact unique-file counts without qualified identity evidence. More discoverable scrolling and concrete objects improve inspection while preserving bounded body leases and existing result ownership. Fine-pointer and physical touchpad behavior still require device-specific acceptance beyond Chromium automation.
