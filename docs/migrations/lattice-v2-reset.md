# Lattice v2 Reset

Lattice v2 replaces the phase-driven v1 record introduced in Synergy 2.4.4 with a strict, recoverable Run, action, and effect model. The two persistence shapes are intentionally incompatible. Synergy does not infer partially completed v2 work from v1 phase data.

Startup migration `20260722-lattice-v2-reset` performs a one-time clean break:

- valid strict `schemaVersion: 2` Run records are left unchanged
- v1 and malformed Lattice Run records and their event trees are removed
- a live BlueprintLoop is cancelled only when its loop ID, `source: "lattice"`, Scope, and Session all match the removed v1 Run or its matching Session binding
- matching Lattice workflow fields and obsolete `info.lattice` fields are cleared
- matching Session and Blueprint Note loop bindings are cleared
- Blueprint Note content, version, title, and other Blueprint metadata are preserved
- user-owned and plugin-owned BlueprintLoops are never cancelled by this migration

The migration uses Storage records directly and is safe to repeat after partial completion. Missing records are treated as already converged; a failed write stops startup so the next run can retry. Logs contain aggregate counts only, not Scope, Session, Run, Loop, Note, or filesystem identifiers.

Old Lattice run and event history cannot be recovered through the product after this migration. If that history must be retained externally, back up the Synergy data root before first starting the upgraded version. New v2 terminal runs are stored by Run ID and remain available when a later run starts in the same Session.
