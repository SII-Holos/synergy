# Decision Record: Member Runtime supervisor entry

Status: implemented

## Problem

A native supervisor needs a deployable member process entry while preserving its isolated Home and transient credentials. Direct embedding does not exercise installed CLI dispatch, process readiness or parent-death cleanup. Reusing personal launch settings can also carry private loader inputs or a different Home's installation generation into the member process.

## Decision

The organization Runtime component contributes an owner-initialized `member-runtime` command through the shared CLI parser. Its factory only contributes discovery; explicit member opening selects the sources and worker roles. Source Presets and the full installation catalog include the same factory and metadata.

The command accepts a strict versioned request through private stdin with a byte limit, EOF and deadline. It validates the prepared Home, identity and deployment before enrollment or Agent storage. Tickets remain transient. An existing matching registration supports restart without reissuing a human credential. The command invokes the existing CLI server lifecycle with its member Runtime factory and startup reporters, preserving shutdown, parent monitoring and storage failure escalation.

The public member environment selector is usable before process launch. It selects OS lookup and locale values, rebinds user directories and excludes personal configuration, credentials and loader inputs. A complete installation pin and launcher are retained only for the member root. The installed launcher remains responsible for verifying generation integrity; environment selection does not replace that verification.

Core Agent and policy workers register their pinned composition before global path initialization. Installed acceptance exposed the previous ordering: the global ownership guard ran before the member registrar selected its Home, rejecting valid members. Registration now establishes the owner before the same guard runs. Both roles still reject mismatched identities without initializing global directories.

## Alternatives considered

**Launch a custom long-running script from Desktop.** This would duplicate the CLI's readiness and shutdown lifecycle and leave installed command discovery without an owning component.

**Pass credentials in command arguments or persist a startup request.** Arguments can appear in process inspection and diagnostics, while durable copies would extend a transient credential's lifetime.

**Discard every installation variable.** This protects against personal pins but also prevents member workers from using their own verified installed generation.

## Consequences

The member adapter depends on the CLI's public lifecycle entry. Its component registration performs no member storage or source mutation in a personal composition. Source and installed launches require separate verification. The command supplies a local process endpoint; outbound bridge supervision and Desktop native capability ownership remain separate integrations.
