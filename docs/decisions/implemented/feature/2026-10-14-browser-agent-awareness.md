# Decision Record: Session-scoped browser activity and human-change observation

Status: implemented

## Problem

Shared project pages could display another Session’s Agent activity, navigation did not update that activity, and browser outputs could reveal Workspace or notify instead of adding a quiet peer tab. Human changes to the shared page could leave an Agent acting from stale observations.

## Decision

[Browser runtime](../../../architecture/browser-runtime.md) keeps a bounded live activity snapshot keyed by Session and operation. Successful completion retains recent viewing; failure and page closure clear running state. Creation and navigation emit activity. Command activity starts after queuing and authorization, covers every dispatched browser command, and finishes on success, failure or cancellation. The existing peer tab icon identifies current-Session activity, with a gentle active animation and a static recent-view state. Hover and accessible descriptions expose the state without a separate row or selection change. Reduced motion disables animation. Tab decoration reads the already-loaded catalog; it never opens a connection, fetches a snapshot or persists transient activity. Pages persist their creating Agent Session. Catalog reconciliation silently adds those pages to that Session’s Workspace, preserving focus, selection and collapse state. Browser tools bypass the general output reveal path. Storage format v6 upgrades existing records in the stable page collection without attributing historical pages to a guessed Session.

Protocol v6 carries the initiating Agent Session to Desktop. Native input and user navigation increment coalesced counters. Before dispatching an effect, Desktop requires that Session to have observed the page after the latest human changes. Successful snapshot, read, inspect and screenshot operations acknowledge only the counters captured at their start. Results and rejected effects describe change categories and counts without input values. Idle Agents are not awakened.

## Alternatives considered

**Rely on the Agent’s next voluntary read.** This leaves stale actions possible; a dispatch check makes the observation requirement enforceable.

**Stream every human event into conversation context.** This adds noise, duplicates input and risks capturing typed values. Coalesced notices at browser interaction boundaries carry enough information to request fresh evidence.

**Reuse automatic output reveal for browser pages.** It can interrupt the user and later produce only a toast. Background registration adds the page while preserving the user’s Workspace choices.

## Consequences

People and Agents can share pages while retaining independent selection and task activity. Concurrent human input may require additional observations. Interaction counters and activity history are bounded, in-memory state; they reset with the native page or Browser runtime. Page creation attribution survives restart, and Browser-created tabs retain the existing Session Workspace persistence. Protocol v6 requires matched Web, runtime and Desktop versions. Raw input and historical interaction transcripts are not stored.
