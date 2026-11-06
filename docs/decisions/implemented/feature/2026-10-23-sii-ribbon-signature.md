# Decision Record: SII ribbon signature and ambient motifs

Status: implemented

## Problem

The SII mark is present in brand assets but has no relationship to the everyday workbench. A prominent logo or a replacement running indicator competes with activity and reading rather than making the visual identity useful.

## Decision

Limit the treatment to two explicitly selected interactions: a ribbon flowing from a newly completed reply's final line into its small completion signature, and sparse pixel ribbons in the existing welcome background that reveal color near the pointer. The [Web product contract](../../../../apps/web/PRODUCT.md) owns the interaction rules. The existing SII asset in `apps/web/public/brand/sii-logo.png` supplies the folded silhouette and palette reference.

The completion effect is decorative. Existing foreground outcome and conversation motion admission determine eligibility; historical arrival, virtual remount, background completion and reduced motion remain static. Status and actions are available independently of the animation, and the effect cannot change transcript layout or request scrolling. Non-success states do not acquire a success signature.

Geometry follows the actual last text line and footer. The ribbon clears the text baseline before turning toward the signature. The fold stays beside the completion row, at most six pixels above its final center, rather than occupying a separate high staging position. Its width is bounded by the reserved icon column and adjacent gap, while available whitespace can reduce it to signature size. Shrinking finishes before the short downward settle; overlapping source and destination settle statically. Normal streaming-to-terminal Markdown replacement can rebind the current line without admitting another animation or resetting its clock. Browser regressions inspect painted color, distance from the completion row and text/control intersections during travel, fold and docking, not only the final SVG.

The welcome field retains its independent clock and cached pixel drawing. Pointer observation is passive and local to the owning pane. Only ribbon motifs gain color; the existing motif density, game controls and Composer behavior remain unchanged. Reduced motion keeps geometry still and changes proximity color immediately. Hidden state and disposal clear pointer ownership.

Three public decorative roles, `brand-ribbon-start`, `brand-ribbon-middle` and `brand-ribbon-end`, resolve for every theme. Synergy's structured theme selects the SII green, cyan and violet; other skins use their primary scale unless overridden. Imperative drawing flattens the resolved theme roles, including on same-mode skin changes. No status palette doubles as brand decoration.

## Alternatives considered

**Replace the running spinner with ribbon arcs or a rotating mark.** The visual comparison did not improve the running state, and the user explicitly dropped that direction. Existing running indicators remain unchanged.

**Flow from the user's prompt around the entire reply.** This longer B2 path crosses more reading content. The selected B1 starts at the assistant reply's end and keeps the completion gesture local.

**Add a ribbon game or a send effect.** Both were explored in the prototype but are outside the selected two interactions. Existing welcome games and send feedback remain intact.

**Hardcode the original palette in each renderer.** This would create independent color paths for the conversation and welcome canvas and prevent custom themes from controlling them. Shared roles keep one validated color source.

## Consequences

The workbench gains a restrained SII reference without changing the meaning of task states or adding a control. The signature is a bounded exception to ordinary short interface motion, with static presentation when motion is not admitted. Historical success keeps a small mark but never replays the flourish.

The welcome renderer adds one motif and one colored bitmap, reused across frames. Pointer updates perform only local coordinate observation; frame rendering does not rebuild the palette or repaint cached motif cells. The public token set grows additively, so exhaustive downstream token maps require the new keys; existing seed-only themes continue to resolve without serialized changes.
