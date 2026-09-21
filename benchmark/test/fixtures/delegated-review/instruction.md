Fix `normalizeName` and `initials` in `/app/names.mjs`.

For a string input, `normalizeName` must trim leading/trailing Unicode whitespace and collapse every internal run of whitespace to one ASCII space, preserving the remaining text. `initials` must normalize the name, take the first Unicode code point of each word, join those code points and uppercase the result. An empty or whitespace-only name has empty initials. Preserve non-BMP letters and emoji; never split a surrogate pair.

Make the change in the existing Git working directory. Add and run focused tests, then request exactly one `maintainability-reviewer` specialist review of your uncommitted changes in this same working directory. Wait for the review, address its findings and rerun your tests. Do not start another review, create another worktree or commit the changes.
