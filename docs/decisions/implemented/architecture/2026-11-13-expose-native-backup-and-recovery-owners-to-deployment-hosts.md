# Decision Record: Expose native backup and recovery owners to deployment hosts

Status: implemented

## Problem

The enrolled multi-namespace backup and Hosted restoration implementations required private Service imports. A deployment host outside the repository could use the public Runtime backup owner but could not compose the corresponding Service owners through supported package entries. Adding a runbook that imports private source or distribution paths would preserve that operational gap.

## Decision

The Service package exposes `./backup` for the existing cohort and authenticated archive owners, and `./backup/recovery` for its native installation, current authority, prepared authority, source retirement, recovery and publication owners. The entries re-export the canonical implementations without a new execution path, resolver, state store or privilege-bearing DTO.

A deployment host composes these entries with the Runtime package's public backup and recovery owners while retaining the original native handles and verified capabilities. Signatures, process locks, fixed namespace identities, callback lifetimes, guarded transactions and complete writer proofs remain mandatory. Merely importing an entry or parsing metadata cannot establish a Source or Target capability.

The administrative CLI retains its declared service-only restoration scope. Multi-namespace deployment orchestration uses the actual registered owners; this package boundary does not introduce remote maintenance commands or make an unavailable participant optional.

## Alternatives considered

**Document private imports.** Private file layout is not an installed package contract and cannot support an independent deployment exercise.

**Build a second remote orchestration protocol.** A remote control plane is not required to expose the existing operator-owned lifecycle, and would add machine authority and recovery semantics beyond this package-boundary change.

**Expose every backup implementation module.** Storage indexes, policy records, pending-source implementation and private path helpers remain internal. Operators use the owners that already validate native capabilities.

## Consequences

Deployment hosts can compose native backup and recovery using supported Service and Runtime entries. They still must provide real participants and complete native proofs. Tests in the repository and an independently installed deployment exercise are separate validation steps; this entry-point change does not certify unsupported resource or writer cohorts.
