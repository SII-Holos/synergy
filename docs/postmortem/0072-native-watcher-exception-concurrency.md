# Concurrent native watcher failures escaped their callers

## Executive summary

A managed backend exited at a Bun/JavaScriptCore exception-extraction assertion. Missing worktree roots were also retrying indefinitely and duplicating failure logs. Those symptoms initially lacked a demonstrated connection. Reducing an isolated workload found that concurrent failed native watcher subscriptions can independently corrupt error delivery. Root-aware terminal recovery and serialized native admission address that exercised path; the original backend's full JavaScript stack remains unknown.

## Evidence

- A mixed watcher, destroyed-stream, invalid-cwd, asynchronous-context and collection workload reproduced the recorded native fault offset with Bun 1.4.2 under default JIT settings.
- Removing Shell, outer asynchronous context or forced collection did not eliminate every failure. Four missing-root native subscribers alone could fail; one subscriber completed the same class of work.
- The native-only experiment also failed on Bun 1.4.3. An upgrade was therefore not treated as a repair.
- Failures included an escaped rejection, a segmentation fault and the exception-extraction assertion. Exit signals alone could not classify them as memory exhaustion.

## Root cause and limits

The reduced trigger is concurrent native subscription rejection. Its precise engine defect remains upstream work; the source-level protection prevents that concurrency in the owning runtime. Independently, recovery treated missing roots as transient, and the timeout cleanup chain treated an original subscribe rejection as an unsubscribe failure.

A subscription's caller and native operation do not have the same lifetime. Timing out the caller cannot prove the scan ended. Releasing serialization at that point recreates the overlap. Queued owners must also be checked immediately before native admission, since disposal can happen while waiting.

## Guardrails added

- The [native admission decision](../decisions/implemented/bug-fix/2026-10-12-native-watcher-subscription-serialization.md) separates queue ownership, timeout observation and native settlement.
- A child-process regression executes four callers and 400 rejected native subscriptions without risking the parent test runner. Deferred tests retain a native slot through timeout and verify cleanup and capacity-breaker order.
- The [missing-root decision](../decisions/implemented/bug-fix/2026-10-12-missing-watcher-root.md) covers terminal recovery and explicit reload after restoration.

## Lessons

Minimize native failures before attributing them to model traffic or memory size. Keep both the reduced native workload and broader mixed-load results: serializing one source does not establish a universal engine fix, and an escaped rejection remains a failed stress run even without a native assertion.
