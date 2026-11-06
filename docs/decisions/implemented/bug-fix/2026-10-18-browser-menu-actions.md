# Decision Record: Observable browser menu actions

Status: implemented

## Problem

Webpage zoom changed the native page behind the menu's still cover, making successful changes appear inert. Concurrent or stale zoom replies could also replace newer state. Cancelling the macOS print dialog returned “Print job canceled”, which was incorrectly presented as a browser failure. The agent-page action was rendered as a switch even though its implementation performs one explicit selection.

## Decision

Zoom and viewport choices dismiss the menu before operating on the native page. Zoom values advance from the latest requested factor; completion and state-read replies can update them only while their navigation and request generation remain current. A failed zoom refreshes the actual factor. Known print cancellation reasons resolve as cancelled; genuine printer failures still reject.

View agent page is a plain action, available only when the current task has an agent page target. It performs the existing explicit selection and never enables automatic tab switching. Other menu actions retain their existing ownership and authority.

## Alternatives considered

**Refresh the still cover after each operation.** That adds a screenshot-based update path while continuing to hide the real page. Dismissing the menu directly reveals native rendering.

**Treat every printing failure as cancellation.** That would hide genuine printer errors.

**Turn the agent action into persistent automatic following.** That would change human selection semantics and is outside the existing explicit-selection contract.

## Consequences

Each zoom or viewport menu action immediately returns to the webpage; repeated zoom is also available through native keyboard shortcuts. Regression coverage includes delayed replies, rapid input, action availability, native-cover release and the cancellation reason observed from the macOS print dialog. Genuine printer failures remain distinguishable from dismissal.
