# Decision Record: Host-authoritative provider catalog

Status: implemented

## Problem

Embedded hosts with a validated model inventory still passed through local cached and bundled catalogs, implicit provider profiles and stored credentials. A failed host source could not be distinguished from discovery, and model workers could reconstruct a different connection.

## Decision

Composition may register one Runtime-owned ProviderCatalogSource. Its validated provider and model identities are the complete inventory. Discovery, background catalog refresh and local configuration expansion are excluded for this source. Errors propagate without fallback. Host-owned worker plans preserve their authority through the versioned IPC protocol, bypass stored-credential recovery and implicit profiles, and retain the shared transport recording boundary.

## Alternatives considered

A fetch-disable flag still admits cached catalogs and connection expansion. Filtering discovered models after resolution cannot prove the origin of retained metadata or credentials. A parallel model resolver would duplicate SDK, timeout and recording behavior.

## Consequences

Hosts supply complete JSON provider/model snapshots and explicit SDK factories. Default product discovery remains unchanged. Tests prove source isolation, mutation independence, unavailable and inconsistent source failure, rejected fallback models, sealed registration, serialized worker authority, unchanged stored credentials and retained transport evidence.
