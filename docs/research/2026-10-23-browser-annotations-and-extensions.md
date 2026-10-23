# Browser annotations, inspection and extensions

Research reference, 2026-10-23. Repository baseline: `7da9e5c9a`; Desktop pins Electron `44.9.0`. This document records feasibility and implementation options, not a shipped feature or an approved implementation plan.

## Findings

Element selection, contextual questions, style inspection and temporary styling previews can share Synergy's existing native page and CDP connection. They do not require a Chrome extension system or another browser engine. Supporting selected browser extensions is a separate integration; broad Chrome Web Store compatibility is substantially larger work.

The supplied screenshots establish that Codex exposes annotation, styling and extension-management controls. OpenAI documents their observable annotation behavior, but neither those screenshots nor the public documentation establish its private browser implementation. The CDP approach below is a verified option for Synergy, not a claim about Codex internals.

## Official behavior and implementation primitives

| Capability                | Evidence                                                                                                                                                                                                                            | Implication                                                                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Element and area feedback | OpenAI's [Browser documentation](https://learn.chatgpt.com/docs/browser.md) describes clicking an element or dragging an area, saving a comment, then sending it with a chat message.                                               | Selection and saving must not implicitly send a message.                                                                                                      |
| Styling feedback          | The same document describes changing font, text, spacing and color, with page preview.                                                                                                                                              | A lightweight property editor is enough; a complete DevTools frontend is unnecessary.                                                                         |
| Site-specific semantics   | [Annotations Extensibility](https://learn.chatgpt.com/docs/annotations-extensibility.md) exposes `document.oai.annotation`, metadata, custom controls and canvas hit testing. Ordinary DOM annotation requires no site integration. | Optional adapters can enrich chart/component semantics. They are not prerequisites for ordinary websites or an embeddable OpenAI annotation engine.           |
| Reversible previews       | The extensibility API distinguishes `preview`, `preview-original` and `reset`, explicitly separating preview from permanent saving.                                                                                                 | Keep original state, proposed changes and repository edits separate. A temporary CSS change on a third-party website does not edit its server or source code. |
| Native selection          | CDP [Overlay](https://chromedevtools.github.io/devtools-protocol/tot/Overlay/#method-setInspectMode) supports `searchForNode` and emits `inspectNodeRequested` with a backend node ID.                                              | Reuse Chromium hit testing and highlighting rather than infer element identity from a screen coordinate.                                                      |
| Element properties        | CDP [DOM](https://chromedevtools.github.io/devtools-protocol/tot/DOM/) and [CSS](https://chromedevtools.github.io/devtools-protocol/tot/CSS/) expose node details, computed styles, matched rules and platform fonts.               | Computed color, opacity and font-family are straightforward. Declared font-family and the actual rendered font are different facts.                           |

The screenshots' transparency control is visible evidence; the cited OpenAI Browser page does not separately enumerate opacity. OpenAI's documented full-CDP developer mode does not prove that its annotation implementation uses the same path.

## Existing Synergy implementation

- [BrowserNativePagePool](../../apps/desktop/src/browser-native-page-pool.ts) and [BrowserWebContentsControl](../../apps/desktop/src/browser-webcontents-control.ts) already own native pages and their CDP transport. Extend those owners rather than attach another competing debugger or create another browser.
- [`CdpPageController.inspect`](../../packages/browser-core/src/controller.ts) already resolves locators and returns element HTML, attributes, geometry, selected computed styles, event-listener metadata and accessibility information. Console and network observations also exist there.
- The [Elements panel](../../apps/web/src/components/workspace/browser/elements-panel.tsx) displays an accessibility-style list, not an interactive CSS inspector.
- The [annotation route](../../packages/browser-runtime/src/routes/browser-route.ts) saves `point(x,y)`, page URL, comment and optional style feedback. It does not resolve the point into a DOM element or preserve a document generation.
- [BrowserDraft](../../apps/web/src/components/workspace/browser/browser-draft.ts) supports capturing the initiating draft before asynchronous work. Any new annotation attachment must use that capture rather than select a destination after the request finishes.

The missing product flow is therefore selection plus durable context plus a usable editor, not basic access to page data.

## Native feasibility experiment

An isolated Electron 44.9.0 process used the actual page pool and view manager, its own userData, a synthetic loopback HTTP page and a visible native window. Host zoom and page zoom were varied independently between 100% and 200%. Input was injected through Electron `sendInputEvent`; this was not a physical mouse or complete Desktop product acceptance test.

| Host zoom | Page zoom | Native input | Page client coordinates | Page viewport |
| --------- | --------- | ------------ | ----------------------- | ------------- |
| 100%      | 100%      | `(240,180)`  | `(240,180)`             | `600 × 450`   |
| 100%      | 200%      | `(240,180)`  | `(120,90)`              | `300 × 225`   |
| 200%      | 100%      | `(240,180)`  | `(240,180)`             | `1200 × 900`  |
| 200%      | 200%      | `(240,180)`  | `(120,90)`              | `600 × 450`   |

A point-picking spike canceled only `mouseDown`. In every tested zoom combination the page still received `pointerup` and `mouseup`; ordinary `click` was absent. This is insufficient input isolation for an annotation mode because websites can act on release events. Copying native input coordinates into both renderer positions and page coordinates was also incorrect at nondefault zoom. The unfinished product wiring was withdrawn; it is not part of the repository feature set.

Using the existing debugger connection, the experiment enabled DOM, CSS and Overlay, then entered `searchForNode`. With both zoom factors at 200%, selecting the synthetic target returned its real `DIV` node and computed `color`, `font-family` and `opacity`. The recorded page-event list was empty. This establishes main-frame selection and property-reading feasibility, not cross-frame coverage or visual acceptance of highlight rendering. Exiting inspection on this build required `highlightConfig: {}` alongside `mode: "none"`; omitting it returned an error in the probe.

An initial hidden-window experiment did not establish reliable zoom geometry and was excluded from the table. No existing user browser profile, credentials or active Synergy runtime were used.

## Suggested annotation design

1. Enable selection on the explicitly presented native page using the existing controller. Keep Agent page targeting independent from the human's selected tab.
2. Capture owner/page identity, document generation, frame/CDP session, node identity, URL, text, geometry, selected styles and a historical image where useful. A node ID is not a persistent identifier after navigation.
3. Show a small inspector/comment editor. Questions and change requests share the same captured context. Do not claim that plain pixel coordinates identify a live element.
4. Add reversible style/text previews separately. Preserve ordinary website edits and restore only changes owned by the preview; framework rerenders can replace nodes or invalidate the baseline.
5. Add the captured context and requested differences to the initiating conversation draft. Preserve comments on failure, prevent duplicate saves, and require explicit user sending.

Production verification must include navigation/recovery during selection, cancellation, page and conversation switching while requests are held, host/page zoom, fixed viewport emulation, keyboard access, shadow DOM and cross-process iframes. Canvas subobjects need application semantics or region-based image feedback. Site-provided metadata remains untrusted content and cannot authorize actions.

## Browser extensions are a separate project

Electron 44.9.0's [extension support document](https://github.com/electron/electron/blob/v44.9.0/docs/api/extensions.md) explicitly provides a subset of Chrome extension APIs and states that arbitrary store-extension compatibility is not its goal. The [Extensions API](https://github.com/electron/electron/blob/v44.9.0/docs/api/extensions-api.md) loads unpacked directories, not `.crx` files, into persistent sessions. Applications must call `loadExtension` again on each startup.

The version's [upstream extension tests](https://github.com/electron/electron/blob/v44.9.0/spec/extensions.spec.ts) cover MV3 service workers, including restart behavior, while explicitly noting that `chrome.action` is unsupported. These are upstream source observations, not local compatibility tests. Loading an extension does not supply Chrome's complete toolbar, active-tab model, permission UX, store installation or update pipeline.

A scoped implementation would bind extensions to existing persistent Browser identities, maintain explicit installation/enabled/version state, restore loads on startup, and test a declared compatibility list. Broader support additionally needs action/popup integration, API compatibility, permissions and revocation, trusted distribution/integrity, update rollback, profile removal and failure recovery. Temporary identities cannot simply use the persistent-session loading API.

Chrome browser extensions, Synergy Agent plugins, OpenAI's website annotation API and OpenAI's extension for controlling an external Chrome browser are different integration types. An extension icon in a screenshot does not establish which compatibility implementation a product uses.

## Effort and sequencing

These are rough engineering estimates for one developer familiar with the existing code, not commitments or measured completion times. Platform coverage and compatibility scope dominate the production ranges; rows overlap and are not additive.

| Scope                                                                | Demonstration                         | Production work                                                          |
| -------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------ |
| Main-frame element selection, properties and comments                | 1–3 person-days                       | Approximately 2–4 person-weeks including lifecycle and interaction tests |
| Reversible styling/text previews                                     | Several additional days               | Approximately 4–8 person-weeks for the combined annotation flow          |
| Selected unpacked extensions with identity isolation and restoration | 2–5 person-days                       | Approximately 2–4 person-weeks with an explicit compatibility list       |
| Broad store-style extension compatibility                            | A demo cannot establish compatibility | Months-scale work and ongoing maintenance                                |

Recommended order: element selection and contextual questions first; reversible styling feedback second; selected extension support as an independent workstream. Do not make broad store compatibility a prerequisite for useful annotation features.
