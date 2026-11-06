# Decision Record: DAG cards convey status with fill instead of borders

Status: implemented

## Problem

The DAG read as unevenly outlined. Cards carried a 1px border whose colour came from two unrelated scales: the resting card used `--border-weak-base` (light theme `#00000014`, about 8% black), while hover and ready swapped to the opaque `--border-weak-hover` (`#d7d7d7`), and `running`/`completed`/`blocked`/`failed` swapped to fully saturated status borders (`#3B82F6`, `#89ce96`). On one screen a nearly invisible outline sat beside a solid blue rectangle, so the graph looked like an inconsistent set of frames rather than one system.

The toolbar had the same problem in miniature: a bordered container wrapping buttons that had no border of their own, which reads as a nested double frame.

The settings surface already solved this: controls there drop borders entirely and separate themselves with a filled background from `--surface-inset-base`, a 10px radius, and a hover fill from `--surface-inset-base-hover`. Two visual languages for the same kind of object in one product is the actual defect.

## Decision

The [DAG stylesheet](../../../../packages/ui/src/components/dag-graph.css) drops the card border and uses the settings fill language instead. A resting card is `--surface-inset-base` at `border-radius: 10px`; hover and ready move to `--surface-inset-base-hover`; status colours stay on the same weak surfaces already used for their backgrounds (`--surface-success-weak`, `--surface-info-weak`, `--surface-warning-weak`, `--surface-critical-weak`). Selection uses `box-shadow: 0 0 0 1.5px var(--border-interactive-base)` rather than an outline, so the ring does not add a frame to the layout box.

The controls container becomes a single filled pill on `--surface-inset-base` with `border-radius: 10px`, and its buttons are transparent with `--surface-inset-base-hover` on hover. `border: 0` is stated explicitly on both the container and the buttons rather than inherited from the global preflight, so the component holds its appearance when mounted without the host stylesheet.

Status is still carried by three independent channels: the card fill, the status dot, and the status label text. Removing the coloured border therefore does not make status colour-only.

Card padding constants in [the layout module](../../../../packages/ui/src/components/dag-graph-layout.ts) drop by the 2px the removed border used to contribute (`CARD_PAD_Y` 26 → 24, `CARD_PAD_X` 30 → 28), keeping the measured content box identical.

## Alternatives considered

**Keep borders but make every status border equally faint.** This fixes the unevenness but keeps two nested frames on the toolbar and diverges from the settings surface, which the product already treats as the reference for control styling.

**Keep borders only on the active statuses.** That is the current behaviour and the source of the complaint; a solid blue frame next to an 8% outline is exactly the inconsistency being removed.

**Use a shadow ring on every card instead of a border.** `box-shadow` does not affect the layout box, so it would let the ring live outside the card, but a ring on every card reproduces the same double-frame reading the toolbar showed, and shadow stacks get muddy once cards overlap edges at low zoom.

**Introduce a component-local surface alias instead of the canonical tokens.** The repository requires consumer colour utilities to name canonical tokens; `--surface-inset-base` is already in the published theme contract, so a new alias would be an unregistered parallel name.

## Consequences

Cards are distinguished from the canvas by fill alone. In the light theme that is `#F0F0F0` on white; in the dark theme it is `#292929` on `#242424`, a 5-step difference that is visible but quiet. If a future theme makes those two surfaces converge, the card edge would disappear; the guard is that both tokens come from the canonical resolver's layered scale, which keeps adjacent surfaces ordered.

The DAG now shares one control language with settings, so a border on this surface no longer signals anything in particular. Anything that later needs to stand out has to use selection fill or the interactive ring rather than re-adding a border.
