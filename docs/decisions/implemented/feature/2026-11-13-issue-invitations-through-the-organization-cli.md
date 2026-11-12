# Decision Record: Issue invitations through the organization CLI

Status: implemented

## Problem

An administrator installing the independent service needs a supported invitation command. Invitation tokens are disclosed once, and a lost response does not establish whether an invitation was created. Printing tokens or automatically repeating an uncertain request can expose credentials or create additional invitations.

## Decision

`synergy org invite` and `synergy-org invite` use one domain command and the existing CLI parser. The command authenticates through the generated Organization SDK over an exact HTTPS origin, creates one invitation, and revokes its temporary login in cleanup. Passwords and optional CA bytes come from bounded private files; credentials and the invitation token never enter command arguments or stdout. It does not open a local Home or read personal configuration.

Before contacting the service, the command exclusively publishes and syncs a new private output marker. It verifies the actual descriptor and retained file identity and permissions before and after writes. The same file receives the token or a failed/unknown outcome; existing output paths are rejected before HTTP. The local marker prevents accidental resubmission but is not a service idempotency receipt. Structured errors preserve service outcome, code and request identity. An uncertain response is never retried automatically.

The required dependency graph gains the pure generated SDK, preserving the optional CLI peer. Source and packed executable acceptance use real isolated HTTPS service fixtures. The shared testing package owns their synthetic localhost certificate bytes.

## Alternatives considered

**Print the token or pass administrator passwords in arguments.** Terminal history, logs and process listings would retain secrets outside their private files.

**Retry invitation creation on a transport error.** The server may have committed the first request. A client-generated request identifier cannot add idempotency to an operation that does not accept it.

**Write the output file after receiving the token.** A crash can lose both the token and the only local evidence of the attempted mutation. An unsynced directory entry has the same failure despite syncing the file itself.

**Add a separate parser or raw request command.** The domain command and generated SDK preserve argument help, error semantics and the existing invitation owner without another administrative transport.

## Consequences

An administrator must provide explicit HTTPS trust, credentials and a new output file. Success stdout contains only role, expiry, output path and login-revocation status. A lost response or unavailable private output requires inspection through existing invitation management before another issuance. Deployment procedures live in the [service runbook](../../../operations/organization-service.md); actual output regressions are recorded in the [postmortem](../../../postmortem/0158-invitation-output-lost-private-or-durable-state.md).
