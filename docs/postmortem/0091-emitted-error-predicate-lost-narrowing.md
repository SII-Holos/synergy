# Emitted error predicates lost consumer narrowing

## Executive summary

A standalone consumer could execute the packaged runtime but failed TypeScript checking. Util's inferred error predicate was emitted with an erased recursive constructor reference. Source tests could not detect the broken declaration consumed outside the workspace.

## Summary

`NamedError.create` returned an anonymous subclass whose predicate referenced that inferred constructor. The pinned compiler emitted the predicate as `InstanceType<any>`. Successful branches lost payload checking; failed branches narrowed caught errors to `never`, producing secondary diagnostics across Harness.

## Timeline

- 2026-10-25: a separate consumer of packaged public exports exposed the declaration failure.
- 2026-10-25: a regression compiled emitted declarations and reproduced both lost payload checking and unreachable ordinary-error handling.
- 2026-10-25: an explicit instance interface preserved narrowing and serialization types; the consumer regression and runtime error tests passed.

## Root cause

The inferred recursive declaration depended on a constructor local to a generic factory. Existing tests imported source and checked runtime behavior; neither verified the declaration artifact used by a downstream compiler.

## Guardrails

[The consumer regression](../../packages/util/test/error-declarations.test.ts) emits the owning source and compiles both branches of a downstream predicate use. An expected payload type error must remain observable, and the serialized value must retain its literal name. [The decision](../decisions/implemented/bug-fix/2026-10-25-preserve-emitted-error-narrowing.md) owns the public interface choice. The testing Skill requires emitted-artifact evidence for declaration failures.

## Lessons

Runtime package acceptance and source typechecking do not establish that published declarations preserve consumer types. Compiler-facing artifacts require a consumer compiled against the actual emitted output.
