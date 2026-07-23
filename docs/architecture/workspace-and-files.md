# Workspace and File Operations

Synergy keeps project ownership (`Scope`) separate from the directory in which a session executes (`workspace`). The normal workspace is the selected project directory; a session can instead bind to a Synergy-managed worktree without changing its owning Scope, config, Notes, or session index.

## Scope Runtime Services

A project `ScopeRuntime` starts project-sensitive services lazily and disposes them as a unit:

- file watching and ignore rules
- formatter discovery and format-on-write events
- LSP clients, diagnostics, hover, symbols, and code actions
- VCS state and Git operations
- configured commands and project instructions
- plugin/MCP state that resolves in project context

These services use the session's active directory while events remain routed to the owning Scope. A worktree is therefore another execution directory for the same project context, not a second project.

## Worktree Ownership

Worktrees have explicit owners such as a session, Cortex task, Blueprint workflow, or internal orchestration record. Creating or entering a worktree updates session workspace binding; leaving returns to the project checkout according to the worktree lifecycle.

The active worktree is the default write and execution boundary. Ordinary files in the original checkout can be read when they are not sensitive, but autonomous work cannot modify or execute from the original checkout. Cleanup removes resources only when their recorded owner permits it; a worktree is not inferred to be disposable merely because one session stopped using it.

Worktree use and removal share one in-process lifecycle gate. Session execution reserves the worktree before project services start, while create, enter, and leave reserve it around binding changes. Removal first excludes new users, refreshes the binding registry, and refuses any active session use; only then can it migrate idle bound sessions back to the main checkout and remove the directory. Binding registry updates are serialized per worktree so concurrent enters and leaves cannot overwrite one another. A stale managed record whose Git worktree and directory are already gone is cleaned from the registry after its idle bindings are migrated, without attempting filesystem status or deletion.

The Settings worktree browser queries only Git project Scopes and keeps successful project results when another repository is unavailable. List enrichment is concurrency-bounded. Dirty state is reported for live Git worktrees; managed worktrees also report checkout file bytes, excluding shared Git metadata. Main and external worktrees remain visible but read-only in this surface.

## Web Workspace File Service

The Web file workspace exposes scoped routes for directory children, file metadata, text/image preview, file/content/symbol search, and VCS status. Every path is resolved inside `ScopeContext.current.directory`. Lexical escapes, control characters, and symlinks whose real path escapes the workspace are denied.

Directory results can hide ignored and dot-prefixed entries, are sorted with directories first, and use bounded cursor pages. Reads distinguish:

- UTF-8 text with line range, byte size, truncation, and next range
- bounded inline images encoded for preview
- unsupported binary or oversized content with a reason

Search has three independent modes:

- files — a cached workspace index plus fuzzy path matching
- content — bounded fixed-string ripgrep results
- symbol — active LSP workspace-symbol results, with an explicit unavailable capability when no LSP client is active

File-index scans consume and retain at most 50,000 complete paths, deduplicate retained paths, preserve results collected before a subprocess output limit or scan timeout, and mark the search response as truncated whenever a bound is reached. A workspace that is too large for one bounded index scan therefore returns partial file matches instead of failing the route with a 500 response or retaining an output-sized object graph indefinitely.

The classic debug file search is lazy and reuses this same bounded project index. Starting a project Scope does not launch a second fire-and-forget repository scan.

The current public workspace-file routes are read/browse/search/status contracts. Agent write operations use the governed tool pipeline rather than an unguarded file-service write route.

## File Workbench Ownership and Bounds

`packages/app/src/context/file/index.tsx` is the single frontend data owner for the File workbench. File tabs live in the Side Workspace as resource tabs. The Context panel is a separate session-scoped Side Workspace singleton and does not own files. Web and Desktop use generated `workspace.files.*` SDK calls against the active Scope rather than renderer or Electron-main filesystem reads.

Each session persists its open files, active tab, source/preview mode, selection, scroll state, and Explorer layout. Scope-level directory state keeps the expanded tree and hidden/ignored preference warm across sessions in the same project.

