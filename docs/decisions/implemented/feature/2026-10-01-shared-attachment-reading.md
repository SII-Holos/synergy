# Decision Record: Share attachment reading between drafts and messages

Status: implemented

## Problem

Draft documents previously opened an external URL while sent documents used a workspace reader. Reusing file editing state for read-only attachment source could display a workspace draft for a same-named attachment.

## Decision

Extract one attachment preview component that accepts a file, its captured connection and optional opening callbacks. It reads bounded original bytes without session or workspace state. Text uses fenced source through the shared read-only Markdown code renderer; optional highlighting failures fall back to readable escaped source. Markdown uses the same non-streaming renderer as user messages. PDF, HTML, image and media capabilities retain explicit loading, error and download states.

Draft attachments mount this component in a temporary modal. The modal belongs to the captured draft and attachment identity, closes when that owner becomes invalid, and allocates no persistent panel. Closing aborts outstanding reads, releases preview resources and restores opener focus through the shared dialog stack. Even a transport ignoring AbortSignal cannot publish a late result.

Sent user attachments prefer their canonical session, message and attachment identity before an optional workspace path. Images can therefore reopen in the same attachment panel. Other shared-card consumers preserve their existing default opening behavior.

The canonical attachment panel reads uploaded assets without a file workspace provider. The built-in registration captures workspace navigation and supplies it as an optional internal callback, so source-file actions retain their owner without making historical or uploaded resources depend on a file editor context.

## Alternatives considered

**Assign a synthetic session to draft previews.** This creates invalid persistent resource identities and complicates cleanup.

**Share the workspace text editor model.** Attachment contents and file editing drafts have different owners and must not overwrite each other.

## Consequences

Readers share format handling while their hosts retain lifecycle and navigation ownership. No backend schema, durable data migration or Plugin public contract changes are needed. Original download URLs remain untouched.
