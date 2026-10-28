# Decision Record: Quiet Browser toolbar icons

Status: implemented

## Problem

Tooltips below Browser navigation icons overlap the native webpage. Its separate native surface can obscure their text while leaving part of the tooltip background visible. These familiar controls do not need an extra popup during ordinary browsing.

## Decision

Remove hover and focus tooltips from Back, Forward, Reload/Stop, external opening and Browser options. Keep localized accessible names, disabled states, hover feedback, keyboard focus and Popover trigger handling on the buttons. Other Browser menus, tab descriptions and address suggestions retain their existing behavior.

## Alternatives considered

**Keep the tooltips and hide the native page on hover.** A label for a familiar toolbar action does not justify interrupting webpage presentation or adding native visibility coordination.

## Consequences

Toolbar actions remain accessible by name and keyboard without opening floating labels. The rendered interaction regression verifies absent hover/focus tooltips, stable control bounds and normal menu opening. The [Web product contract](../../../../apps/web/PRODUCT.md#browser-daily-use-controls) owns the current interaction requirements.
