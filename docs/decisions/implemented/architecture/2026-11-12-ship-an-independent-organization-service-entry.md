# Decision Record: Ship an independent organization service entry

Status: implemented

## Problem

An organization deployment needs initialization and service startup outside a source checkout. Full product composition reads feature preferences and can contribute Agent, Desktop and Library commands, so enabling the organization feature in a personal installation does not provide an independent service deployment.

## Decision

The organization package owns the `synergy-org` executable. It contributes the same initialization and service command definitions to the single CLI parser through its contribution-only mode. Every contributed command owns initialization; discovery, rejected input and command execution bypass ambient configuration and logging initialization. A dedicated absolute Home remains mandatory for operations that open storage.

The service library keeps CLI as an optional peer. Executable installations and the service image explicitly install the matching CLI version; applications importing the service do not acquire that peer through the required dependency graph. The executable is an explicit service embedding, separate from managed component runners and their sealed installation generations.

Image staging uses the existing workspace packer and isolated package installer. It requires matching organization, CLI and Linux native archives, copies the installed closure, and rejects full product, Library, Browser and Computer components. The image runs the service as an unprivileged user. Compose separates one-time initialization from the persistent HTTP service and forwards a loopback port for a TLS reverse proxy.

## Alternatives considered

**Enable the organization feature in a complete product installation.** This leaves discovery dependent on unrelated feature preferences and selects a larger composition than a dedicated service requires.

**Implement another command parser or service handler in the image.** Duplicate argument validation, Home selection and lifecycle cleanup would diverge from domain-owned commands.

**Make the service library depend on CLI.** Programmatic service consumers would gain Agent and plugin packages solely to obtain executable argument parsing.

**Publish a separately resolved image dependency graph.** Installing the existing archives through the shared installer keeps package and image acceptance on the same release bytes and platform selection.

## Consequences

The executable and container can start independently without personal configuration or an Agent Runtime. Shared CLI dependencies contain Agent-related code, but the service entry never opens that composition or installs Library models. Packaged acceptance exercises real initialization, health requests, shutdown and persistence from a directory outside the repository.

Compose's minimal deployment uses the service's local SQL storage. PostgreSQL, object stores, hosted Runtimes and Execution Hosts require their own configured owners; merely starting neighboring containers cannot activate those integrations. Deployment procedures live in the [organization service runbook](../../../operations/organization-service.md).
