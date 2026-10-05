# Decision Record: Share the Docker confinement policy with a Host broker

Status: implemented

## Problem

A privileged Host can grant a profile worker access to a bounded Docker Engine broker. Validating a worker request against a duplicated security policy would let the broker and canonical Environment provider disagree after an upstream change.

## Decision

The Docker Environment module exports its existing HostConfig builder. Allocation and a composing Host broker can use the same confinement policy. The Host still owns validation of the immutable image, allocation labels, mounts and resource budgets, and keeps the raw Engine socket outside workers.

## Alternatives considered

**Copy the policy into a Host.** Independent copies can admit different privileges.

**Expose the raw Docker Engine.** A worker could request privileged containers or mount Host files.

## Consequences

The provider retains its existing allocation behavior. Hosts can validate confinement through a public export without importing private seccomp implementation files. The helper does not authenticate callers or prove physical termination.

## Verification

Local-runtime type checking and the execution transport/profile suites pass. The Docker allocation integration remains a separately required Linux verification.
