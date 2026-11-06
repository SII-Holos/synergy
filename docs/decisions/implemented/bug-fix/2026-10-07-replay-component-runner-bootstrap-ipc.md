# Decision Record: Replay component runner bootstrap IPC after listener registration

Status: implemented

## Problem

Installed workers can receive IPC while the launcher is asynchronously verifying their pinned installation generation and importing modules. The launcher buffers those messages, but buffering is useful only if every IPC-consuming dispatch path releases them after its receiver is registered. The core runner path has that handoff; the metadata-owned component runner path omitted it, leaving early messages in the bootstrap queue.

The installed Workbench reader depends on an early `start` message to initialize its reader and respond to its parent. Library's one-shot embedding runtime check does not consume IPC, so that existing metadata runner did not exercise the missing handoff. The defect belongs to shared installed runner dispatch, not to the reader's storage or query behavior.

## Decision

The metadata-owned component runner path passes the launcher's `resumeWorker` callback into `runComponentRunner(entry, name, ready?)`. Inside its RuntimeContext, the helper imports the selected module, invokes the named export, captures its returned completion value, calls `ready`, and then awaits completion. The context is disposed in `finally` after completion settles or invocation fails.

An IPC-consuming component's `main()` must register its process message listener synchronously, before its first `await`. The callback marks completion of that synchronous registration phase; it does not establish general asynchronous readiness. A component remains responsible for any protocol-level `ready` response after resources are initialized. A long-lived runner returns a Promise covering its lifetime, including shutdown, rather than returning immediately after starting detached work.

The launcher removes its bootstrap receiver and replays buffered messages in arrival order when this callback runs. This follows the existing [verified installation generation decision](../architecture/2026-09-25-installation-generations.md): verification precedes component imports, workers use their parent's pinned generation, and early IPC is preserved until the selected receiver exists. Metadata remains the dispatch authority for optional component runners. This fix adds neither a `CORE_RUNNERS` entry nor full product composition.

## Alternatives considered

**Resume before invoking the component export.** Importing a module does not prove its runner has registered a message listener. Replaying at that point can discard the same early messages the bootstrap queue exists to preserve.

**Await the runner's completion before resuming IPC.** Completion represents the runner's lifetime, not registration. An IPC-driven worker can wait for `start` or `shutdown` while those messages remain buffered, preventing completion and the replay it depends on.

**Add the reader to `CORE_RUNNERS` or load full product composition.** Either choice moves an optional component's dispatch into shared core machinery or activates unrelated components. Neither corrects the missing handoff for other metadata-owned runners; the generic callback fixes that path without widening its dependency graph.

## Consequences

Listener registration, protocol readiness and runner completion are distinct events. The helper preserves RuntimeContext lifetime through asynchronous execution without waiting for worker completion to deliver bootstrap messages. One-shot runners still finish naturally; IPC-consuming runners must honor the synchronous-listener and lifetime-Promise requirements. The callback cannot detect a component that registers its receiver only after an asynchronous yield.

The behavioral regression fixture uses a sealed synthetic installation and sends `start` immediately after spawning the installed launcher. Its observations cover listener registration, an echo of the early `start`, absence of disposal while the worker is live, and disposal after `shutdown` settles the runner. This records test coverage intent, not a passing execution result or acceptance of the Workbench reader's separate functionality. The [CLI Skill](../../../../.synergy/skill/add-cli-command/SKILL.md#installed-component-runner-lifecycle) owns the verification procedure.
