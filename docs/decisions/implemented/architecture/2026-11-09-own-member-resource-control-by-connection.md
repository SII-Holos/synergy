# Decision Record: Own member resource control by the verified connection

Status: implemented

## Problem

Native resource preparation needs machine-authenticated service calls, while model workers must not receive the machine signing key. A detached HTTP client could outlive its connection, use stale epochs or retain a response body after Runtime storage closes.

## Decision

The verified member connection creates a resource client after its identity checkpoint commits. The client signs accepted-task description, root binding and gateway reservation/inspection proofs with distinct protocol domains. Its public interface exposes operations and parsed results, never the private key. The command receiver factory shares that connection-owned client.

Generated SDK methods use the verified HTTPS origin and deployment CA with a private pool, no ambient proxy, omitted browser credentials and rejected redirects. Response validation checks the exact task or gateway target and verifies service-signed capabilities. Eight active requests provide transport backpressure; callers wait cancellably under the original proof deadline. A 256 KiB control-response ceiling bounds retained response bytes. These limits do not count accepted tasks or lifetime model calls.

Disconnect invalidates queued and active work. Readers are explicitly cancelled and awaited before the private idle pool closes, following the Bun FetchSession ownership behavior cited beside the implementation. Structured service errors retain their outcome; transport failures remain unknown without exposing response content or automatically retrying a mutation. After reconnect, a new proof may retrieve an original reservation whose connection epoch is older. This does not renew or dispatch that capability.

## Alternatives considered

**Pass the machine key to provider workers.** Workers need only a finite resource-call capability; sharing machine authority would also permit unrelated control proofs and extend key lifetime beyond the bridge.

**Reuse a global HTTP pool or fetch with personal defaults.** Deployment trust, proxy settings and pool disposal belong to the selected member connection, independently of personal Runtime networking.

**Reject callers when the transport window fills.** Normal contention should wait under cancellation and proof expiry, without adding a task quota or offline command queue.

**Automatically retry failed control requests.** A lost response can follow a committed reservation. The original call identity must remain available for explicit inspection without assuming non-delivery.

## Consequences

Resource control is available through a verified connection while native execution remains separately authorized. Connection replacement requires callers to obtain a fresh client and proof. The client buffers bounded control JSON, while model streaming remains with the gateway transport. No provider activation, native grant release or business-protocol adapter is implied.

Real HTTPS/WSS tests cover native receipt preparation and root binding, signature and target rejection, deployment trust, lost reservation responses, explicit reconnect inspection, bounded concurrency, queued cancellation, oversized responses and physical reader disposal. Existing enrollment and connection fixtures retain independent mutable Homes and listeners.
