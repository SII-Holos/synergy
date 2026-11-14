# Decision Record: Stable member Runtime provisioning

Status: implemented

## Problem

A member can use multiple organizations and accounts on one device. Reusing personal directories or replacing a lost machine key during ordinary startup would mix histories or silently create a different execution identity. Registration responses can also be lost after the service has committed activation.

## Decision

The organization Runtime adapter selects a managed directory using a digest of organization, account and device identity. Service addresses are explicit HTTPS origins and do not define identity. Provisioning refuses existing personal data and symbolic-link Homes, persists generic Home ownership first, and publishes an initial provisioning record before privately writing the machine key and ready binding. A retry resumes that initial state with the existing key. Once ready, missing or invalid credentials block admission instead of regenerating identity.

The adapter signs the strict registration proof using its own key and consumes the ticket through the generated organization SDK. A dedicated verified-TLS connection pool excludes ambient proxy selection, browser credentials and redirects. Explicit CA configuration retains certificate validation. Tickets remain in memory. Only a matching public registration receipt is cached; changed deployment or Runtime identities require explicit recovery. Retrying a lost response relies on the service's immutable receipt, and the cached state never grants current execution permission.

The machine-key directory participates in the existing sensitive-path classifier and shared sandbox credential protections. A private file mode protects it from other OS users but cannot by itself isolate a tool running as the same user. Verification includes an actual macOS sandbox read denial and an ordinary-file positive control; the common policy supplies the corresponding deny paths to the other sandbox backends.

## Alternatives considered

**Use the service URL as the directory identity.** Address changes would fork one account's history and allow aliases to create accidental duplicate identities.

**Generate a key whenever credentials are absent.** A damaged established Home could register as a new machine while retaining old execution state.

**Persist registration tickets for automatic retry.** This would retain bearer-like enrollment authority after its immediate purpose. The machine key and public receipt are the durable state; callers may retry the same in-memory ticket or request a new one through current human authorization.

## Consequences

Member identity provisioning remains independent of Agent startup and can fail before personal configuration discovery. It does not itself implement configuration isolation, Session ownership, connection fencing or handoff recovery. Those owners must verify current service authority separately. Private files use the existing atomic-file and lock contracts; future persisted-format upgrades belong to the owning migration workflow.

The dedicated TLS pool follows [Bun Fetch sessions](https://bun.sh/docs/runtime/networking/fetch#fetch-sessions). Tests exercise actual TLS trust, real service storage, interrupted initial provisioning and registration response loss.
