# Decision Record: Unified feature-page presentation and contextual details

Status: implemented

## Problem

Agenda, Kanban, Library, Performance and Plugins contain different content types but share browsing, filtering, inspection and recovery tasks. Their page controls and details have inconsistent hierarchy, density and responsive behavior. Inline inspection competes with list space, narrow layouts obscure installation state, and agenda creation does not submit the selected Scope.

## Decision

The five pages use the App-owned [AppPanel](../../../../apps/web/src/components/app-panel.tsx) for headers and semantic page tabs, with shared Dialogs and controls for interaction behavior. The standing visual and responsive rules live in [the product specification](../../../../apps/web/PRODUCT.md#feature-pages). Product-specific layouts stay in the Web application; the shared UI package remains independent of feature data and copy.

Library and plugin discovery use bounded browsing areas. Library memory and experience inspection and agenda details use centered wide Dialogs with retained underlying lists. Narrow dialogs fill the viewport. Agenda forms guard unsaved dismissal and preserve failed input. Creation uses the selected Scope and editing keeps the item's owner and unsupported trigger configuration.

Query identity owns accepted results and selection. Library groups load and recover independently; obsolete responses cannot replace a changed query. Plugin search keeps catalog source in its identity. Agenda detail history refreshes on reopening and execution-state changes, and only the latest request for the item's Scope may publish its result. Kanban adapts rendered columns and its focus selector without writing responsive measurements into persisted preferences. Performance preserves snapshot ownership while grouping diagnostics under four primary metrics and distinguishing unavailable counters from zero.

Rendered typography uses feature-owned roles, preserving global legacy utility meanings. The same scope covers actual Markdown and message readers, whose shared default would otherwise retain a larger body size. A composed Markdown regression checks feature body and heading roles alongside an unchanged main-conversation control. Brand-image backing belongs to the canonical theme contract and remains a neutral light surface in either mode. A plugin's name initial stays visible while remote artwork loads or fails; successful artwork retains its original colours and proportions. Product icons distinguish follow from activity, permissions from source verification, and diagnosis from exploration. Exclusive controls reuse the shared radio implementation rather than button-only selected styles.

Detail overlays retain their parent context through approvals and editing. Removed triggers recover focus to a stable surviving item or page entry. Async failures remain local to their data group, and retry cannot leave focus outside a modal. Unknown prices, authors, timestamps, browser measurements and trace metadata must not be manufactured from missing fields. Compact usage rankings preserve cost precision and accounting provenance; month calendars and board layouts preserve selection and user preferences across size changes.

Diagnosis polling belongs to the current analysis operation and session. Starting, cancelling or disposing an analysis invalidates earlier reads, so a delayed running response or polling failure cannot replace a confirmed cancellation or revive its timer.

Plugin reading presents declared capability counts before optional full definitions, with permissions visible before installation. Known host-generated feature and access descriptions use the application locale; author-supplied copy remains verbatim. Diagnostic values keep units adjacent and place sampling source and coverage in a separate supporting line. Resting Kanban Scope context does not become an activity status.

Development proxy rules match complete API namespaces. The plugin API prefix must not capture the plugin marketplace route; a real Vite and HTTP regression test verifies both frontend navigation and backend forwarding.

Kanban ordering keeps the existing menu selection and focus-return behavior. Its native trigger handles keyboard opening locally because the installed Kobalte scroll helper repeats a scroll ancestor beneath the workbench's overflow-hidden root. The regression fixture uses standards-mode HTML and the actual scroll-container context, rather than a standalone trigger on a freely scrolling document.

Stable Kanban pane keys preserve mounted message trees while the pane renderer receives the current data accessor. A late navigation snapshot can replace an unavailable placeholder with a live session, update its title, or switch the focused session without retaining an obsolete pane object. Scope data and action targets follow that same current identity; same-key updates preserve the draft and input node. Focus activation belongs to the pane action group beside follow and pin, rather than a clickable parent or an external label. Selecting a pane moves keyboard focus into it. Compact pane headers separate the full-width context from the action row to keep the Scope and status readable. Explicit minimum-width ownership and a bounded grid header prevent long titles from expanding phone selectors; their width also accommodates the full 44px action row without clipping.

Kanban initializes layout measurements and its resize observer after the container mounts. The first reorder uses the same 240ms timing as later reorders, and a live reduced-motion change cancels active movement immediately.

Day and week calendars allocate card height from two title lines, the start-time line and padding. Calendar events provide trigger times without an execution duration, so readable display height owns collision grouping without changing the trigger's time-axis position. Columns reserve readable lane widths and share one scroller with their sticky date headers; late events receive enough trailing canvas space to remain visible. Full-title Tooltips reuse the native event button's keyboard focus. Tests inspect text bounds, nearby-card intersections, header alignment and end-of-day scrolling rather than treating a visible button as proof of readable content.

## Alternatives considered

**Visual adjustments within the existing page structures.** The agreed scope requires reorganizing reading, inspection and management workflows. Keeping inline details and inconsistent toolbars would preserve their space and context problems.

**A separate feature-page component system.** Existing AppPanel, Dialog, tab, menu and theme primitives already provide the required foundations. A second set would duplicate keyboard, focus, theme and responsive behavior and make subsequent pages diverge.

**A single delivery of unrelated global frontend changes.** The chosen page ownership is limited to these five destinations and their child flows. Extending the implementation to the main conversation, input or global sidebar would overlap other work and is unnecessary for the shared page presentation.

## Consequences

Browsing and management share a consistent header and detail model while retaining their current SDKs, data models, permissions and plugin lifecycle. No server route, public SDK type or persisted schema changes are required. Page-owned styles must override the workbench-sized defaults of shared tabs explicitly, and page tests must validate rendered geometry as well as selection.

Dialogs retain lists and query context but require focus recovery when a retry or action removes its own control. Responsive board layout preserves user preferences but may display fewer columns than the saved preference permits. Snapshot and unavailable-state tests remain necessary because grouping metrics must not manufacture health conclusions or sampled data.

A single diagnostic sample uses a visible point and its actual timestamp as the only time-axis label. The surrounding one-minute display domain gives that point space without representing additional samples or a historical trend; the default linear-scale expansion around an epoch timestamp is unsuitable for this case.
