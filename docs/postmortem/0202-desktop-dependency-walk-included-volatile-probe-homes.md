# Desktop dependency walk included volatile probe Homes

## Executive summary

The Desktop dependency walker included a synthetic sandbox-probe Home while the probe owner cleaned it up. Exclude that exact volatile subtree at the actual Desktop matcher.

## Summary

A Linux Desktop package failed when copying a file beneath the Local Runtime probe directory. Source tracing identified the probe's creation and cleanup owner and the pinned packager's dependency walk. The log establishes the missing copy input; it does not identify an individual unlink syscall.

## Timeline

The original configuration failed a real dependency-copy and ASAR regression because the resulting archive contained the probe. After the exact exclusion, both retained and removed-probe scenarios passed, together with the original packaging, Runtime seal and signing suites: 41 tests and 159 assertions.

## Root cause

The application selected its own bundle positively, but `electron-builder` collected linked production dependencies separately. Its node-module matcher inherited negative application patterns and did not apply each dependency's package file list. The linked Local Runtime therefore exposed a concurrently mutable test subtree to inventory and copy.

## Guardrails

- [x] Machine check: `apps/desktop/test/packaging.test.ts` exercises the actual pinned dependency matcher, walker, copier and ASAR implementation; it excludes the probe before traversal and retains canonical native filenames and bytes after probe cleanup.
- [x] Machine check: the original packaging, Runtime seal and macOS signing suites pass with the exclusion.
- [ ] Machine check: current-head Desktop package CI must complete with real prepared native assets.

The [decision](../decisions/implemented/bug-fix/2026-11-14-exclude-volatile-sandbox-probes-from-desktop-dependencies.md) preserves the official native closure.

## Lessons

Verify the packager that reads linked dependencies. A package manifest alone does not establish what the Desktop archive contains.
