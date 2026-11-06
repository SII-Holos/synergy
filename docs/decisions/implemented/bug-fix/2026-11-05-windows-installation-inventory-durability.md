# Decision Record: Preserve installation inventory durability on Windows

Status: implemented

## Problem

Installation generation publication hashes and synchronizes staged files before activation. A read-only handle supports this synchronization on POSIX, but Windows rejects its flush with `EPERM`, preventing generation creation and Desktop runtime assembly. Linux-only installation tests do not establish this Windows behavior.

## Decision

Durable inventory hashing opens existing files with read/write access on Windows and read-only access on POSIX. It retains content hashing, required synchronization, error propagation and handle cleanup. Windows CI owns the existing inventory and generation behavioral suites, including their affected-test selection, so installation changes retain native verification before publication.

The access requirement comes from [Microsoft's FlushFileBuffers documentation](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers), with provenance beside the owning implementation. A process-isolated permission fixture reproduces the Windows failure on other development hosts; native Windows runs exercise real files and complete generation transactions. POSIX coverage retains read-only file contents and permissions.

## Alternatives considered

**Ignore synchronization failures.** This would allow activation without the requested durability and conceal genuine storage failures.

**Use read/write handles on every platform.** This would reject valid read-only POSIX package files even though POSIX can synchronize them through a read-only handle.

**Leave validation to product Release.** Publication can already have created immutable npm versions before Desktop runtime assembly exposes a platform defect.

## Consequences

Windows installation publication can flush ordinary staged package files without truncating them. POSIX read-only hashing remains supported. Genuine access and synchronization failures still abort publication. Windows CI gains the bounded installation suites; full release packaging, signing, upgrade and registry promotion remain independent required gates.
