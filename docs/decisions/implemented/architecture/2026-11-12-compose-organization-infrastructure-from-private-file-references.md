# Decision Record: Compose organization infrastructure from private file references

Status: implemented

## Problem

The independent organization executable needs external SQL, object storage and execution resources without importing a personal Runtime's profiles or credentials. Hosted machine startup also needs an executable outside full product feature discovery.

## Decision

The dedicated organization domain accepts optional version-one `organization.infrastructure` settings. PostgreSQL URLs, object credentials and Docker TLS material live in explicitly referenced private files. The loader checks regular files, private permissions, bounded reads and retained identity; errors expose a reason rather than contents. The same loader supplies actual database and cloud options to initialization and serving, preserving their authoritative namespace.

Organization composition reuses Local Runtime's public S3/OSS stores and Docker provider. Named stores become Workspace profiles; named Docker profiles retain native allocation, authenticated Execution Host and shutdown owners. Personal configuration and Secret Vault profile lookup do not select providers.

The Runtime package owns `synergy-org-runtime`, an explicit embedding of existing machine commands in the single parser. Hosted startup consumes the existing bounded private stdin request, prepared Home and verified enrollment. A separately selected image includes that package; service-only images retain their smaller component selection.

## Alternatives considered

**Reuse personal ResourceProfiles registration.** That resolver reads personal configuration and credential references, which are not organization deployment inputs.

**Put credentials in JSONC or arguments.** Private file references keep serialized configuration and process arguments free of secret values while supporting standard mounts.

**Start an unconditional Execution Host beside the service.** Each execution allocation requires its native target, generation and ephemeral credential. The existing provider must create and verify that allocated host.

**Treat configuration loading as recovery evidence.** Constructing endpoints cannot prove SQL authority, object coverage or writer retirement. External recovery remains blocked until owning reconstruction and coverage evidence exists.

## Consequences

The executable selects real backends through domain-owned factories. Operators preserve private files separately and restart after changes. Linux CI provisions PostgreSQL, MinIO and Docker execution; packaged hosted acceptance enrolls and starts the executable over verified HTTPS. Skipped external tests establish no backend acceptance.

The fixed MinIO and mc infrastructure fixture images are built from the same official release versions when their former registry images are unavailable. Architecture-specific asset hashes, source revisions, the unmodified server entrypoint and upstream licenses are pinned in the [build definition](../../../../packages/organization/deploy/Dockerfile.objects) and [release provenance](../../../../packages/organization/deploy/minio-release-provenance.json). Private mounted credential files and mc configuration retain their original owners. This changes fixture distribution, not the S3 provider or its authorization; only actual Docker-backed infrastructure acceptance proves the rebuilt images work.

The native recovery guard for external database and cloud composition remains mandatory. The loader returns operational options and grants no restore or publication authority. Procedures live in the [service runbook](../../../operations/organization-service.md).
