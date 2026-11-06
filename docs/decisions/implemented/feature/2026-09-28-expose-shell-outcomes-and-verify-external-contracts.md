# Decision Record: Expose shell outcomes and verify external contracts

Status: implemented

## Problem

A foreground Bash command could return a successful pipeline status while earlier validation output contained failures. Its exit code was retained in metadata but absent from the model-visible result. Focused tests also left externally observable defaults, boundaries, consumers and asynchronous transitions unchecked in several local-24 trajectories.

## Decision

Foreground Bash results append the shell exit code or signal to the model-visible text while retaining the original output and metadata. Background results keep their process instructions. The Bash description asks agents to run validation directly and treats filtered output as diagnostic evidence. The `synergy-max` prompt asks for the relevant external contract and, for cross-layer changes, one real call path after focused tests; it does not require every case category or delegation on each task.

## Alternatives considered

**Infer failures from output text:** A warning, assertion excerpt or filtered log cannot reliably establish the command's exit status. It would invent failures or mask the shell's actual result.

**Add a new test tool or a detailed mandatory checklist:** Both increase permanent tool or prompt surface without addressing the missing Bash completion signal. A conditional verification rule covers varied projects without forcing irrelevant tests.

## Consequences

The model sees how the shell ended even when output is long or a pipeline masks an earlier command. The footer reports the shell's status, not the success of every command inside a pipeline; agent verification still needs direct tests and relevant external behavior. Raw output, structured metadata, permissions and tool schemas remain available to callers.
