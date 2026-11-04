# Decision Record: Resume partial stable publication without changing its version

Status: implemented

## Problem

An npm upload can succeed before its version becomes installable. A short visibility timeout can stop a product release after some immutable package versions exist, while an ordinary rerun computes a new version from those partial uploads. Regenerating native files or changing product sources under the reserved version can also produce a different package graph. Large release ranges additionally lose changelog entries when only the default GitHub comparison response is read.

## Decision

Registry version and dist-tag checks retain cache-busted reads and allow twenty minutes for visibility. This accommodates npm's [publish-time scanning delay](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/) without accepting an unavailable package or waiting indefinitely.

Product dispatch accepts an explicit unfinished version together with its original native run. The version must be the highest stable version already present in a managed package. Recovery rejects completed public releases and requires a completed ancestor Release run from `dev` with successful native jobs. Published-package sources and native build inputs must remain unchanged. A narrow allowlist permits release tooling and the separately built Execution Host Docker recipe; that recipe is absent from npm module archives and CLI/Desktop assembly. Candidate and Desktop jobs reuse that run's native assets, and ordinary artifact verification, signing, upgrade acceptance and final promotion remain required.

Release notes read every GitHub comparison page before intersecting the result with local product history. GitHub's [comparison API](https://docs.github.com/en/rest/commits/commits#compare-two-commits) limits unpaged responses to 250 commits. Classification covers current product modules, shared UI and Desktop, and excludes maintenance commit types with or without a conventional scope.

## Alternatives considered

**Rerun the ordinary bump.** Partially published versions advance the registry baseline and select a different release identity.

**Delete and republish existing packages.** npm versions are immutable; publication recovery must preserve accepted artifacts and their consumers.

**Accept arbitrary source changes with a fixed version.** This can combine old immutable packages with newly built product bytes. Product corrections require a new release identity.

**Remove visibility checks or wait indefinitely.** Either hides unavailable dependencies or prevents bounded failure recovery.

## Consequences

Slow registry processing can consume a longer but finite release window. Recovery needs the original retained native artifacts and cannot repair product code under an already published version. Regression coverage exercises delayed visibility, expiration, version retention, rejected source changes and complete notes across a real 253-commit repository fixture containing 251 product changes and two scoped maintenance changes.
