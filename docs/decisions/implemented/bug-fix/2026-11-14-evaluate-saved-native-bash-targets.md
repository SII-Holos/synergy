# Decision Record: Evaluate saved native Bash targets

Status: implemented

## Problem

A real Hosted permission response persists all approved Bash patterns, but a later Project on the same Runtime asks again because the resolver checks only its generalized capability target. Skipping the native target request after profile authorization also prevents an exact saved denial from being observed for a low-risk command.

## Decision

The original resolver evaluates every actual Bash pattern against the native user and Session rules. An exact saved or configured denial rejects the complete request. A complete explicit allow can resolve only a soft ask; high risk, opaque commands, non-bypassable requirements, external boundaries and explicit resource confirmation retain their original handling. The native Bash backend submits its actual targets even after initial authorization, while the resolver retains the original accepted-call fact to avoid a duplicate approval for the same effect. Approval metadata records the actual user-rule source.

Persistent rules remain owned by the enrolled Runtime Home. Actual Hosted acceptance approves Project P, completes its native command and original release, then completes Project Q on the same Runtime without a second prompt. A separately enrolled Home still prompts for the identical command and retains no rules after rejection. Its rejected tool callback drains without inventing a terminal model reply or a completed-root release.

## Alternatives considered

**Allow the generalized capability wildcard after an always response.** This loses the complete native target set and can authorize a different effect.

**Skip target evaluation after profile authorization.** This fails to observe an exact native denial for an otherwise low-risk call.

**Treat rejection as completed work.** A stopped tool-calling turn can still require a later model call. Its partial Run and pending release are retained by the original lifecycle owner.

## Consequences

Native regressions cover complete and partial saved rule sets, deny precedence, autonomous denial and mandatory destructive approval. Hosted acceptance proves cross-Project reuse and independent-Home isolation through actual model tasks and public responses. This adds no permission owner, approval transport or profile matrix.
