# Decision Record: Project member discovery

Status: implemented

## Problem

Project maintainers can change a known account's project role, but the organization client has no authorized way to enumerate project members or find an account to add. Requiring organization account administration would exclude ordinary project maintainers and expose unrelated management data.

## Decision

Project member pages require current project read access and return only public account identity, account state and the project role. Membership candidates require current project management permission. Both reads include the current project revision so subsequent membership mutations retain the existing compare-and-set contract.

Membership pages enumerate the canonical project membership index before loading account identities. Candidate search scans at most one bounded account page per request and returns a continuation cursor when more scanning remains. Every continuation resolves current credentials and project authorization. Responses omit password hashes, credential revisions, login sessions and organization management rights.

## Alternatives considered

**Use the organization account administration list.** That action deliberately requires organization administration and returns management fields. Widening it would weaken an unrelated boundary.

**Accept an arbitrary account identifier in the form.** The existing mutation remains available, but making people obtain opaque identifiers elsewhere does not provide a usable project management flow.

## Consequences

Project maintainers can manage membership through the generated organization API without acquiring organization administration. Search can return an empty page with a cursor because scan work is bounded independently of matching results; clients follow the cursor when more results are needed.
