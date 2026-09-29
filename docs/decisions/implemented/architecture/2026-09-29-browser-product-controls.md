# Decision Record: Native browser product controls

Status: implemented

## Problem

Real browser pages already share the workbench, but routine browsing still exposes developer-oriented controls and lacks native find, zoom and print operations. Suppressing human navigation gestures for an entire Agent command also interferes with concurrent use.

## Decision

Keep each page in its existing native WebContentsView. Add typed, validated Desktop page actions for find, zoom and printing using the [Electron webContents API](https://www.electronjs.org/docs/latest/api/web-contents). Native guest shortcuts route to the corresponding workbench page. Ordinary navigation never grants or transfers exclusive control between the person and Agent.

Organize the toolbar around browsing. Keep diagnostics and viewport emulation inside the developer section. New tabs accept URLs and searches directly. Opening a browser from the home draft creates a normal empty task without starting an Agent, so pages always have ordinary task ownership.

## Alternatives considered

An exclusive takeover mode was rejected: the product accepts concurrent human and Agent interaction on the same page. Explicit page targets, stale observations and unknown-result feedback remain necessary, but a control-owner state machine is not.

Reimplementing browser operations inside the webpage was rejected because native find, zoom and printing already provide the required page semantics across Desktop platforms.

## Consequences

The renderer controls presentation and invokes narrow native methods; it does not obtain arbitrary Electron or CDP access. OS-specific dialogs remain native. Existing task permissions, page identity and uncertain-action rules remain authoritative.

Behavioral tests cover native action results, matching find requests, platform keyboard modifiers and human navigation during an in-flight Agent observation. Real Desktop acceptance is required in addition to transport tests.

## Local data boundary

Desktop owns a versioned local profile data store for recent visits and OS-encrypted passwords. The first store format is version 1; no previous plaintext store exists to migrate. Website data clearing keeps passwords and recent history, while profile deletion explicitly removes saved data through the host protocol. Temporary profiles cannot persist this data.

File-based import is the cross-platform contract; [Browser source import](../feature/2026-09-29-browser-source-import.md) extends this with explicit native macOS sources. CSV and Safari ZIP password exports plus Cookie JSON cover explicit transfers without tying the product to external browser encryption databases. Imports preserve existing entries by default and return counts without credentials. The native bridge exposes metadata and origin-scoped fill/save actions, never decrypted password retrieval. See [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage) and [Safari export format](https://developer.apple.com/documentation/safariservices/importing-data-exported-from-safari).

Profile deletion invalidates password saves that are still awaiting encryption, so an asynchronous completion cannot recreate deleted entries. Navigation metadata follows the page URL even when the title stays unchanged; native state probes wait for a ready page and cannot turn normal suspension into a user-facing error.

## Result delivery and native overlays

Task-owned completed downloads are copied into the established Asset store only after owner, state, path and bounded-file checks. The generated `browser.downloadArtifact` endpoint remains usable when the source page is closed. Screenshot feedback uses historical image coordinates and source metadata in the editable composer; it does not write hidden Session annotations or auto-submit. Draft capture prevents asynchronous results from landing in another conversation.

Native child views render above ordinary DOM overlays. While an overlay is visible, the application shows a bounded, noninteractive still image of the hidden native view; resuming the view discards it. This preserves visual context without introducing screenshot streaming or a second control transport. The source remains the same real WebContentsView.
