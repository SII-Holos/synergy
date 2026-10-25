# Decision Record: Preserve emitted error narrowing

Status: implemented

## Problem

Consumers of compiled Util declarations must retain a structured error's literal name, payload and serialization types after `isInstance`. A predicate referring to the factory's inferred anonymous constructor can lose its recursive target during declaration emission, although source checks and runtime tests pass.

## Decision

[NamedError](../../../../packages/util/src/error.ts) exposes a named generic instance interface for the predicate. It refines the base serialization methods directly, preserving their literal name and payload. Construction, runtime name matching and serialization behavior stay unchanged. The [consumer regression](../../../../packages/util/test/error-declarations.test.ts) emits actual declarations and compiles a separate consumer against them, checking both narrowing branches and the serialized value.

## Alternatives considered

**Retain the anonymous constructor reference.** This is concise inside the source module but declaration emission erases the predicate target, breaking external consumers.

**Suppress consumer diagnostics or replace the predicate with a boolean.** Suppression conceals lost type safety, while a boolean discards the narrowing that callers require.

## Consequences

The exported interface is part of the public type surface and must remain aligned with the generated class. The regression adds two small compiler invocations without starting a Runtime or requiring a provider. It protects emitted declarations separately from runtime behavior; the [postmortem](../../../postmortem/0091-emitted-error-predicate-lost-narrowing.md) records the escaped failure.
