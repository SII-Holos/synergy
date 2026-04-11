Debug a problem by analyzing the symptoms, finding the root cause, and suggesting a fix.

The user will describe a bug or unexpected behavior. Follow this process:

1. **Understand the symptom** — ask clarifying questions if the report is vague
2. **Locate the relevant code** — use the architecture skill to navigate: `skill(name: "architecture")`
3. **Read the actual code** — don't guess, read the implementation
4. **Trace the execution path** — follow the call chain from entry point to the symptom
5. **Identify the root cause** — not just the symptom, the underlying reason
6. **Check git blame/log** — when was the bug introduced? was it intentional?
7. **Propose a minimal fix** — prefer the smallest change that fixes the root cause
8. **Consider side effects** — what else might break? run tests after fixing

If given an error message or stack trace, start by searching for the error string in the codebase.

$ARGUMENTS
