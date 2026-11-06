# Decision Record: Manage resources through the attached server

Status: implemented

## Problem

Operators need to inspect, select and recover Workspace and Environment resources while the authoritative Runtime already owns storage. A CLI that opens another writer cannot safely perform these operations.

## Decision

Generic resource commands use generated SDK methods with explicit server and Scope selection. They acquire no local storage handle. Mutations preserve observed identity and generation preconditions; operation recovery addresses existing receipts. Authentication comes from a named environment variable. Output is JSON and failures have nonzero exit status.

## Alternatives considered

Direct storage access would compete with the running owner. A raw HTTP-only command would hide the distinct selection, recovery and reclamation semantics from operators.

## Consequences

One server path serves Web, Desktop and CLI. Child-process tests verify request bodies, Scope, authentication, stale responses and CLI behavior while the target Home lock is held.
