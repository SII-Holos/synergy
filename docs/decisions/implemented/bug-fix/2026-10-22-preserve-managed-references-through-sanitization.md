# Decision Record: Preserve managed references through sanitization

Status: implemented

## Problem

Markdown rendering and HTML sanitization disagreed about which attribute may carry a managed reference. The Markdown renderer writes `data-resource-reference` and never a resolvable URL, so the resource observer can resolve it to a same-origin URL at bind time. Raw HTML authored by a model or user takes the other path: `src` and `href` hold the reference directly, DOMPurify's URI allowlist admits only browser-native schemes, and the value is dropped without any error. An `<img src="asset://…">` rendered as an empty image, and an `<a href="asset://…">` became a link that did nothing on click. The same loss covered `srcset`, `poster`, `audio`, `video`, `track` and `note:` references, while `<iframe>`, `<object>` and `<embed>` disappeared entirely because they are forbidden tags.

A second gap sat downstream of rendering. A reference whose target no longer exists — a deleted file, or artwork written under an ignored build directory — was attempted anyway. An image became a broken frame or silently lost its `src`, and a citation kept a live affordance that failed only after the click. Repeated clicks on one dead reference stacked an error toast per click, each repeating a generic title that could not distinguish a missing file from an unbound workspace or a path outside it.

## Decision

Managed references are preserved by rewriting them, not by widening the allowlist. `sanitizeHtml` runs an isolated DOMPurify instance whose attribute hook moves a reference from `src`, `href`, `srcset`, `poster`, `data` or `track` onto `data-resource-reference`, recording the originating attribute in `data-resource-attribute`. The URI allowlist stays untouched: `javascript:` and unsupported schemes are still removed, because only a reference `ResourceReference.parse` understands is preserved. Schemes are lowercased so `ASSET://` resolves like `asset://`. One element carries one managed reference, and a secondary attribute holding a second reference is dropped rather than left half-resolved. An element hook swaps a forbidden `iframe`, `object` or `embed` carrying a managed document for an inert carrier before removal, so the embedded document stays reachable as a link.

The observer's binding and activation surfaces follow the same vocabulary. Media elements receive their resolved URL on the attribute the sanitizer recorded and keep native playback and controls without opening a workbench panel; only an image or an explicit carrier activates a resource. A `srcset` list collapses to its single managed target, because a content-addressed asset describes one piece of media rather than a set of density variants.

Availability is decided before anything is drawn. The controller answers `inspectReference` for media references, reporting `ignored`, `missing`, `missing-asset`, `outside-workspace` or `unbound-workspace`; a path the workspace view excludes is unavailable even while its bytes exist, because the reference can neither render nor reopen through the workspace routes. An unavailable reference renders a placeholder stating its path and reason instead of a broken image or a live citation. Asset probes use a HEAD request against the immutable content-addressed route, and one inspection is shared by every occurrence of the same reference. Text citations stay lazy: inspecting each one would issue a request per reference in long documents, and their failure is already reported when opened. An image that fails to load while its target is known to exist keeps the older degradation to an openable link, which is how a non-image attachment authored with image syntax stays reachable.

Repeated failure notices share a toast key, so a second click on the same dead reference returns the visible toast instead of stacking another, and the open-failure description names the specific reason.

## Alternatives considered

**Add `asset:` to the sanitizer's URI allowlist.** Rejected because the sanitizer is only the first gate: the SPA policy's `img-src` does not match the scheme, so the browser blocks the load anyway, and the reference would still need the observer to resolve it after sanitization — two failure points for one requirement.

**Resolve the URL into raw HTML before sanitization.** Rejected because resolution depends on a reference context available only in the client, and embedding an absolute server URL in message content would break when the workspace binding generation changes.

**Inspect every reference, including text citations, before rendering.** Rejected because a long document carries thousands of citations, so one request each turns rendering into a request storm for a failure that is already reported on click.

**Treat an ignored path as available because its bytes exist.** Rejected because the workspace routes refuse the path, so the reference would render and then fail on open — the same dead affordance this change removes.

**Degrade every failed image to a plain link.** Rejected for known-unavailable targets, where it hides the reason; retained for targets that exist but cannot decode as images, where the link is the only way to reach the resource.

## Consequences

Raw HTML and Markdown syntax now reach the same resolution path, so an authored reference renders and opens whenever its workspace equivalent would. The sanitizer gains one stateful instance per window and two hooks; its non-DOM guard is unchanged. Media references accept one pre-render existence probe per distinct target, bounded by reference count rather than occurrence count, while text citations accept that a missing file surfaces on open rather than on render. A placeholder now occupies space where a broken image used to collapse, which changes how an unavailable reference looks in a long transcript.

Verification covers the sanitizer contract for every carrier and scheme, the observer's media binding and availability placeholders, the lazy text-citation boundary, and a real isolated runtime where a seeded assistant reply containing all of these forms rendered with no broken images, both placeholders naming their path and reason, an image opening its preview, a document link opening its attachment view, and four consecutive clicks on one dead citation leaving a single toast.
