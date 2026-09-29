# Decision Record: Desktop browser pages and identities

Status: proposed

## Problem

The browser couples task identity to one page and one login store while maintaining headless, native and WebRTC lifecycles. Popup navigation replaces the source page. Shared login, independent page targeting and predictable recovery require a single owner model.

## Proposal

Desktop is the only built-in browser host. CLI and Web selections omit the browser runtime, Chromium installation and remote presentation. Electron WebContentsView owns real pages; the server owns task page records and policy. Page identity, profile identity, human selection and agent activity are independent.

New pages default to a persistent personal profile shared across tasks. Each page may use a different named or temporary profile. Popups inherit their opener's profile. Human input does not pause agents; tools explicitly target pages and reject stale observations. Unknown side effects are never replayed.

Implement in the current checkout with incremental commits: product composition and distribution cleanup; native page collections and popup lifecycle; persistent profiles and permissions; integrated UI, agent feedback, migration and isolated Desktop acceptance. Update the owning architecture, product documents and development Skills with shipped behavior.

## Alternatives considered

- Retaining headless and WebRTC duplicates browser lifecycle and identity migration.
- A profile-wide human takeover lock interrupts unrelated pages and tasks.
- Reusing the selected UI tab as the agent target makes manual tab switches change an operation's destination.
- Automatically merging historical identities can switch website accounts without user intent.

## Acceptance criteria

- CLI/Web run without built-in browser components or Chromium downloads.
- At least eight real native pages, including opener-dependent login popups, retain independent state.
- Shared profiles reuse login across tasks; named and temporary profiles isolate website state.
- Human and agent operations on different pages are independent; stale targets and unknown outcomes return concise recovery guidance.
- Revocation, profile disablement, file authority, page recovery and migration have behavioral tests.
- Isolated Desktop verification covers native rendering, tabs, profiles, login, recovery and cleanup; generated SDK, documentation and Skills agree with the implementation.

## Risks

Browser changes span the backend, Electron, shared UI and packaging. Persistent profiles do not preserve JavaScript heaps, unsaved forms or one-use authentication callbacks across process loss. Existing native profiles must retain their partition mapping; retired headless data must remain available without retaining its execution path.
