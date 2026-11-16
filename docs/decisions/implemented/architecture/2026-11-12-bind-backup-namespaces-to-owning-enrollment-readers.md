# Decision Record: Bind backup namespaces to owning enrollment readers

Status: implemented

## Problem

A native process lock proves which Runtime owns a Store, but does not identify its organization enrollment. Supplying another machine's valid registration to a backup callback could label an unrelated Home as the required hosted participant and produce an incorrect namespace completeness report.

## Decision

Harness exposes the composition-only `lifecycle/namespace-identity` Host port. Its owner supplies a bounded public identity record: at most 32 fields, keys up to 128 characters and values up to 4096 characters. The port returns opaque native evidence rather than accepting caller-created certificates. Evidence binds the installed Runtime, its primary Store, original artifact configuration, Home/root, native writer lock and persisted Home reader fence. Alternate Stores, changed artifact settings, copied evidence, closed Runtimes and foreign contexts cannot inspect or verify it. Verification rereads the owning identity and reader fence before returning.

Organization Runtime installs this source in its normal member/hosted composition. The implementation reads the current Runtime's actual Home through `readRuntimeHome` and `readRuntimeRegistration`, preserving their credential/public-key checks, selected identity and current reader contract. Its public projection contains only machine kind, organization, deployment, Runtime ID and public key. It exposes no Home paths, private keys or credentials. Ordinary reads perform no migration.

`OrganizationBackupCohort.hosted` accepts only the native runner. It cannot take a registration callback. Every use derives its hosted descriptor from opaque native identity evidence and revalidates that evidence after the selected namespace operation. The service compares this actual descriptor with its canonical roster before admitting maintenance. The service neither imports the Runtime adapter nor copies its Home/credential parsers.

## Alternatives considered

**Trust a caller-provided hosted registration.** Its public fields can identify the expected machine while its runner reads another Home. Process-lock and distinct-Store checks do not close that gap.

**Read organization Home files in the service.** This duplicates the owning enrollment/reader contract and introduces a package cycle if the service imports its Runtime adapter. The composition port keeps provisioning and validation with their existing owner.

**Infer enrollment from archived records.** Native Home identity is independent of optional Session records. An empty or previously unused hosted namespace still needs an owning identity proof.

## Consequences

Capturing a namespace performs bounded native identity reads in addition to its existing writer checks. The generic Host record is public metadata, while its authority remains private and Runtime-bound. Lower-level fixtures may install explicit fixture sources; real enrollment acceptance uses the owning Runtime reader. Namespace/Snapshot capture still does not establish complete deployment recovery, external resource coverage or unique restored execution ownership.

## Verification

Harness `test/lifecycle/namespace-identity.test.ts` exercises primary Store/artifact isolation, asynchronous configuration replacement, finite metadata, copied evidence and lifecycle closure. Organization Runtime `test/namespace-identity.test.ts` uses two real HTTPS services with independently provisioned and enrolled hosted Homes. The foreign Home is rejected before maintenance; the correct Home seals its own canonical records. The normal production composition installs the source, and cold reopening validates the same enrollment while rejecting old evidence, changed registration and an unsupported reader fence. Organization `test/backup/cohort.test.ts` preserves roster, immutable-input, cancellation, Snapshot and accepted-tail coverage with explicit fixture identity sources.
