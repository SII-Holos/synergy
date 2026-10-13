# Decision Record: Provider connection frontend optimization

Status: implemented

## Problem

Routine model-list metadata needs to remain distinct from authentication failures. Service discovery, account creation and credential maintenance must not compete inside one detail toolbar. Gating edits on removability prevents canonical accounts from receiving remarks, and expandable maintenance actions destabilize the toolbar layout.

## Decision

Providers displays model-list source and real verification time as neutral metadata beside a compact refresh action. An actual discovery failure retains existing models, offers retry, and leaves authentication health unchanged. Structured catalog failures remain failures even when HTTP succeeds.

The service's canonical connection handles the first sign-in. Additional accounts use an optional remark and a continuous authentication flow; creation begins only with an explicit sign-in, import, or credential submission. Each setup owns a stable creation ID and reconciles an uncertain response against the provider snapshot. Known writes retry only the read, including after a section change remounts the connection form. A retained credential receipt prevents automatic authentication-method selection from restarting an import or replacing the refresh action. Interrupted connections remain in the account list.

Setup inputs, metadata baselines and pending account writes live in the Settings window's transient controller and survive section changes. Cancel and every window-dismissal entry confirm unsaved input, including credentials for an already allocated connection; window disposal releases transient secrets. Account actions remain separate from preference drafts and the global save action. The list exposes Edit account and a More menu; editing opens a dedicated page with optional remark, credential update, advanced endpoint and enabled state. Add model service and Add another account use the same service-type selection and setup component, with the latter preserving explicit sibling-creation intent even for a disabled account. Authentication waits abort on disposal, and late replies cannot complete the disposed view.

Canonical and named connections share the existing account-update API. The remark is the existing connection name, not an independent persisted note; blank remarks use a service or generated-account label. Editing submits only changed fields, and first sign-in retains configured endpoint and enabled state. Editing never changes account identity. Static canonical identity resolves before the providers write lock; the mutation validates against current configured entries and merges the latest fields without retaining a stale configured alias. Removal retains its existing named-connection and reference checks. The service catalog lists service types, not sibling account instances. Product copy describes actions, state and recovery, not the interface's own design.

The Settings footer waits for global configuration initialization only on sections that declare that resource dependency. Direct entry to Providers must not display perpetual loading for a configuration request the section deliberately does not start; loading remains local to the active section's resources.

## Alternatives considered

- **Recolor the existing banner only.** This fixes the immediate visual confusion but leaves inaccurate source labels and the split creation/authentication workflow.
- **Create an account as soon as the form opens.** This allocates unused records before the user chooses to connect.
- **Delete every interrupted account automatically.** This removes a recoverable setup and conflicts with the retained connection behavior.
- **Add a new setup transaction API.** Existing connection IDs, snapshots, and authentication routes support the workflow without changing the public contract.
- **Keep a maintenance disclosure inside the account toolbar.** Expanding actions moves adjacent controls and hides ordinary edits; the focused editor owns these actions instead.
- **Add an independent remark field.** The display label already provides the requested distinction without another schema or migration.

## Consequences

Connection setup has fewer competing actions and distinguishes normal information from recovery. Interrupted accounts require explicit removal when no longer wanted. An uncertain creation may need a snapshot refresh before continuing. Browser tests cover the real forms, sibling targeting, read retries, retained drafts, catalog failure, and keyboard navigation; focused unit tests cover receipt recovery, source projection, and transient identity. The setup and account-editor components have exact-file coverage manifest entries identifying their Chromium suite because Vite execution cannot contribute original source LCOV to Bun; coverage floors and directly testable logic stay measured.

Home selectors consume the global provider snapshot updated by catalog pages and targeted model lookups. A retained Home Scope holds a separate bootstrap projection and must not shadow the completed catalog. The existing GlobalSync lifecycle fixture now exercises the real provider consumer against a retained Home Scope and a later catalog page. Same-version partial bootstrap refreshes preserve loaded model entries and resolved lookups while taking fresh provider metadata; a new catalog version or a complete response replaces the old projection. This prevents unrelated settings refreshes from silently removing a selected model or emptying an open model search.

Provider account controls use the shared focus treatment, without local outlines. Version-changing model snapshots are reconciled as replacements so old missing-model lookup receipts cannot suppress fresh discovery.
