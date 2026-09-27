# Decision Record: Select resources independently of running a Session

Status: implemented

## Problem

Requiring a usable native directory when accepting input makes network and managed-data work depend on filesystem availability. A default native process host also needs an explicit composition choice so an embedded API-only agent cannot acquire it implicitly.

## Decision

Sessions persist an independent nullable Environment reference. Creation, children and forks establish references without allocating compute. Runtime composition registers the default selection; the local host selects native and embedded hosts can omit it. A versioned migration fills historical Session selections without allocating. Transcript import clears execution authority.

Input acceptance and Session loop admission carry logical selections. Workspace use is acquired by resource-dependent operations, which validate the binding before effects and start file services under the acquired use. Worktree locks cover these operations rather than model/network waiting. Background native process ownership continues independently through completion and saving.

## Alternatives considered

**Validate all resources at input acceptance.** This prevents API-only interactions from working with unavailable or deliberately absent physical resources and provides no protection against a resource changing before its actual use.

**Infer native execution when no Environment is selected.** This silently expands an embedded host's capabilities. An omitted default and an explicit null selection both remain without compute authority.

## Consequences

An accepted turn can report a resource error when it first requests files or execution, while continuing unrelated capabilities. Imported local paths remain historical metadata and fail physical binding checks. File services and process launchers must enforce their own resource admission instead of assuming Session startup performed it.
