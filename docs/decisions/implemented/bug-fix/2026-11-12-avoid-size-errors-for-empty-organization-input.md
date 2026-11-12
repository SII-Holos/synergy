# Decision Record: Avoid size errors for empty organization input

Status: implemented

## Problem

An empty organization message displayed the oversized-input warning before the user typed anything. The composer treated every unsuccessful input-schema parse as a size failure, although the canonical schema also rejects an empty text part. The Send action was correctly disabled, but the warning described the wrong cause.

## Decision

Evaluate the existing input-size guard only when the draft contains text. Keep the canonical input schema, original draft owner, supported limits and Send admission unchanged. Empty input stays disabled without an error message. Oversized text stays in its original draft, displays the existing warning and cannot be sent.

## Alternatives considered

**Accept empty parts in the command schema.** This changes backend input semantics to repair a presentation mistake.

**Remove the size warning.** Users with an oversized draft still need the existing explanation and retained content.

## Consequences

The combined full-App browser test covers empty-input silence alongside the disabled Send control and an oversized retained-text control. It also exercises real Space presentation changes with synthetic transport data; its browser evidence remains separate from the authenticated Runtime/TLS tests. No new message ID, API or persistence format is introduced.
