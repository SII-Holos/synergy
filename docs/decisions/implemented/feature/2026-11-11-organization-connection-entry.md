# Decision Record: Organization connection entry

Status: implemented

## Problem

The organization connection entry fills the application window with a small configuration form, repeats its title and renders its principal action using the compact secondary button. Joining an organization loses the workbench's visual hierarchy and leaves no adjacent return action.

## Decision

The independent space layer presents one compact connection panel using the product theme, typography and shared form controls. It explains the browser authorization step, offers a direct return to personal space and uses a large primary action. Registered client configuration remains available in a keyboard-accessible disclosure. Client identifiers are still checked by the organization's registered-client policy; presentation defaults do not grant or discover authorization.

Organization routes retain the organization, account and deployment identity for workspace destinations and project conversations. Switching still disposes business providers from the previous space without stopping its backend work. The entry remains independent of personal Runtime readiness.

The authorized organization metadata response also updates the existing connection name for its original live space view. The current-space trigger and menu then use that verified name, retaining the issuer fallback until metadata arrives. An aborted prior view cannot rename its successor. See the [space name postmortem](../../../postmortem/0190-verified-organization-names-were-missing-from-the-switcher.md).

The authorization page uses the same large primary variant for signing in and continuing. Sign-out and closing remain subordinate actions. Shared theme tokens own enabled, busy and focus states in both appearances.

An unavailable discovery transport or HTTP response produces the existing connection recovery message. Only a successful discovery response reaches authority validation; malformed or mismatched identities still fail closed. See the [discovery failure postmortem](../../../postmortem/0189-discovery-connectivity-was-reported-as-identity-change.md).

## Alternatives considered

**Put the form inside personal Settings.** This makes organization recovery depend on the availability of the personal Runtime and does not provide a coherent organization destination.

**Apply larger global button defaults.** The compact button remains appropriate in workbench toolbars. The connection form selects its own existing large primary variant.

## Consequences

The connection entry gains a focused hierarchy without introducing a second component or theme system. Custom client registrations retain their explicit configuration path. Organization workspace destinations require their own authorized views; defining a route alone does not establish completion of that workflow.

The complete Web shell is exercised against two independently owned HTTPS organization Services with distinct cookie hosts. The browser checks wrong-password recovery, popup cancellation, verified menu names, project isolation, a late first-organization response, personal return and volatile access tokens at wide English and narrow Chinese sizes in both appearances. The separate combined-App fixture covers personal drafts, attachments, search and notification ownership across the same space transitions.
