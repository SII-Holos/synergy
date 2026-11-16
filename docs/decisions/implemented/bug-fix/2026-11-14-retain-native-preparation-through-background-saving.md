# Decision Record: Retain native preparation through background saving

Status: implemented

## Problem

A Bash invocation can return a background process while its native Execution is still running. Tool resource disposal then attempted to release the operation's preparation, policy and admission before the original execution had completed saving. The preparation owner correctly refused that premature release.

## Decision

`EnvironmentResources.retainExecution` transfers cleanup of the original resolved preparation to its actual committed `EnvironmentProcess`. The private registered object, original preparation, Runtime/Store, operation identity, digest, target and origin must match. Copied resource objects cannot retain or prepare. The returned closure grants cleanup only.

Tool disposal immediately closes new preparation access. A running or unknown execution retains its original canonical preparation, policy and Use. The original process completion path finishes saving before invoking cleanup; cleanup rechecks the same committed Execution and requires its completed state. Repeated cleanup uses the original owner and preserves failures. Already released sandbox cleanup is accepted only after the original preparation reports that exact sandbox released. Remote execution sources retain their existing lifetime path.

## Alternatives considered

**Relax preparation's completion guard.** That would release an active process's policy and admission rather than fixing their owner lifetime.

**Make the reproducer foreground-only.** A valid background result is the trigger and must retain the same resource guarantees.

**Trust a copied resource shape or terminal hint.** Neither establishes original private ownership or saved native completion.

## Consequences

Native process ownership extends through actual completion and saving without adding another execution registry or persisted format. Unknown outcomes remain available to the original recovery owners. Real Native preparation and process tests cover held background stdin, policy/Use retention, copied-object refusal, save completion, checkpoint conflicts and paused stream drainage. See the [background preparation postmortem](../../../postmortem/0192-background-bash-released-native-preparation-too-early.md).
