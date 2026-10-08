# Decision Record: Construct recursive Agent error validation without an eager clone

Status: implemented

## Problem

Agent-turn IPC validates serialized error causes recursively. Chaining `.strict()` after an object whose getters reference its own constant can evaluate those getters before the constant is initialized. Zod 4.4.3 exposes this cold-import failure, preventing the Runtime from starting before any IPC message can be handled. Removing strict validation would admit undeclared worker fields rather than correct initialization.

## Decision

`AgentTurnProtocol` constructs `SerializedCause` with `z.strictObject` and retains its typed recursive getters. Strictness is part of initial construction, not a subsequent object clone. Cause fields, the aggregate limit of 16, serialization and deserialization, and the IPC protocol version remain unchanged. The public serialized-error parser tests nested cause and aggregate acceptance, unknown-field rejection at every tested recursive level, and the 16/17 aggregate boundary.

A dependency upgrade is a separate compatibility and performance decision. Passing this protocol regression does not establish compatibility of generated JSON Schema, OpenAPI, plugin manifests, or other dependency consumers.

## Alternatives considered

**Wrap recursion in `z.lazy`.** A local fixture also avoids early self-reference. Direct strict construction preserves the existing inferred recursive object type and does not introduce additional wrappers when the object constructor already supports recursive getters.

**Remove `.strict()` or defer validation at callers.** This changes the worker admission policy or duplicates validation outside the protocol owner. Neither is necessary to fix schema initialization.

**Treat startup success or a synthetic schema-bank benchmark as upgrade acceptance.** Neither exercises the full Runtime workload or reference consumers. Dependency publication requires separate measured benefit and compatibility evidence.

## Consequences

The recursive schema imports successfully under the pinned version and the tested newer version while preserving strict parsing. The focused protocol suite also covers error round-tripping and truncation. A cold-process run remains necessary during schema-library upgrades because an already-loaded module can hide initialization failures. This change alone makes no memory-saving or full dependency-upgrade claim.
