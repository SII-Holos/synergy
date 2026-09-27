# Decision Record: Align native matrix fixtures with Runtime contracts

Status: implemented

## Problem

Two deterministic native matrix controls assumed retired behavior. The unattended helper opened an explicit Runtime but resolved its Scope outside that Runtime's context. The real tool failed with `StorageClosedError` before writing its child-session evidence. Separately, a provider that permanently returned an empty `stop` response was expected to complete successfully, although the native session deliberately retries empty responses and records a structured terminal error when recovery is exhausted.

The retained native archives distinguish these failures. The unattended tool exits unsuccessfully before creating the marker, while its enclosing agent session completes. The empty-response control completes its three tool operations and earns the marker reward, then the native CLI exits with the session's `APIError` carrying `metadata.code=empty_response`. Neither result can be inferred from the verifier reward alone.

## Decision

The unattended fixture executes its existing Scope, parent/child Session, and permission checks through the opened Runtime's `run` method. It closes that Runtime in `finally`, including when input parsing or an assertion fails. The historical native adapter retains its existing Scope entry point.

The `empty-provider-stop` selection remains a permanent-empty-response failure control. It requires the native failed outcome and exit code, the exported root session's structured terminal `empty_response` error, and multiple actual attempts for that terminal message and empty wire responses. It does not pin incidental request totals or duplicate the product's retry budget. Ordinary controls still require successful native completion.

Both controls retain their existing model identities, tool execution, task Home, JIT, reward, archive, usage, request reconciliation, and cleanup checks. The provider response, product retry policy, execution deadlines, and evaluator scheduling are unchanged.

## Alternatives considered

**Treat the marker reward as successful agent completion.** The task side effect can finish before a later native failure, and a completed session can contain a failed tool. These are independent observations and must remain separately asserted.

**Supply text after an empty response or change the product loop.** A recovering provider is a different control. Replacing the permanent failure or accepting an invisible empty turn would erase the existing exhaustion boundary rather than validate it.

**Add ambient Runtime access or catch the missing child file.** The helper owns an explicit Runtime and must enter its context. Relaxing storage ownership or ignoring missing evidence would hide the fixture failure and weaken the parent/child interaction check.

## Consequences

The matrix now tests current native failure semantics without converting a failed execution into success. A direct execution of the original unattended helper reproduces the retained `StorageClosedError` in an isolated Home; the corrected helper must produce real inherited interaction metadata and release its Runtime on both successful and deliberately failing assertions. The full Docker controls remain the acceptance boundary for restricted egress, the native CLI, and the complete exported evidence.
