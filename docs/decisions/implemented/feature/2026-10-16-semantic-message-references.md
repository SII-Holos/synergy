# Decision Record: Semantic message references and Workspace opening

Status: implemented

## Problem

Automatic links could absorb Chinese sentence punctuation and subsequent prose into their target. Long source URLs obscured the cited file and location, while ordinary webpage links bypassed the Desktop Workspace. A preview needed useful context without silently opening pages or borrowing a website login.

## Decision

Keep the existing mdast, marked and incremental renderers, with one shared automatic-link boundary policy in Util. Chinese sentence punctuation terminates a bare link without treating Chinese characters themselves as invalid URL content. Explicit Markdown and angle links retain their authored targets. Source offsets, copied messages and model input remain original text.

Extend the existing ResourceReference pipeline with explicit Note targets. Shared UI owns source icons, compact bare-URL labels and one interactive delayed preview; the App owns reading, cancellation and opening. Authored labels remain unchanged. File previews read their captured Workspace generation, prefer live drafts and never choose a Workspace for unresolved history. Note references share metadata-based current Scope resolution with tool resources and navigate stable block IDs without replacing the editor or changing content.

The ResourceOpenProvider instance coordinates the active preview across message renderers. A new intent revokes the previous layer and request before its own delay begins, preventing focused and hovered messages from retaining independent overlays. Compact URL projections retain distinguishing query and fragment text; colliding GitHub labels add only the required owner, ref or path context without changing source text or href.

Ordinary HTTP(S) references open a peer Browser tab when the selected Browser module and managed-local Desktop bridge are available. Reuse is restricted to a unique suitable page already open in the initiating Session. Query and fragment remain part of the target. Explicit new-tab intent creates a peer; explicit external opening and system protocols retain their host behavior. A selected but failing native Browser offers retry and system opening rather than silently changing destination. Retry resolves the original Workbench opening and request identity, including when native creation succeeded but its response was lost. Human Workspace selection invalidates pending opening and preview work reactively.

Validate the complete capability result before classifying an unsupported remote host. Incompatible versions, rejected authority and inconsistent results are failures, not external-navigation permission. Pure Web message anchors retain their browser default, including modifier, middle-button, keyboard and context-menu behavior; managed Desktop anchors use the App opener.

The optional Browser owner provides anonymous public metadata and fixed-commit GitHub excerpts. Requests use no website identity, model, executable HTML or real Browser page. Public-address validation, DNS connection pinning and redirect checks apply only to passive preview, not user-directed Chromium navigation. All DNS answers are validated before choosing a pinned address; mixed public answers prefer IPv4 to avoid an unreachable first IPv6 route. Short-lived memory caching is owner-scoped, and late results cannot cross Session, Scope, server or capability changes.

## Alternatives considered

**Fix link colors after parsing.** Rejected because the wrong href and source span would remain actionable and selection mapping would still include subsequent prose.

**Replace the Markdown stack or preprocess whole messages with regular expressions.** Rejected because existing source mapping, explicit link semantics and incremental cost must remain intact.

**Treat every filename or Note ID as a resource.** Rejected because examples, inline code and duplicate filenames do not establish resource intent or ownership.

**Fetch previews using Browser cookies or hidden pages.** Rejected because hovering does not authorize website identity, browsing side effects or native page allocation. Unavailable public metadata remains a source card with an opening action.

**Change platform.openLink globally.** Rejected because OAuth, downloads and explicit external actions have independent host policies.

## Consequences

Long bare URLs gain a readable projection without changing durable messages. More resources share the existing opener, and no second resource database or browser engine is introduced. Anonymous preview cannot summarize private or login-only documents; it reports unavailability rather than substituting unrelated content. The local Desktop and pure Web paths intentionally differ in their primary webpage destination.

The source contract lives in [Workspace and files](../../../architecture/workspace-and-files.md#message-resource-opening), the native page model in [Browser runtime](../../../architecture/browser-runtime.md), and user flows in [Browser workspace](../../../product/browser.md). This extends the [unified resource-opening decision](../architecture/2026-10-08-unified-resource-opening.md).
