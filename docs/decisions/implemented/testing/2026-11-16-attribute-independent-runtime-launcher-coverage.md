# Decision Record: Attribute independent Runtime launcher coverage

Status: implemented

## Problem

An executable tested in child processes can be exercised successfully without appearing in the parent Bun coverage report. Treating that measurement omission as missing CLI behavior encourages import-only tests or moving process-owned execution into a unit fixture.

## Decision

The coverage manifest exempts only the Organization Runtime executable [src/entry.ts](../../../../packages/organization-runtime/src/entry.ts). It selects the independent CLI name, machine-only command composition and Session registrar, and rejects use of a personal Runtime factory. Command parsing, dispatch and Runtime lifecycle stay in their measured owners.

The real [entry test](../../../../packages/organization-runtime/test/entry.test.ts) launches the source executable and checks machine-only discovery, refused private input and unknown commands, no private-input echo and no ambient Home writes. The [installed check](../../../../script/organization-runtime-install-check.ts) reuses that test against the packed executable outside the checkout. Those child-process assertions remain required; Bun does not merge their execution into the parent's source report.

The package thresholds and every other exemption stay unchanged. The existing exact-file [CLI launcher policy](../../../../script/coverage-exempt.json) applies the same measurement distinction. A launcher that gains parsing, authorization or operational logic must move that behavior to a measured owner or supply meaningful coverage before retaining this exemption.

## Alternatives considered

**Import the executable with a mocked CLI runner.** This can mark the composition lines as loaded while bypassing the actual process, parser, private input and lifetime behavior being accepted.

**Remove the missing-file check or lower package thresholds.** The measurement issue belongs to one pure executable; broad policy changes would weaken unrelated Runtime coverage.

**Add child coverage collection for this launcher.** That would require a new report-identity and merge path for an already exercised composition file. The existing child tests and an exact exemption avoid that extra infrastructure while keeping the actual command owners measured.

## Consequences

The parent coverage report no longer claims to measure this executable, and process tests remain the evidence for its behavior. The exemption cannot establish package coverage or command success by itself. Original complete CI reports may support a clearly labeled policy-only reevaluation when the measured production and test inputs are unchanged; a fresh workflow still owns acceptance for a new commit.
