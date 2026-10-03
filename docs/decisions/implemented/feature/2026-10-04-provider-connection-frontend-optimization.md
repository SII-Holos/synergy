# Decision Record: Provider connection frontend optimization

Status: implemented

## Problem

Routine model-list metadata uses warning styling, and live results are described as an older saved list. Account creation and authentication appear as separate actions, obscuring when a usable connection exists. Prominent credential maintenance and the global Settings save button compete with the immediate connection workflow.

## Decision

Providers displays model-list source and real verification time as neutral metadata beside a compact refresh action. An actual discovery failure retains existing models, offers retry, and leaves authentication health unchanged. Structured catalog failures remain failures even when HTTP succeeds.

The service's canonical connection handles the first sign-in. Additional accounts use an optional remark and a continuous authentication flow; creation begins only with an explicit sign-in, import, or credential submission. Each setup owns a stable creation ID and reconciles an uncertain response against the provider snapshot. Known writes retry only the read. Interrupted connections remain in the account list.

Setup inputs live in the Settings window's transient controller and survive section changes. Cancel, connection changes, and window disposal release them. They are separate from preference drafts and the global save action. Account maintenance is a secondary disclosure, with actions constrained by the existing server contract. Authentication waits abort on disposal, and late replies cannot complete the disposed view.

## Alternatives considered

- **Recolor the existing banner only.** This fixes the immediate visual confusion but leaves inaccurate source labels and the split creation/authentication workflow.
- **Create an account as soon as the form opens.** This allocates unused records before the user chooses to connect.
- **Delete every interrupted account automatically.** This removes a recoverable setup and conflicts with the retained connection behavior.
- **Add a new setup transaction API.** Existing connection IDs, snapshots, and authentication routes support the workflow without changing the public contract.

## Consequences

Connection setup has fewer competing actions and distinguishes normal information from recovery. Interrupted accounts require explicit removal when no longer wanted. An uncertain creation may need a snapshot refresh before continuing. Browser tests cover the real forms, sibling targeting, read retries, retained drafts, catalog failure, and keyboard navigation; focused unit tests cover receipt recovery, source projection, and transient identity.
