# Decision Record: Initialize portable indexes through the canonical SQLite owner

Status: implemented

## Problem

A portable content reader can open a temporary SQLite index before any checkpoint or recovery owner. Loading the default SQLite library first prevents a later owner from selecting the required patched engine on macOS. An ordinary Workspace edit can therefore make a later native resource backup fail before capture.

## Decision

Initialize SQLite through the existing storage owner before constructing the portable stream index. The storage owner retains engine selection and version verification; temporary indexes do not choose a second library or suppress initialization failures.

## Alternatives considered

**Initialize only when backup begins.** Portable content reads may already have loaded SQLite in that process.

**Ignore the library-selection failure.** This would discard the canonical engine and version requirements.

## Consequences

Portable readers and recovery indexes can be the first SQLite consumer without changing later storage behavior. A fresh Bun child reads and verifies real portable bytes before invoking the canonical storage initializer. The owning stream suite retains cancellation, tamper detection and large paged traversal coverage. See the [postmortem](../../../postmortem/0186-portable-index-loaded-sqlite-before-its-owner.md).
