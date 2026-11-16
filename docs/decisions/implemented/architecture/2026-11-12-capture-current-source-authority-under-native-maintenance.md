# Decision Record: Capture current source authority under native maintenance

Status: implemented

## Problem

A restored historical checkpoint cannot prove later source revocations or the running service's effective client configuration. A caller-supplied checkpoint or native manifest also cannot establish that the original service remains frozen while recovery inspects those facts.

## Decision

The internal `OrganizationCurrentAuthority.withSource` owner consumes the original live service's opaque maintenance lease. It requires the actual frozen native cohort, primary Runtime/Store/artifact configuration and current complete policy coverage. Under that same frozen lifetime, the canonical Snapshot capture exports a complete authenticated namespace and the native service owner captures its actual Home and effective startup settings.

The archived authority reader validates complete policy coverage and an optional exact earlier journal anchor. Its resulting head must equal the live source's head. The native segment must belong to that same namespace; its effective client definitions are represented by a digest. Descriptions expose independent parsed metadata, never native credentials, configuration bytes or an executable authority object.

The resulting source evidence is opaque and callback-bound. Verification rechecks the original maintenance operation, live policy, complete archive and native segment. Foreign handles, copied evidence, changed history, cancellation and escaped callbacks reject. The owner captures input anchors and recovery-key methods before asynchronous work and zeroes temporary raw configuration returned by native verification. It writes verification archives to the explicit destination, without changing source policy or target state.

## Alternatives considered

**Treat an authenticated old backup as current authorization.** Its missing later interval can include revocations and configuration changes.

**Accept a current-looking checkpoint or native manifest from the caller.** Neither proves live native ownership or retains the original source's frozen lifetime.

**Read latest authorization after releasing maintenance.** Source changes could race inspection or recovery publication. The original frozen owner must retain the inspection lifetime.

## Consequences

Recovery can inspect a genuine source suffix and effective native settings without forking its journal or activating a target. Source evidence remains local to its original Runtime and callback; it is not a durable retirement receipt or a cross-Runtime execution permit. Applying current policy, re-establishing missing history, retiring old writers, activating fresh signing material and completing target readiness remain separate required owners.

`test/backup/current-authority.test.ts` uses a real service password change after its earlier head, captures the final suffix under native maintenance, checks actual composed client definitions, rejects draining capture and wrong anchors, preserves input snapshots, refuses copied/foreign/expired evidence and cancels during real archive encryption. Existing inactive-signing and authority-history suites retain their independent target and migration checks.
