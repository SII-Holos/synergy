# Decision Record: Derive Handoff object proof time from accepted Service plans

Status: implemented

## Problem

Destination object proofs used the destination machine's wall clock, while the Service evaluated their finite authorization window with its own clock. Independently valid clocks can therefore reject an otherwise authorized immutable range. Changing only the signed timestamp would leave the client's admission checks and remaining request timeout in another time domain.

## Decision

After the existing Target authorization verifies the Service-signed plan, each preview or preparation captures one monotonic observation. Its original receive job derives object time from the plan's issued timestamp plus elapsed monotonic time. The destination signs each range with that time and the existing fifteen-second duration. The same operation-local clock supplies the existing client checks before and after queue admission and the remaining request timeout. Negative or nonfinite elapsed time and unsafe timestamp arithmetic fail closed.

The original five-second machine-plan entry checks, signatures, complete binding, current connection, consent, current project access, source closure, cancellation and response verification remain. Reusing an accepted job retains its original clock observation. This does not renew entry authority or synchronize system clocks. Other native proofs retain their original time domain; no wire schema, global clock cache or compatibility path is added.

## Alternatives considered

**Add a clock tolerance or remove the Service window check.** Either changes which signed capabilities remain valid and conceals the mismatched time source.

**Use receipt time as a new five-second entry window.** Delayed delivery would renew expired authority. The accepted plan's timestamp remains the origin, so transport and validation delay conservatively consume time.

**Replace only object signing time.** Queue admission and timeout calculations would still compare timestamps from different clocks.

**Add a general clock synchronization protocol.** This object path already has an authenticated Service timestamp and an accepted operation lifetime. A new handshake or system-clock change is unnecessary for this repair.

## Consequences

The internal object reader requires the original accepted operation's clock. The existing HTTPS adapter and Target tests verify both the signed time domain and its propagation. A real signed first-object control rejects the old implementation through the original Service window and completes the original native migration after the repair. Service expiry, current access and browser-credential rejection tests remain required.

Transport delay makes this estimate conservative; a later Service wall-clock discontinuity can still reject a request. This is neither general clock synchronization nor evidence that an unmeasured OS offset caused a particular CI attempt. See the [incident record](../../../postmortem/0225-handoff-object-proofs-compared-unrelated-clocks.md).
