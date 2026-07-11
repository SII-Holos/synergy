Diagnose the reported Synergy problem and identify its root cause. Do not implement a fix unless the user also asks for one.

1. Restate the observable symptom, expected behavior, target runtime, and reproduction boundary.
2. Search the exact error, route, event, tool, or state field with `rg`.
3. Load `architecture` to trace entry point, owner, persistence, enforcement, events, and consumers.
4. Load `find-logs` or `inspect-sessions` when runtime evidence or persisted state is involved.
5. Reproduce with the narrowest safe test. Use `develop-synergy` for an isolated second runtime; never restart the active instance.
6. Use `git log -S`, `git log -G`, `git blame`, or `git show` only when history can distinguish intent from regression.
7. Prove the causal chain and identify the smallest coherent fix plus its regression test and documentation impact.

Report evidence, root cause, affected scope, confidence, recommended fix, and verification plan. Separate confirmed facts from hypotheses and redact secrets, absolute paths, and session content.

$ARGUMENTS
