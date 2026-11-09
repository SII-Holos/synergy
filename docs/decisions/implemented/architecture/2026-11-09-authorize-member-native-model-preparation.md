# Decision Record: Authorize member native model preparation

Status: implemented

## Problem

An accepted organization command has a native Inbox receipt before its root exists. The native loop needs model metadata to materialize that root, while model dispatch requires the root and Run as authorization evidence. A prepared SDK test alone cannot establish that these stages connect safely or that auxiliary work retains the right task identity.

## Decision

The resident member connection attaches its intake and resource client to a Runtime-local execution source. Session authorization matches the queued Inbox message or existing canonical root to its accepted receipt, describes the selected resource and installs its public model in the current Scope catalog before native materialization. The source preserves the model of an existing root and uses canonical model-selection writes. Per-Session preparation is cancellable; the existing SessionManager retains scheduling and budgets.

The command receiver schedules task and steer work through native wake after its receipt transaction commits. Context input, rejected commits and duplicate receipts do not schedule another wake.

Provider request preparation reads the canonical root and obtains a binding proof backed by its Run. Each invocation reserves a fresh call ID and passes only its finite capability and public deployment context to the fixed SDK worker. Primary and auxiliary calls use the same path. Disconnect removes preparation authority; cached metadata cannot allocate a new capability. Current resource disablement is checked by the service, while personal selection-grant revocation retains already accepted resources.

## Alternatives considered

**Wait for a bound root before exposing any model metadata.** Native materialization itself needs the selected model. The description proof provides only public metadata from accepted intake, without pretending a root already exists.

**Authorize from the current connection or supplied actor alone.** Neither proves that a particular Inbox message was accepted. Matching the receipt's exact native identity prevents substitution, and dispatch independently reads canonical root/Run evidence.

**Prepare one credential per Session or choose the latest root for derived work.** Sessions contain successive tasks and concurrent derived calls. A credential must bind the originating root and one call, with retries still owned by the native caller.

## Consequences

The catalogs hold public descriptors in existing scoped state and cannot fall back to personal configuration. Unsupported business connections, unadmitted children and offline preparation fail closed. Cortex lineage, offline local work, grant drainage and reconnect recovery remain distinct owner integrations.

Real HTTPS/WSS, storage and worker tests cover automatic command-to-loop execution, auxiliary attribution, unique capabilities, usage and transport evidence. Focused tests cover receipt substitution, Scope separation, model drift, resource disablement, disconnect/reconnect and commit-only wakeup. No organization model key or machine signing key enters a worker plan.