The workbench keeps resource use bounded:

- server directory pages resolve nodes with concurrency 16
- frontend directory requests use concurrency 6 and document reads use concurrency 3
- document content keeps at most 24 entries or about 32 MiB
- Monaco keeps at most 12 models or about 24 MiB
- the Explorer keeps at most 25,000 loaded nodes and virtualizes visible rows

The project watcher is enabled by default. The workspace subscription excludes `.synergy` and other high-cost repository/build paths, while a separate `.synergy` subscription accepts only classified project runtime inputs such as config, agents, commands, skills, and custom tools. This keeps managed worktrees, caches, logs, and runtime state out of the workspace event path without making `.synergy` unavailable to explicit File workbench browsing.

Workspace events enter one per-Scope drain that deduplicates paths, processes one batch at a time, bounds pending paths, and updates the file index without resolving Git status. Git-status reads share one in-flight build and perform at most one follow-up build when invalidated during that work. VCS branch refreshes run only for the dedicated Git `HEAD` event, not for ordinary file changes. If the watcher queue overflows, the backend invalidates its caches and emits one `file.watcher.updated` event with `resync: true`; the File context refreshes the root, expanded directories, and active document. `SYNERGY_DISABLE_FILEWATCHER=1` remains a diagnostic escape hatch. Refocus, refresh, and directory expansion still validate state, so correctness does not depend on lossless per-file delivery.

## Classic and Anchored Coding Tools

Synergy supports ordinary file tools and an anchored coding harness. The anchored family uses:

- `view_file` for an exact file/range view
- `scan_files` for bounded text matches
- `parse_code` for AST-aware matches
- `revise_file` for surgical changes
- `save_file` for new files or intentional full-file replacement

Anchored reads return a `[path#TAG]` representing a session-local snapshot of that file. Displayed lines are recorded separately. `revise_file` accepts only a real current tag and operations on lines that the agent actually saw; fabricated, stale, truncated, or unseen anchors are rejected.

Every successful edit mints a new tag and makes older tags stale. The patch language applies all ranges to the original snapshot, resolves block operations with syntax-aware parsing, rejects overlapping/duplicate file sections, detects no-op loops, and refuses surgical edits across unresolved merge-conflict markers. This turns freshness and observed context into enforced preconditions rather than prompt-only advice.

`save_file` bypasses line-level anchoring because it owns the complete replacement. It still crosses normal permission, conflict, formatting, diagnostic, snapshot, and event boundaries.

## Write Pipeline

A governed file write can include:

1. path resolution and protected/external path classification
2. current-content and conflict checks
3. user/profile permission decision with file diff metadata
4. per-file locking and atomic write
5. file-edited event and format-on-write
6. reread of formatter output
7. LSP diagnostic delta
8. runtime reload evaluation for affected Synergy/config/plugin sources
9. durable tool result, patch metadata, and session snapshot update

The exact stages vary by tool, but no write path should create a second unclassified filesystem capability.

## Snapshots, Rollback, and Restore

Session snapshots use an isolated Git object/index area under Synergy data rather than committing to the user's repository. Step snapshots and resulting patches support file-diff display and later restoration.

Message rollback changes the effective transcript through history events. It does not modify project files. Restoring files is an explicit operation that checks the selected snapshot/patch records and reports per-file failures. Redo is constrained once newer history makes the rollback ambiguous.

## Invariants

- Scope owns project context; workspace owns the execution directory.
- Worktree removal excludes new execution and binding use before it validates and migrates current bindings.
- Web file routes never escape the active workspace, including through symlinks.
- File workbench state and caches have one frontend owner and explicit concurrency/size bounds.
- Tool reads and writes still cross execution-policy and sensitive-path checks.
- Anchored tags prove a file snapshot; seen-line tracking proves the agent observed an edit range.
- Formatting and diagnostics run after the persisted write and can change the final returned tag/diff.
- Transcript rollback and file restoration are separate explicit operations.
