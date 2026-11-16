# Decision Record: Stream canonical organization commands through Desktop

Status: implemented

## Problem

Organization input and decision payloads already have canonical byte limits larger than an ordinary Desktop control request. Applying the control frame limit to a complete command prevents valid messages and answers from reaching the existing signed admission path.

## Decision

Use a typed Desktop command stream for generated input and decision calls. Keep their canonical payload limits, UTF-8 encoding and logical request IDs. Reuse the existing Runtime command chunk size. A separate IPC nonce identifies the transfer without becoming a second logical command identity.

Main captures the trusted document, organization connection and account at the first frame. It reserves the existing request lease, validates sequential offsets, chunk sizes, canonical base64 encoding, total bytes and SHA-256, then parses the assembled body with the original command schema. Only a complete validated command reaches the generated input or interaction reply method. Main rechecks the captured owner between frames and before submission; credentials never enter renderer frames.

Cancellation, sign-out, document replacement and deadlines abort the shared lease and release buffered bytes. Concurrent duplicate completion cannot close an already sending command. Cancellation also ends the IPC wait when an underlying transport has not released its response. Physical in-flight buffers remain bounded independently of command lifetime or history.

Ordinary JSON controls retain their existing request limit. Publication file transfer and native content downloads retain their separate typed contracts. The API token settings action permits only its three exact metadata/create/revoke routes; it does not admit first-party token exchange or Runtime ticket routes.

## Alternatives considered

**Raise every JSON control limit.** This would enlarge unrelated privileged operations and still confuse command payload limits with transport frame limits.

**Split one command into several logical messages or replies.** This would change acknowledgement recovery, ordering and the exact payload bound by the signed permit.

**Retry after a lost stream response.** Transport completion does not establish the command's outcome. The caller retains its original logical request and reconciles through the existing receipt owner.

## Consequences

Valid larger commands use the same generated APIs and signed admission as smaller commands. The bounded transfer buffers a canonical payload before dispatch and creates no alternate Session or permission model. Protocol, generated Web injection and Main tests cover multibyte payloads, separate identities, fixed routes, corrupt offsets and hashes, duplicate completion and cancellation. These checks do not establish end-to-end Agent execution or a completed UI collaboration flow.
