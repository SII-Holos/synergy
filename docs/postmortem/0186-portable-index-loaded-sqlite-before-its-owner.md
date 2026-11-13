# Portable index loaded SQLite before its owner

## Executive summary

A portable Workspace reader opened its temporary index without selecting the canonical SQLite engine. On macOS this loaded the default library, so a later resource backup could not select the required patched engine.

## Summary

The real resource recovery fixture wrote two file versions before backup. Reading the prior paged content opened a portable index in the parent process. Resource capture then attempted canonical initialization and failed with SQLite already loaded. The other cases in that batch inherited the same process state.

## Timeline

The grouped recovery run exposed the common initialization error. A fresh Bun child reproduced it by reading complete portable bytes before calling the canonical initializer. Initializing at the first index owner fixed the child and the complete portable stream suite.

## Root cause

The portable stream index constructed SQLite databases directly. Engine selection is process-wide and must precede the first connection, including temporary metadata indexes.

## Guardrails

The portable index calls the canonical initializer before construction. The fresh-process regression avoids a test preload or earlier database hiding the ordering defect. Engine-selection and version failures continue to reject; no fallback or exception suppression is added.

## Lessons

A temporary index participates in the same process-wide engine lifetime as later storage owners.
