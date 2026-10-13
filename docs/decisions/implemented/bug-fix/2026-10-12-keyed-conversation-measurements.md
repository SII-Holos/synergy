# Decision Record: Keyed conversation measurements

Status: implemented

## Problem

Conversation disclosure removes and inserts rows inside a virtual list. Stable DOM identities alone cannot preserve geometry when the virtualizer retains measurements by index. A surviving long answer can briefly inherit an exiting process row's small size, reduce the scrollable range and displace the reader before remeasurement restores it. The incident is recorded in the [postmortem](../../../postmortem/0068-conversation-measurement-identity.md).

## Decision

The pinned Virtua Solid Virtualizer accepts an optional stable unique `itemKey`. It transfers retained measurements to their new indices before publishing an edited list, invalidates derived offsets, discards removed measurements and leaves new identities unmeasured. Equal-length replacements and reorderings participate in the same path. Existing prepend compensation remains controlled by `shift`.

Both the outer conversation and bounded process virtualizers supply their canonical row keys. The correction lives beside the dependency's measurement owner and is applied to its JavaScript and JSX entrypoints. Reading anchors continue to preserve human intent; disclosure retains its existing motion and DOM lifetime. See [dependency patches](../../../../patches/README.md#virtua-solid-measurement-identity) for provenance and the upgrade contract.

## Alternatives considered

**Adjust easing or restore the reading anchor again.** Neither prevents the temporary invalid scroll range and native clamping before the subsequent correction.

**Remount the virtualizer after each structural edit.** A fresh cache avoids index reuse but discards measured geometry, mounted focus, selection and content continuity.

**Use `shift` for middle edits.** It describes changes at the start of a list, so its index movement and compensation do not match arbitrary process removal or insertion.

## Consequences

Opted-in structural edits require a linear identity map and size transfer. Ordinary scrolling reuses memoized keys; body-only updates retain their measured rows. New rows still need estimation and measurement, so this correction does not promise to eliminate every source of streaming layout movement.

Browser regressions assert retained sizes before the next resize delivery, continuous answer DOM identity, reading position at each frame, and prepend behavior. Real conversation disclosure is covered with a long answer in wide and narrow layouts, light and dark themes, and reduced motion. Dependency upgrades must preserve both published entrypoints and the existing Markdown initialization contract.
