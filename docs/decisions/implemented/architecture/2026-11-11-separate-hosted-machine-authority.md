# Decision Record: Separate hosted machine authority from member accounts

Status: implemented

## Problem

Organization execution registration originally required an account and device. A hosted executor cannot inherit the registering administrator's identity: account logout, removal and project membership changes describe human access, while already accepted work retains its own execution grant.

## Decision

Keep a discriminated registration record for member and hosted machines. Members retain their account/device identity and current-account fences. Administrators register named hosted machines with an organization, deployment and public key; registration attribution is not execution authority. Both kinds use the same ticket consumption, signing proof, connection epochs, heartbeat, receipt and resource owners.

Provision hosted Homes by organization and host identity using the existing recoverable private Home owner. Open hosted execution through the same organization Runtime composition and worker entrypoints. Hosted composition excludes Desktop and personal configuration. Session creation records the signed actor as creator; member machines additionally require that actor to match their account.

Machine authority resolves the canonical registration, active state, deployment and current connection before execution-grant and gateway access. Only member machines additionally resolve an active human account. Hosted accepted work remains bound to its original Session, driver, epoch, root and resource contract. Current user authentication and project authorization still gate every new human command.

## Alternatives considered

**Use the registering administrator's account.** This would make unrelated human credentials control machine lifetime.

**Create a hosted execution kernel.** This would duplicate scheduling, receipt and worker isolation behavior.

## Consequences

Existing member records and Home digests remain valid. Hosted records have no account or device identity. Organization members can discover hosted execution targets, while provisioning and revocation require administrator access. Real storage, TLS enrollment, WebSocket heartbeat and Runtime composition tests cover the two registration kinds.
