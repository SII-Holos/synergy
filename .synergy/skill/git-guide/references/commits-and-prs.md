# Commits and pull requests

## Make a Focused Commit

Commit, stage, push, or create a PR only when the user requests that action.

1. Review `git diff`, `git diff --stat`, and untracked files.
2. Iterate with the narrow behavior tests; before publication run `bun run verify local --test <repository-relative-test>` with the relevant tests. Use `verify coverage --package` for coverage-policy, instrumentation or substantial coverage removal. Static receipts let pre-push reuse unchanged successful deterministic checks; CI never consumes those receipts.
3. Stage explicit task paths. Never stage secrets, local config, logs, traces, diagnostics, runtime data, or unrelated user work.
4. Re-read `git diff --cached`.
5. Write a concise conventional commit using an imperative summary. Allowed types follow repository convention: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `perf:`, and `chore:`.
6. Explain what and why in an optional body, not a step-by-step account of how.
7. End every agent-created commit with the exact co-author footer:

```text
<type>: <imperative summary>

<optional body — what and why, not how>

Co-authored-by: synergy-agent <299070056+synergy-agent@users.noreply.github.com>
```

Do not amend a commit unless it was created in this task, has not been pushed, and the user requested amendment or a hook modified the intended content. Never rewrite someone else's work.

## Push and Open a PR

1. Confirm the current branch is a non-protected topic branch and inspect the exact push target. Publication does not require a worktree.
2. Push only the topic branch; never push `dev` or `main` directly.
3. Open the pull request against `dev`.
4. Use project-relative paths and redacted evidence in the PR body.
5. State the summary and exact test commands. Do not claim checks that were not run.
6. Check automated feedback against the current head and base. Review edits to existing PR comments as well as newly created comments; filtering only by creation time can hide the latest review result.
7. When the change implements a BlueprintLoop, state that loop's final status and audit conclusion in the body. An executor's own "done" is not an audit result: the loop counts as accepted only once `blueprint_loop_approve` settled it, and a loop left in `auditing`, failed, or rejected without a fresh audit is reported as unaccepted rather than described as complete.
8. Use a reviewed Note as the file input when outbound content requires user editing:

```bash
git commit -F /synergy/note/<note-id>
gh pr create --body-file /synergy/note/<note-id>
gh issue comment <number> --body-file /synergy/note/<note-id>
```

Do not interpolate Note contents into a shell command or pass them to an option that executes the file as code.

Commit coherent verified units when authorized, and finish generation and self-review before pushing the next candidate. Inspect `verify plan` and its `fullTriggers` before publication. After a CI failure, inspect all completed diagnostics and gather causal corrections before another push; avoid a separate full CI cycle for each related symptom. Retry infrastructure failures at the same SHA; a product correction requires new SHA-bound evidence. Do not rerun passing checks without changed inputs or an unresolved concern.

A required check can also fail for reasons that belong to the runner rather than the change: the local artifact build needs `docker`, and a hosted job can fail before it compiles anything. Distinguish the two before treating a red gate as evidence about the code, but do not merge past it either — re-run until green. A check that cannot be made green is a blocker to report to the user, not a condition to waive.

The `autonomous` profile permits ordinary topic-branch and pull-request publication from either the primary checkout or a worktree. Protected-branch pushes and broader remote mutations remain `shell_remote_write` and are denied. This capability boundary does not replace the user's authorization to publish.
