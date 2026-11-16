# WorkspaceMove release escaped an outer transaction

## Executive summary

`WorkspaceMove.release()` joined an enclosing SQL transaction for its terminal record, then released its physical native claim before that transaction committed. Rolling back the caller restored a held Move whose actual exclusive claim was gone. Release must own the SQL boundary before irreversible physical cleanup.

## Summary

A real prepared native directory and coordinator reproduced the ordering. The enclosing transaction called release, observed the durable claim disappear, and threw. After rollback, the original Move still reported `published` and `nativeRequested: true`. An accepted job could instead wait for the same enclosing writer and deadlock.

## Timeline

Independent review found the nested-transaction path during native adoption acceptance. The behavioral regression observed physical release before outer rollback. Rejecting release inside any SQL transaction preserved the actual claim and original record; ordinary release remained outside the real Core/Epoch transaction.

## Root cause

Nested `Storage.transaction()` calls join their caller. Release treated the nested callback's return as a committed terminal decision, then performed native I/O and drainage. No enclosing-transaction admission check separated those lifetimes.

## Guardrails

`test/workspace/native-adoption.test.ts` uses the actual coordinator, verifies the rollback record and retained physical claim, and checks the structured outside-transaction rejection. It also covers publication/cancellation commit order and a lost terminal acknowledgement. Physical reconciliation retains the original Move ID and claim token; it never substitutes a new directory.

## Lessons

An awaited nested SQL callback is not a commit receipt. See [native adoption ownership](../decisions/implemented/architecture/2026-11-13-adopt-existing-native-workspaces-through-original-handoff-claims.md).
