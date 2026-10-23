# Decision Record: Tool attachment views

Status: implemented

## Problem

Execution details append file previews beneath textual output across separate ordinary, rich and task-report render paths. Images extracted from tool output also inherit different conversation sizes depending on whether their presentation purpose is evidence or deliverable. Container alignment alone does not ensure that an image and its clickable area begin at the same edge.

## Decision

Execution details own one conditional Attachments tab. Its count and files use the shared attachment visibility resolver. Result retains textual output, structured receipts and interactive result bodies; nested generic attachment galleries are suppressed. Late files do not change the selected tab. A different invocation resets to Result, and removal of the selected tab clears that selection before files reappear.

The shared attachment gallery owns compact process presentation and detailed previews. Ordinary tool evidence and promoted tool files use the same left-aligned 160 × 120 image boxes with contained, uncropped pixels, ordered file rows and the existing expansion control. Purpose continues to control chronological placement and process disclosure. Formal answer attachments and dedicated media-generation results retain their large presentation. These decisions do not inspect tool names or modify persisted attachments, model policies or discovery.

Detailed galleries use one column with uncropped previews, expose media filenames and metadata, and preserve resource opening, native playback and preview identities. Image width constraints apply to the card and image together so an intrinsic container does not leave an invisible centered offset.

## Alternatives considered

**Keep files below each result renderer.** This couples attachment discovery to scrolling through output and requires each result branch to own another gallery.

**Change attachment purpose or add tool-specific sizing.** Purpose describes the content's role and controls disclosure. Reclassifying files or matching tool names would conflate that behavior with display size and leave new producers inconsistent.

**Compact every image in the conversation.** This also shrinks deliberate answer illustrations and generated media. Presentation context distinguishes ordinary tool files from those outputs without changing resource semantics.

## Consequences

Attachments take an explicit tab selection in execution details, leaving long textual output easier to read. Ordinary tool images trade inline inspection size for consistent thumbnails and retain their full resource in the shared preview. The previous inset correction remains valid; this change also measures image pixels and card bounds.

Production browser tests retain existing document wrapping, resource actions and execution lifecycle checks. Added coverage checks image proportions, both purposes and themes, narrow layouts, formal deliveries, tab selection, late and hidden attachments, three result paths and localized labels. Execution details use real shared galleries, controls, fonts and styles in the fixture; the result-body fixture still isolates specialized renderer lifetimes.
