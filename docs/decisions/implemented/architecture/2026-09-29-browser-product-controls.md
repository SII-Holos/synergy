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
