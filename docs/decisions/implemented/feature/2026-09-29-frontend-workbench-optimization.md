# Decision Record: Frontend workbench optimization

Status: implemented

## Problem

The workbench mixes cold neutral surfaces, low-contrast supporting text and inconsistent navigation density. Floating controls use unrelated timing and some secondary actions require hover, making the same interface feel different across input methods.

## Decision

The default theme defines neutral light and dark surface families in the existing structured theme source. Generated Web and Desktop startup colors follow that source. Necessary supporting text meets 4.5:1 contrast on the canvas, navigation, input, menu and selection surfaces. An input may share the raised surface color while remaining brighter than the dark canvas; extra nested surface steps are not required.

The default Sidebar width is 260px. The existing resized flag retains explicit user widths and needs no persistence migration. Rows and shared floating controls use the existing typography and motion roles. Keyboard and touch reveal the same actions as hover. Reduced motion removes overlay spatial animations.

The durable presentation requirements live in the [Web product rules](../../../../apps/web/PRODUCT.md); palette ownership remains in [Frontend themes and color](../../../reference/frontend-theming.md).

## Alternatives considered

**Component-local palettes.** They would diverge from user themes, plugin surfaces and startup fallbacks, so the structured theme remains the only color source.

**Reset every saved Sidebar width.** This would erase a deliberate user preference. Only widths that were never explicitly resized adopt the new default.

**Additional animation libraries.** These changes need interruptible CSS feedback and the existing overlay lifecycle, not another motion owner.

## Consequences

Shared colors change dependent pages as well as the main workbench, requiring both theme regression and real-surface inspection. Supporting text is deliberately stronger, while borders and decorative emphasis remain quiet. Custom themes and user font choices retain their ownership.
