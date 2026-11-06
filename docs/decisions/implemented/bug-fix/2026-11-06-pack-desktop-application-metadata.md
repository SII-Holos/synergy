# Decision Record: Pack Desktop application metadata explicitly

Status: implemented

## Problem

The generated Desktop application package is a descriptor for portable artifacts, so its npm archive needs only its manifest. An empty `files` array is rejected by the pinned Bun 1.4.3 packer, preventing publication after the platform builds and artifact checks have succeeded. Manifest object tests do not exercise this packaging failure.

## Decision

The descriptor selects `package.json` explicitly. Its regression test invokes the same publication packer, inspects the real archive, verifies all manifest data survives, and confirms an unrelated staged file is excluded. Existing receipt, signing, checksum and upgrade checks remain required.

The release recovery allowlist includes the standalone Desktop descriptor producer. This file is release tooling, absent from published runtime modules and native compilation. Product package sources, the public package schema and Desktop build inputs remain protected by recovery rejection tests.

## Alternatives considered

**Omit the file selection.** This permits unrelated staging files to enter a metadata-only package and weakens the intended archive contents.

**Normalize every empty file list in the generic packer.** This changes packaging for unrelated packages and hides the descriptor producer's responsibility to select its payload.

## Consequences

The release checks publishability using the pinned package manager before npm access. The regression adds a local pack operation and archive inspection. A descriptor-only repair can retain an unfinished release identity without changing already published product code; final artifact and promotion checks still run through the release workflow.
