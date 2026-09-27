# Decision Record: Workspace-independent attachment preparation

Status: implemented

## Problem

Uploaded files belong to Runtime-managed storage, but input preparation routed them through Workspace-owned native file readers. Sessions with no directory could fail before model invocation, discard text content or stall later queued work. Separate inline and uploaded branches also disagreed about explicit model policies and document extraction failures. The [incident report](../../../postmortem/0032-workspace-free-attachment-preparation.md) records the regression evidence.

## Decision

Managed attachments use one byte preparation path with canonical Asset/media containment checks. Native file references retain their Workspace requirement and read evidence. Automatic policy handles text, documents, images and other media, while explicit model policy takes precedence and presentation metadata survives normalization. Document extraction keeps the existing parser limits; this change does not add audio transcription or video interpretation.

Text uploads keep the existing UTF-8 replacement behavior for invalid byte sequences, and retain the original bytes. Strict UTF-8 validation would reject previously accepted legacy text files without improving the managed-resource boundary, so encoding detection or stricter validation is outside this repair.

Preparation failure rejects the whole input. Sibling preparation settles before the error propagates; the original inbox payload remains available for correction or retry, with a filename-based error instead of private source details. Invalid steer/context delivery is parked independently of the active root. Scheduling failures retain message/item identity, and exhausted preparation retries advance to other runnable work without parking unrelated input for a provider failure.

## Alternatives considered

**Make FileTime global or silently ignore missing Workspaces.** Rejected because Workspace generations own native file evidence and edit safety. Managed storage does not need that evidence, so its reader is separated instead.

**Send the surviving text and a warning about the failed attachment.** Rejected because the model would answer an incomplete request. A retained failed input makes retry and correction explicit.

**Patch only PNG handling.** Rejected because text, document extraction, visual child sessions and queue recovery cross the same resource ownership boundary.

## Consequences

Workspace-free sessions can consume uploaded and inline attachments while arbitrary native paths remain unavailable. Bad attachments require correction or explicit retry; they do not produce partial answers. No persisted schema migration is needed. Tests cover source protocols, three Workspace contexts, real document parsers, model-policy precedence, vision child transport, failed-input identity and continued queue processing.
