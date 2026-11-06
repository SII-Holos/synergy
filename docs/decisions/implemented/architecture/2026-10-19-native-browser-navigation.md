# Decision Record: Native Browser navigation and bounded recovery

Status: implemented

## Problem

Opening a link exposed separate preparation, blank-page and website states. Human navigation also waited for the automation transport's command deadline, and a navigation timeout could trigger page replacement despite an unknown command outcome. This made slow websites look like broken browser instances and put unsaved page state at risk.

## Decision

Human navigation, history, reload and stop dispatch through Electron WebContents APIs. They acknowledge dispatch immediately and leave document progress to native events. Stop and human navigation bypass the Agent command queue. Agent commands retain CDP, explicit page targets, authorization, observation requirements and bounded command deadlines.

Protocol v8 carries transient navigation identity, native generation, revision, requested URL, phase, slow state and structured errors. Stale generations and revisions cannot overwrite current presentation. Main-frame navigation events own completion and failure; subframe errors and superseded aborts do not become page failures. Slow navigation and an unresponsive renderer retain the existing browsing context. Bounded generation recovery applies to an actual renderer exit.

The initiating tab presents its requested address and progress from its first render. Preparation upgrades the same tab; a blank-page interface appears only for explicit blank-page intent. Short preparation does not display a separate status message. Initialization, page creation and command transport have distinct budgets. A CDP timeout reports an unknown outcome with fresh-observation guidance, never automatic effect replay or page replacement.

Native presentation belongs to the current shell document. Full shell navigation and renderer loss detach its view immediately, while the pool retains the website and unsaved form. The next shell may reattach after DOM readiness. Same-document routing and subframe navigation preserve presentation. Native IPC accepts only the current trusted main frame, so an obsolete document cannot restore an overlay.

The implementation uses Electron's [WebContents navigation API](https://www.electronjs.org/docs/latest/api/web-contents) and [navigation history API](https://www.electronjs.org/docs/latest/api/navigation-history). CDP's [Page.navigate response](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-navigate) is command evidence; document completion is a separate event. Current ownership and limits live in [Browser runtime](../../../architecture/browser-runtime.md).

The shared toolbar reserves loading-indicator space across preparation, loading and completion. Native blank canvases consume the resolved Desktop theme, including same-mode theme switches. Localized recovery messages keep bounded redacted diagnostics in a disclosure. Navigation errors retain their identity through the public event stream and cannot overwrite newer navigation. Stop and disposal cancel pending controller waits; command deadlines include first-use initialization for every command family.

Stage diagnostics use the existing observability pipeline with a strict URL-free payload. Initialization failures identify their phase; document progress and native presentation have separate milestones. Background acceptance explicitly selects fixtures that never show or activate a window. Visible-window geometry, physical input and packaged OS grants remain separate evidence.

Read-only presentation capability is prepared before clicks, keyed by the bridge, server and feature selection. This removes the warm-opening IPC delay without caching page tickets or command authorization. Failed native initialization drains bounded WebContents cleanup before returning. Server and Host queues both allow explicit user navigation, stop and close to interrupt Agent waits; separate replay ordering retains idempotency, ordinary-command serialization and disposal draining.

## Alternatives considered

**Raise one global timeout.** This delays errors but keeps human input coupled to automation and still cannot establish whether a timed-out effect happened.

**Recreate the page after any timeout.** This can discard live forms and login transactions while the original command may already have taken effect. Only confirmed renderer loss justifies generation recovery.

**Replace Electron with another embedded engine.** An engine replacement would expand packaging, native lifecycle and automation work without supplying Chrome's complete product services. The existing native page architecture can separate presentation and automation directly.

Scope-owned pages do not hold a synthetic task Workspace lock. That lock serialized even catalog reads behind Agent waits, preventing the UI from reaching its interrupt lane. Bound legacy/local pages retain the real binding lease; interrupts reuse its captured context and revalidate the owner before dispatch. Real runtime lock regressions complement page-queue unit tests.

## Consequences

The protocol version requires coordinated Desktop, Browser runtime and Web delivery. Navigation snapshots are live presentation state and are omitted from durable page descriptors. Website latency remains visible as progress; it cannot be eliminated by dispatch changes. Persistent profile cookies survive restart, but arbitrary unsaved document state is not a restart guarantee.

Behavioral tests cover immediate opening, overlapping navigation, stale events, native lifecycle, structured timeouts and retained form state. Actual Electron acceptance covers a response slower than ten seconds, popup adoption, profile data, stop and subsequent navigation. The incident mechanism is recorded in [the postmortem](../../../postmortem/0081-browser-navigation-timeouts.md).
