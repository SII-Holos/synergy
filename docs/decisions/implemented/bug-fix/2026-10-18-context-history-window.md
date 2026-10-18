# Decision Record: Bounded context history window

Status: implemented

## Problem

Fitting hundreds of retained requests into a narrow trend chart makes individual bars difficult to read or select. Browsing history must also preserve request alignment, independent vertical scales and the reader's position as new requests arrive.

## Decision

The plot fits 24 requests or grouped rounds into its visible width and renders the retained history on one horizontally scrollable track. Token bars and elapsed points share that track; axes and the existing controls stay outside it. Native trackpad/touch scrolling and keyboard navigation move through history without another slider or navigation row. The viewport defaults to the latest entries. Scrolling back to its latest edge or choosing Return to latest clears historical selection and reloads the current tail. The dashboard saves the first visible request identity alongside its existing navigation state. Incoming updates and prepends retain a manually browsed position; explicit request selection reveals the selected entry. Keyboard focus pins the viewport, and arrow navigation across an edge advances it while retaining focus. Successful earlier-page reads open the oldest loaded window; failed or superseded reads do not move it.

Both vertical ranges use only the visible entries, retaining five independently calculated ticks. Category changes are calculated from the complete retained sequence before selecting the visible window, preserving the first visible request's predecessor and all recorded gaps. The existing bounded history storage and on-demand paging remain unchanged.

## Alternatives considered

**Compress every retained request into the viewport.** It preserves an overview but makes individual requests impractical to inspect as history grows.

**Add a separate slider and paging toolbar.** This duplicates native scrolling and changes the established chart layout. Direct plot scrolling keeps the existing surface.

**Sample or aggregate requests to keep a fixed number of columns.** That can hide spikes, gaps and individual request details. A bounded window preserves every recorded entry.

**Scroll only the bars under a fixed timing overlay.** The two series would describe different request coordinates. Window navigation moves both together.

## Consequences

Narrow charts retain usable bar widths and keyboard access, while older requests require navigation. Vertical ranges can change when the reader moves the window; a peak outside the visible range cannot flatten the current chart. The saved anchor uses an existing retained request identity and clamps to available history if that entry is evicted. Regression coverage checks live following, manual anchoring, edge focus, selection, delta continuity and display-state restoration.
