# Decision Record: Capture notification sources at native publication

Status: implemented

## Problem

Native completion and error events identify a Session but do not by themselves identify its optional organization binding when the event occurred. Looking up the current Session after asynchronous delivery can associate an older event with a later driver or binding epoch. Personal Scope routes also cannot represent organization, account, deployment, project and Session identity.

## Decision

`SessionSchemaRegistry` accepts an optional synchronous notification-reference contribution. The installed owner derives its reference from the producer's original Session Info. Core captures only Scope ID, Session ID, an actual parent ID when present, and separately named owner references. It does not infer a root from a parent, copy the complete Info or depend on the optional organization protocol.

References use strict versioned schemas, finite scalar fields and an 8 KiB encoded envelope. Capture parses independent values and freezes the envelope, references and field records before returning. Component absence leaves the original personal event unchanged. Invalid optional completion-source metadata omits that source without undoing the durable completion notice or inventing organization identity.

The organization Runtime's existing Session schema owner contributes only its canonical binding. Completion captures its source in the native producer; invocation and processor error paths retain an entry-time snapshot across asynchronous work. An explicitly supplied completion source does not fall back to a later Session lookup. These references describe provenance and never authorize reading, delivery or execution.

The canonical Web notification resolver retains an explicit organization origin and uses the existing organization route builder. It includes account and deployment identity and does not borrow a personal directory route. Personal completion, child suppression and error semantics retain their existing paths.

## Alternatives considered

**Look up the current Session when a notification is delivered.** That lookup can observe a later driver or binding. Delivery still needs current authorization, but it must compare that authorization with the event's original source.

**Put organization fields or the complete Session Info in core events.** The first couples core to an optional component; the second exposes titles, paths and unrelated domain data. A bounded owner reference keeps both responsibilities explicit.

**Infer successful work from idle or a completed message.** The native completion notice is the success signal. Idle is lifecycle state, and error publication remains distinct.

## Consequences

Real temporary-Runtime tests cover completion publication before owner mutation, immutable separate references, component absence, invalid-reference handling and the installed organization binding projection. Resolver tests preserve the personal cases and reject using a personal route for an organization event. These are foundation contracts: cross-space event transport, subscriber ACL checks, source retirement, background personal connection retention and final browser acceptance remain separate required work. This change alone does not deliver UI-03.
