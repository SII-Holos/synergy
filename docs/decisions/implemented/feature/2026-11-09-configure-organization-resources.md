# Decision Record: Configure organization resources with explicit use grants

Status: implemented

## Problem

Organization model and business resources need centrally managed credentials and current use authorization. Exposing provider configuration to a member Runtime can leak upstream secrets or allow arbitrary transports. Filtering all resource bodies after pagination can also omit authorized resources or hydrate unrelated configuration.

## Decision

The organization service owns versioned resources with immutable organization/project scope and protocol. Owners and administrators manage configurations; current account/project grants and an execution role independently authorize selection. A project-scoped resource cannot be selected or granted to another project. Administrator configuration access is not an execution grant.

Supported configuration contracts declare OpenAI-compatible and Anthropic-compatible models, remote MCP HTTP/SSE and fixed-target HTTP. Model descriptors contain bounded identities, explicit capabilities and context limits without arbitrary Runtime packages, provider options or headers. Explicit self-hosted HTTP endpoints are supported; embedded credentials, query/fragment credentials and other URL schemes are rejected.

Store secret values in separate owner records. Publish only credential metadata to administrators and omit both credentials and upstream addresses from member descriptors. Credential rotation and resource metadata share one transaction. No catalog read loads secret values.

Account/project grants have independent optimistic revisions. Revocation retains its canonical revision and removes its access index atomically. Available-resource pages merge bounded authorized indexes before hydrating metadata, deduplicate overlapping grants, and recheck the canonical records inside one snapshot.

## Alternatives considered

**Send provider configuration to the Runtime.** This expands the credential and transport authority beyond the organization gateway.

**Treat administrator status or any grant as sufficient execution authority.** Resource selection also depends on current project roles and availability.

**Delete revoked grants or filter global catalogs after paging.** Deletion loses revision conflict evidence; global filtering produces incomplete pages and reads unrelated configuration.

## Consequences

The generated organization SDK exposes administrative configuration, credential rotation, grant management and authorized project descriptors with structured revision conflicts and redacted errors. Configuration and selection grants do not themselves open execution; native task reception, root binding and invocation authorization remain separate.

These are additive versioned records with no existing resource data to backfill. Tests use real SQL, HTTP and generated clients for authorization, fixed scope, credential rotation, rollback, restart, revoked revisions, archived/removed roles, strict configuration and multi-index pagination beyond a page.
