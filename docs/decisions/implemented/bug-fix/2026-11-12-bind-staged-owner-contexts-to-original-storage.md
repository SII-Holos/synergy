# Decision Record: Bind staged owner contexts to original storage

Status: implemented

## Problem

An owner context for a verified handoff retained its Runtime but resolved records through the caller's active Storage context. Two Stores in one Runtime could contain the same handoff and Session selectors, allowing a prepared context to return another namespace's private records. Context construction also awaited its state read before copying mutable selectors, mapping and cancellation.

## Decision

`SessionTransferStaging.context` validates and captures owner, handoff, root and Session identity, mapping and the original signal before its first asynchronous read. It clones and freezes caller Session metadata without projecting it through a schema that removes unknown owner fields. Canonical Session records remain the original staged Core data and are published only by their existing owner.

The context binds its actual Runtime, Store, artifact directory and object backend configuration. Records, dependency/version lookups, artifact descriptors and iterators check that original owner before reads and before returning data. Artifact streams check before every native iterator advance and after it returns, including the deferred first read and completion. An escaped iterator cannot acquire authority merely because it was created in the correct context.

Prepared native evidence carries the same ownership check into the activation transaction and its final commit guard. Artifact publication snapshots its target and replacement option, uses the existing transaction and cannot create an activation transaction itself. The publication dependency graph and owner order remain unchanged.

## Alternatives considered

**Check Runtime identity alone.** Storage permits isolated namespaces within one Runtime, so that identity does not qualify a record or artifact read.

**Automatically enter the context's original Store.** This hides the caller's escaped use and lets a foreign context read private bytes instead of rejecting it.

**Validate only at iterator creation.** Async generators and binary readers defer their first operation; later iterations can run under another namespace or artifact configuration.

## Consequences

Caller metadata and mapping are immutable for the context's lifetime. Readers must stay in their original native Storage scope and preserve the original cancellation signal. These checks qualify staged data access; they do not authorize source surrender, physical capture, destination activation or Continue. Metadata cloning does not rewrite the staged canonical Session or remove its unknown fields.

## Verification

`test/session/transfer-context-ownership.test.ts` preserves the real same-Runtime cross-Store counterexample and adds a barrier during the actual staging state read, selector/mapping/Session replacement, original cancellation, same-Store artifact substitution and escaped first/subsequent artifact reads. Staging, dependency, Core and publication-order suites verify compatible native behavior and unknown canonical data retention. See [the incident](../../../postmortem/0108-staged-context-read-foreign-storage.md).
