# Interactive visual results

This reference defines ownership, persistence and execution for the `render` tool. Authoring guidance and the callable API live in [the tool instructions](../../packages/media/src/tools/render.txt); schemas live in [RenderArtifact](../../packages/util/src/render-artifact.ts). The [decision record](../decisions/implemented/architecture/2026-10-08-render-artifact-state.md) records the persistence choice.

## Ownership and data flow

Media writes an immutable JSON source Asset and attaches it to the completed producing tool Part. Its descriptor identifies the source version, presentation and optional predecessor. A replacement creates another source version; it does not mutate the predecessor. Mutable interaction state occupies `metadata.visualState` on that Part. Media validates Scope, completed-call ownership, attached-source identity and effective Session history before reads or writes. Source reads verify the content hash and descriptor.

State updates compare revisions within the existing Storage transaction and publish canonical Part updates. Duplicate mutation IDs with identical content return the accepted state. Conflicts return current state. The client adopts that state and invalidates queued writes from the stale revision. The frame suppresses saves identical to the last canonical content, including control callbacks during remote restoration. These operations never schedule inference. Fork and full session export/import reuse the existing rollout attachment transfer and Part copying; they retain source identity and create independently writable state.

The per-model context contributor refreshes semantic state from stored Parts. It prioritizes explicit source references and then recent state, omits HTML and authored UI state, and bounds the complete injected message. Root-scoped contributors keep their existing cache lifecycle. Context remains untrusted data.

## Presentation and recovery

App supplies `RenderProvider` with SDK reads, revisioned writes, canonical state observation and confirmed follow-ups. Shared UI owns the controller, iframe runtime, controls and expanded viewer. Source references resolve to their producing call through Media; MIME or a filename cannot authorize a bridge. Historical unversioned HTML enters this same presentation with static execution policy.

Canonical Part updates refresh mounted views without REST requests per event. Reconnect and history changes revalidate the owned source. A changed connection, Scope or session cancels confirmation and revokes the old view. Inline and expanded presentations share state; opening, closing and exporting flush pending changes. Save failures remain visible and require an explicit discard to close the viewer without saving.

Export creates a standalone HTML document containing saved state and selected bundled libraries. Local controls remain interactive; host follow-up actions are disabled. External HTTPS assets retain their original availability requirements. Canvas and SVG annotation capture can supply a bounded PNG; blocked or unsupported capture retains source, variant, object identity, coordinates, selection and parameter details. The host previews the request and available image before admission.

## Execution and authority

Generated JavaScript runs in an opaque `allow-scripts` iframe without same-origin, popup, navigation, device or Electron authority. A nonce and the current iframe WindowProxy bind each MessageChannel to one document. The bridge validates message types, payload bounds and active view ownership. Navigation closes the channel. Historical static content is sanitized and permits only the host bootstrap.

Interactive CSP permits HTTPS static resources and blocks connection APIs, forms, child frames, workers and objects. Bundled libraries load before authored scripts. HTTPS permission is not a data isolation guarantee: an external resource URL can carry data. The source never receives host credentials or internal API clients.

Frame follow-ups open a protected, editable App dialog. Confirmation revalidates the source and submits through normal Inbox admission with a stable message identity for retries. The composer draft is independent. Source text cannot authorize tools or send an input by itself.

## Verification

`packages/media/test/render` covers ownership, revision races, context budgets, rollback, fork and full export/import. `packages/ui/test/components/render-interactive.browser.test.ts` covers actual iframe interaction, bundled libraries, source isolation, responsive layout, state restoration, annotations, export and animation suspension. `apps/web/test/context/render-confirmation.browser.test.ts` covers confirmation, retry identity, draft preservation, canonical updates and reconnect. Static history retains its browser regression suite. Whole-page and Desktop acceptance use the isolated runtime workflow in the owning development Skill.
