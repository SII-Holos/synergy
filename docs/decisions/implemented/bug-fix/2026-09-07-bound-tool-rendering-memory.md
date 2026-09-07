# Decision Record: Bound tool rendering memory

Status: implemented

## Problem

Tool detail presence checks evaluated Solid child getters before expansion, creating detached code renderers and retaining their theme subscriptions while the tool owner lived. File and diff highlight caches limited entry counts without accounting for expanded syntax trees. String admission queues retained promoted strings independently of their bounded maps. The legacy multi-edit renderer also invoked a keyed Solid callback value as a function, producing a reproducible tool-local TypeError. Large tool results also multiplied source text into syntax trees and DOM inside the conversation.

## Decision

`BasicTool` checks child-property presence or an explicit `hasDetails` value without evaluating children. Detail renderers mount on expansion and clean up on collapse. Legacy multi-edit reads its keyed diff value directly; a real Solid regression test covers the object-valued preview path.

File and patch tool cards use plain previews capped at 80 lines and 8 KiB of UTF-8 text per block; ranged file reads show at most three blocks. File links open the current workspace file in the File panel. Patch links open the recorded tool result in Review through a generated SDK message lookup. Persisted panel state contains only tool identity and a selected path, never the patch. Review preserves the available recorded patch; backend-truncated snapshots cannot be reconstructed by this presentation change.

The two Pierre worker pools share an estimated 32 MiB result-cache budget, with a 4 MiB admission limit per result and the existing 100-entry limit per cache. Weight includes strings and structural overhead, with cycle detection and an early oversized-result exit. A narrow Bun patch exposes a typed cache factory in Pierre 1.3.3 while preserving its existing LRU interface. Code and patch inputs above 32,768 UTF-16 code units or 2,000 lines bypass rich rendering; explicit review retains complete plain text. Plain Code rendering preserves wrap/scroll selection, requested line ranges and their original line endings, and optional virtualizer buffer heights. Before/after diff inputs above the threshold use plain-language rendering.

String interning uses bounded insertion-ordered maps for both admission and retained values: 2 MiB for interned strings and 256 KiB for each admission map, alongside count limits. Individual strings above 64 KiB are not admitted. Promotion removes the admission reference immediately.

## Alternatives considered

**Only reduce entry counts.** A few large expanded syntax trees can dominate memory even with a small item limit. Shared weighted eviction makes the retained-result limit independent of file sizes and layout choice.

**Keep rich inline results and add virtualization.** Virtualization reduces visible DOM but does not prevent full-source highlighting or duplicate hidden renderer construction. Lightweight previews remove that work from the conversation; dedicated panels retain inspection access.

**Store complete patches in panel state.** This duplicates large content into persisted workspace state. Stable tool identity allows an explicit, cancelable lookup without another durable payload copy.

**Reopen every patch as the current workspace file.** Later edits can change the file, so that would lose the historical operation being inspected. Review resolves the recorded tool result; file links explicitly say they open the current file.

## Consequences

Conversations give up inline syntax coloring and large expanded bodies in exchange for bounded previews and fewer renderer lifetimes. Large explicit views give up rich diff layout and line selection where plain rendering applies. Reopening an evicted small result recomputes its highlighting. The local dependency patch must be revalidated when Pierre is upgraded.

Budgets constrain retained caches and inline presentation, not total process heap: active message payloads, explicit panel contents, worker engines, in-flight results, and other application state remain separate owners. These fixes address reproduced retention and rendering defects; they do not establish the cause of an untraced minified TypeError or prove that all long-running renderer crashes are eliminated.

Behavioral coverage checks closed/open/closed renderer lifetimes, bounded Unicode previews, locale-reactive panel actions, complete recorded patch selection, global cache eviction, oversize rejection, and string promotion capacity.
