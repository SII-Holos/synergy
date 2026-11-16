# Service path alias changed native recovery identity

## Executive summary

An acknowledged Member shared-data recovery completed, then ordinary Service startup rejected its original native installation. The opener used a lexical path alias while installation had used the canonical Home. The strict native identity guard correctly detected a different configuration hash for the same database.

## Summary

The restored Service's internal completion and readiness checks passed. Reopening through the original caller path failed before authentication. This initially appeared to be a publication identity change.

## Timeline

Diagnostics first confirmed matching Home, root, artifact anchor and database identities during publication. Call-lifetime markers established that publication returned successfully. Ordinary-startup diagnostics then isolated a later lexical call: the database inode still matched, while its lexical filename and configuration hash differed. A separate cross-platform test reproduced the failure through a real symlink ancestor before the production fix.

## Root cause

Administrative installation and recovery canonicalized the Home. Ordinary serving only resolved its lexical spelling before deriving SQLite and artifact paths. Native installation verification includes that primary configuration as well as physical identity.

## Guardrails

The owning test recovers a real Service and reopens it through an ancestor alias, preserving native intent bytes, the database inode and prepared signing material. The serving entry resolves existing ordinary Homes before creating its Runtime. Restricted maintenance modes and the native hash encoding remain unchanged.

## Lessons

Trace completion and later ordinary startup separately. Path aliases require consistent input resolution at the owning entry, rather than weakening native identity checks.
