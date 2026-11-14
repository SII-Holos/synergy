# Decision Record: Member Runtime provisioning and local HTTP ownership

Status: implemented

## Problem

A native host must bind a member Home before a product launcher creates installation state there. The Home metadata entry cannot depend on Bun-only file APIs in Electron's Node process. A resident member Runtime also needs a private local HTTP endpoint without inheriting another Runtime's credentials or process lifecycle.

## Decision

Member Home provisioning remains in the organization adapter's public metadata entry and uses the existing Harness ownership record. Its bounded reads use portable filesystem streams, and RuntimeContext retains test-home detection through the active host's entry information. Node provisioning and Bun startup share the same identity, locks and private atomic writes.

An explicit listener option selects the existing Server component and Agent Runtime resident lifecycle. It requires a nonzero port and a private 256-bit bearer credential, fixes the bind address to loopback, and applies the existing authentication middleware to health and business requests. The default embedded member mode retains its one-shot behavior. Shutdown and failed-open cleanup remain owned by RuntimeHandle.

The organization Runtime adapter is a composition owner and may depend on the Server's public component entry. The package dependency rule records this direction; neither Server nor Harness depends on the organization adapter.

## Alternatives considered

**Provision after launching the installed CLI.** The launcher can create module state before the domain's empty-Home check. Provisioning before launch preserves the rule against adopting unrelated data.

**Duplicate Home provisioning inside Desktop.** Separate ownership checks and key writers would create competing interpretations of persisted identity and interrupted initialization.

**Add an independent local server or rely on loopback alone.** A second server would duplicate lifecycle and routing ownership; loopback does not distinguish another local process or Runtime.

## Consequences

Native hosts can prepare a member identity without loading Agent storage, while the actual Agent Runtime remains Bun-hosted. Callers own port selection and the ephemeral bearer credential. The listener adds resident recovery but does not grant organization command authority, select native Browser capabilities or merge the separate outbound bridge lifecycle.

Tests exercise real Node provisioning and test-home rejection, matching Bun reads, oversized metadata, two authenticated HTTP instances, credential rotation on restart, endpoint closure, invalid listener settings and storage-lock recovery after a port conflict.
