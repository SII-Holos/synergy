# Decision Record: Register and serve organization Runtimes through the CLI

Status: implemented

## Problem

Independent machine deployment needs supported registration and serving commands. A registration ticket already names a machine public key, so preparing that key and consuming its ticket are separate operations. Duplicating the supervised startup path would also separate shutdown, authentication and Home validation from existing Desktop and service launchers.

## Decision

`synergy org-runtime register/serve` and `synergy-org-runtime register/serve` use the same domain commands and CLI parser. Registration receives a bounded version-one private stdin request and an explicit absolute base directory. Without a ticket it prepares the identity-qualified Home and returns public key metadata or its retained registration. With a ticket it calls the existing verified-HTTPS enrollment owner. Keys, original registration identity and unknown-response reconciliation retain their existing owners; the command never automatically repeats enrollment.

Serving takes an explicit machine kind and dedicated Home, then runs the existing supervised lifecycle with its bounded private launch request, loopback listener and bearer. Existing member/hosted supervisor entries call that same function. Hosted input cannot select Desktop capabilities. Discovery, malformed input and registration do not initialize the ambient personal Home.

The CLI reference follows actual static command registrations and explicit contribution exports, preserving complete parent paths. Identically named children cannot replace another group's options. The generator binds only its collected source modules and does not execute command modules; the [reference postmortem](../../../postmortem/0161-cli-reference-merged-unrelated-command-names.md) records the regression.

## Alternatives considered

**Accept tickets before preparing their machine key.** The ticket would name another identity or require implicit re-registration. Preparation exposes only the public key needed by the existing service registration API.

**Add credentials to command arguments.** Process listings and shell history would retain ticket or listener secrets. Both machine request formats stay on bounded stdin.

**Implement a separate public Runtime startup path.** Listener authentication, deployment checks, parent ownership, reporting and shutdown already belong to the supervised owner.

**Merge command reference sections by leaf name.** `org serve` and `org-runtime serve` have different parameters. Their actual registered paths determine separate sections.

## Consequences

The administrator prepares a Home, obtains its exact registration ticket through the generated Organization SDK, then consumes it explicitly. Retained registration metadata does not establish current connectivity or Session execution authority. Deployment procedures live in the [service runbook](../../../operations/organization-service.md#register-and-serve-a-runtime). Source and installed child tests exercise both machine identities, private rejection, lost responses, key retention and graceful serving through the original lifecycle.
