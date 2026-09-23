# Workspace and File Operations

Runtime Local owns native filesystem subscriptions in `packages/runtime-local/src/file/watcher.ts` and declares each subscription's Scope or Workspace owner in startup. Harness owns generic Scope, storage and file contracts; importing Harness alone does not start a native watcher.

Synergy keeps project ownership (`Scope`) separate from the directory in which a session executes (`workspace`). The normal workspace is the selected project directory; a session can instead bind to a Synergy-managed worktree without changing its owning Scope, config, Notes, or session index.

The Harness Workspace catalog owns a stable ID and a versioned local binding. Sessions persist only `workspaceID`; their public `workspace` descriptor is resolved from that catalog. Multiple Sessions share the same binding, while rebinding preserves the ID and advances its generation. Execution verifies the host namespace, generation and directory identity. A missing catalog record, missing directory, or replaced directory retains its historical reference and fails execution.

Owner-local migrations upgrade old embedded Session directories before navigation or other current projections read them, preserving activity and unrelated owner metadata. Transcript and Rollout archives include referenced Workspace metadata. Imported bindings remain unavailable until explicitly rebound, even if their historical path exists locally; import does not convey filesystem authority.

## Scope Runtime Services

A project `ScopeRuntime` starts Scope configuration, commands, recovery and plugin services lazily. `WorkspaceRuntime` starts file services once per Workspace binding generation:

- file watching and ignore rules
- formatter discovery and format-on-write events
- LSP clients, diagnostics, hover, symbols, and code actions
- VCS state and Git operations

File services use `WorkspaceState`, so Sessions sharing a Workspace share file resources while sibling directories retain independent caches and processes. Rebinding rejects stale callers and replaces resources from the previous generation. Scope disposal drains all its Workspace resources before releasing Scope state.

File, LSP and VCS notifications retain Scope event ordering and include Workspace ID and binding generation. Workspace subscribers filter both fields. Configuration subscriptions watch the owning Scope's configuration directory; editing a worktree's ordinary files does not relocate that configuration owner.

## Workspace Write Coordination

`WorkspaceAccess` owns a Session turn's native write reservation. Its first file mutation reserves the Workspace directory, so writes to different files in one Workspace serialize across Sessions while pure reads and disjoint native roots can proceed. Reservations expand when an operation touches additional roots. Runtime Local coordinates independent Runtime instances through a private, atomic host ledger; canonical paths, ancestor overlap and filesystem identities determine exclusion. A null root set excludes every host writer.

Each physical write has an operation claim in addition to its turn reservation. Cancellation or Cortex handoff can release the turn reservation without releasing an in-flight mutation. Use claims protect directory lifetime without blocking ordinary writes. A turn retains use claims for each explicitly shared Workspace it resolves, preventing rebinding during execution; changing the selected Workspace's grants also excludes active users. Exclusive lifecycle claims exclude both readers using the binding and writers. Process claims can transfer to a verified native process identity and cannot be released while that process is alive; native launchers are responsible for binding the claim before activating execution and retaining a supervisor until all owned processes exit.

An active Session changes Workspace through `Session.updateWorkspace()`. The owning task pins and validates the selected generation before persisting it, then replaces its execution context and logical reservations. Parallel admitted operations reject the switch; independent processes retain their original claims. Persistence failure leaves the old binding active. Ordinary Session editors cannot change the binding. A missing old directory does not prevent switching to a valid destination. Child creation and forks retain unresolved historical IDs unless an explicit null selection clears them.

Windows Bash and PTY commands also start in a passive worker. The host assigns that worker to a named, non-breakaway, kill-on-close Job Object before binding its claim and activating the command. The job name includes the worker's native creation time, and kernel active-process accounting retains occupancy through detached descendants. Other Runtime instances reopen the same global job identity to verify completion; closing the last owner handle terminates the tree before the object disappears.

A process claim separates its compiled writable roots from the Workspace bindings it uses. An empty writable set permits concurrent writers, including host-wide writers, while still excluding rebinding or removal of its used directories. A controlled temporary write root does not by itself reserve the read-only Workspace as a writer.

Waiting for Workspace access yields tool and Cortex execution capacity. Parallel tools retain the Cortex slot while any branch is still executing; the last active branch yields it when the remaining branches are waiting. Resumption reacquires capacity and revalidates cancellation and the binding before execution. Cortex launch and output waits hand off the parent's write reservation, allowing a child in the same Workspace to run. The parent reserves again before its next write. Waiting on a live process owned by the same Session or an ancestor reports `WorkspaceBusyError` instead of waiting on itself.

The native coordinator bounds admission time and queued claims, preserves uncertain process ownership, and reaps only verified exited or recycled processes. Live claims are never expired merely because they are old. A stale lease cannot remove its successor. The coordinator is an execution ordering mechanism; capability authorization remains owned by execution policy.

PTY records retain their Workspace ID and binding generation while their Scope index supports listing existing terminals after a Session changes directory. Workspace and Scope disposal drain terminal shutdown before dropping resources. On macOS, terminals launch through the same independently supervised native process tree as Bash; an empty-environment detached child retains the write claim after the shell and browser connection exit. User terminals are unconfined and therefore hold host-wide writable ownership.

The native PTY transport uses bounded byte queues and Node stream backpressure. UTF-8 decoding happens after transport, EOF drains before terminal completion, and replay never splits surrogate pairs. Slow WebSocket consumers and oversized input are disconnected without terminating the terminal. Failed termination retains the visible terminal tab and native ownership. Core, full and workspace-module packages include the same verified native library and license notices.

## Worktree Ownership

Worktrees have explicit owners such as a session, Cortex task, Blueprint workflow, or internal orchestration record. Creating or entering a worktree updates session workspace binding; leaving returns to the project checkout according to the worktree lifecycle.

The active worktree is the default write and execution boundary. Ordinary files in the original checkout can be read when they are not sensitive, but autonomous work cannot modify or execute from the original checkout. Cleanup removes resources only when their recorded owner permits it; a worktree is not inferred to be disposable merely because one session stopped using it. It becomes eligible for the managed-worktree cap only once it is idle, clean, free of local-only commits, and unlocked; a worktree that fails any of those tests is reported with its reason instead of reclaimed. The cap therefore bounds growth without ever deleting the only copy of unpushed work, and a lock written outside Synergy is never cleared.

Worktree use and removal share one in-process lifecycle gate. Session execution reserves the worktree before project services start, while create, enter, and leave reserve it around binding changes. Removal first excludes new users, refreshes the binding registry, and refuses any active session use; only then can it migrate idle bound sessions back to the main checkout and remove the directory. Automatic sweeps use the same removal gate, retain unverifiable commits and all on-disk locks, and drain before Scope disposal. Missing external worktree registrations are never pruned by the sweep. Binding registry updates are serialized per worktree so concurrent enters and leaves cannot overwrite one another. A stale managed record whose Git worktree and directory are already gone is cleaned from the registry after its idle bindings are migrated, without attempting filesystem status or deletion.

The Settings worktree browser queries only Git project Scopes and keeps successful project results when another repository is unavailable. List enrichment is concurrency-bounded. Dirty state is reported for live Git worktrees; managed worktrees also report checkout file bytes, excluding shared Git metadata. Main and external worktrees remain visible but read-only in this surface.

Eligibility reporting below the managed-worktree cap does not reserve a directory for removal. Actual reclamation rechecks eligibility while holding the removal gate.

Automatic worktree reclamation and missing-registration reconciliation preserve each bound session's canonical `time.updated` and navigation `lastActivityAt` while publishing the changed workspace. Rebuilding the derived navigation index therefore retains the same activity order. Maintenance metadata updates do not move historical sessions ahead of recent conversation activity. Explicit workspace operations and new conversation activity retain their normal recency behavior.

## Web Workspace File Service

`GET /workspace` lists the Scope-owned catalog and `POST /workspace` registers an existing local directory. `POST /workspace/:workspaceID/sharing` updates direct writable grants with an expected metadata revision; grants stay inside the Scope and do not transitively inherit another Workspace's grants. `POST /workspace/:workspaceID/rebind` conditionally changes a local binding after excluding active users and retiring its native resources. Both publish sequenced `workspace.updated` records. `POST /session/:sessionID/workspace` selects a Workspace ID and expected binding generation for an idle Session without changing its Scope. `/path` and Scope bootstrap use the same path projection, including the canonical default Workspace descriptor.

File API queries require `workspaceID` and `workspaceGeneration` alongside Scope resolution. A missing selection is a validation error, another Scope's ID is not found, and an unavailable or stale binding is a conflict. Raw document and download URLs retain the Scope, Workspace ID, and generation in their path prefix so relative assets cannot retarget after rebinding.

The Session status bar and new-session composer open the same Workspace selector. Existing directories can be registered without moving the Scope; direct sharing and explicit rebinding use conditional updates. Editing either form retains its original revision across incoming catalog events. An unbound historical Workspace remains visible but cannot be selected for local execution until rebound. Busy or conflicting operations keep the dialog open with the server's structured error.

The current selection preserves Home's absent Workspace and preserves unresolved historical Workspace references. It does not turn missing history into the Scope's default directory. Choosing none is the explicit operation that clears a reference.

Scope bootstrap includes the Workspace catalog. The frontend merges catalog events and snapshots using the Scope epoch and sequence, then projects current Session bindings without changing conversation activity. Delayed Session responses cannot replace a newer known binding with an old generation. Already-open file tabs retain their captured binding instead of following the Session to another directory.

The Web file workspace exposes scoped routes for directory children, file metadata, text/image preview, PDF byte streaming, file/content/symbol search, VCS status, and user-direct file writes. Every path is resolved inside `ScopeContext.current.directory`. Lexical escapes, control characters, and symlinks whose real path escapes the workspace are denied.

Directory results can hide ignored and dot-prefixed entries, are sorted with directories first, and use bounded cursor pages. Reads distinguish:

- UTF-8 text with line range, byte size, truncation, and next range
- bounded inline images encoded for preview
- unsupported binary or oversized content with a reason

PDF preview is a separate bounded byte stream: `GET /workspace/files/content` (operationId `workspace.files.content`) serves the raw bytes of a workspace PDF with `Content-Type: application/pdf` and `Cache-Control: no-store`. It accepts `.pdf` by extension or `application/pdf` MIME, rejects non-PDF files with `WorkspaceFileUnsupportedPreviewError` (400) and files over 50 MiB with `WorkspaceFileTooLargeError` (400), and reuses the same 403/404 error shapes as the other routes. PDF bytes never enter the JSON `read` union, so a PDF still reads back as `kind: "binary"` metadata.

Raw downloads and previews retain an open file descriptor and a Workspace use claim beyond the HTTP handler. Atomic replacement of the pathname does not retarget an existing stream. Reads are bounded by the captured file size and consumer demand; EOF, cancellation, request abort and Workspace disposal close the descriptor and release the claim. A file truncated while streaming fails rather than returning a silently incomplete body.

Search has three independent modes:

- files — a cached workspace index plus fuzzy path matching
- content — bounded fixed-string ripgrep results
- symbol — active LSP workspace-symbol results, with an explicit unavailable capability when no LSP client is active

File-index scans consume and retain at most 50,000 complete paths, deduplicate retained paths, preserve results collected before a subprocess output limit or scan timeout, and mark the search response as truncated whenever a bound is reached. A workspace that is too large for one bounded index scan therefore returns partial file matches instead of failing the route with a 500 response or retaining an output-sized object graph indefinitely.

File-result path enrichment has its own finite timeout and fails open to the complete basic path results when optional metadata is unavailable. Caller cancellation still propagates, while `truncated` remains reserved for an incomplete index or result page.

The classic debug file search is lazy and reuses this same bounded project index. Starting a project Scope does not launch a second fire-and-forget repository scan.

The workspace-file routes include read/browse/search/status and conditional filesystem operations. The text-edit route is `POST /workspace/files/write` (operationId `workspace.files.write`), a user-direct edit channel. Writes are bounded by the same path rules as reads — lexical escapes, control characters, and symlinks whose real path escapes the workspace are denied — and additionally:

- sensitive paths are rejected via `SensitivePathPolicy` in write mode (Git metadata and secret/credential files such as `.git`, `.env`, and credential stores are not editable), and the check also runs against the resolved real path so a symlink whose target is a sensitive file cannot bypass it
- a target can be missing or a regular file; directories, special files, dangling symbolic links and read-only filesystem targets are refused
- `expectedVersion` is required: the SHA-256 version from a complete read authorizes replacement, and `null` authorizes creation only; changed bytes return 409 even when timestamps are preserved, unless the caller explicitly selects `conflictPolicy: "overwrite"`
- content is capped at 8 MiB and parent-directory creation is opt-in via `createParents`

Write failures use the same structured error shape as the rest of the API: `{ name, data: { message } }` with `WorkspaceFileAccessDeniedError` (403), `WorkspaceFileWriteConflictError` (409), `WorkspaceFileTooLargeError` (400), `WorkspaceFileInvalidContentError` (400), and `NotFoundError` (404).

A successful write invalidates the Git-status cache and the frontend refreshes through the filesystem watcher; no `file.edited` event is published. This route is the user editing their own workspace directly: it is profile-independent and bypasses the agent approval/sandbox pipeline, so path safety is enforced by the service itself rather than by execution policy. Agent write operations remain separate and use the governed tool pipeline (write/save_file tools with permission decisions, locking, events, formatting, and diagnostics), never this route.

Writes share the native atomic replacement path with agent file tools and the anchored patcher. Canonical-path locks serialize cooperating processes. The writer stages and flushes a sibling file, rechecks content and directory identity, and publishes by rename or exclusive creation. Cancellation removes the staged file. Replacement preserves executable permission bits and leaves other hard links unchanged. Base64 content preserves raw bytes; invalid UTF-8 is returned as binary metadata instead of editable replacement characters.

## Directory Entry Operations

The file Explorer exposes new files, new folders, copy, move/rename and permanent deletion through generated `workspace.files` SDK methods. The action form captures its Workspace and the selected entry version. F2 opens move/rename and Delete opens an explicit permanent-deletion form. A failure preserves entered paths; choosing another Workspace does not retarget an open form. Unsaved drafts remain at their original paths through moves and deletion.

`POST /workspace/files/directory`, `/copy`, `/move` and `/delete` share native Workspace write exclusion and path validation. Move, copy and delete require an `entryVersion` obtained from node metadata. This version describes filesystem entry identity and metadata; text replacement continues to use its independent exact-byte content version. Entry operations resolve parent directories while acting on the final symbolic link itself. Reads through an external or dangling link remain unavailable, but the link can be inspected, moved or deleted. Workspace roots and protected descendants cannot be modified through these routes.

Copy prepares a sibling staging directory, preserves file bytes, permission bits, timestamps and link text, then verifies its source tree before publishing. The native destination operation never replaces an existing entry. Move uses the same native exclusion and uses verified copy followed by conditional source removal across filesystems. Directory operations bound traversal at 100,000 entries and 256 levels. Destructive operations check each selected entry and retain new or changed entries; a partially completed removal or cross-filesystem move returns a structured conflict with the completed paths. Permanent deletion is explicit and does not claim to use the operating system's Trash.

Successful operations invalidate the file index and publish Workspace-qualified events. Only a confirmed move emits a rename event. A native watcher batch containing a sibling deletion and creation cannot establish that the two entries are the same file. External replacements remain ordinary content invalidations; unrelated files cannot inherit open tabs or drafts through a guessed rename.

## File Workbench Ownership and Bounds

`apps/web/src/context/file/index.tsx` is the single frontend data owner for the File workbench. File tabs live in the Side Workspace as resource tabs. The Context panel is a separate session-scoped Side Workspace singleton and does not own files. Web and Desktop use generated `workspace.files.*` SDK calls against the active Scope rather than renderer or Electron-main filesystem reads.

Each session persists its open files, active tab, source/preview mode, selection, scroll state, and Explorer layout. Scope-level directory state keeps the expanded tree and hidden/ignored preference warm across sessions in the same project.

Editor drafts capture their original content version and survive file-panel remounts and Workspace selection within the Scope. Watcher refresh updates the disk snapshot without changing that baseline. A conflicted save retains the draft; typing during an in-flight successful save retains the newer text and advances its baseline to the saved version. Drafts are protected from document and Workspace-cache eviction.

The workbench keeps resource use bounded:

- server directory pages resolve nodes with concurrency 16
- frontend directory requests use concurrency 6 and document reads use concurrency 3
- document content keeps at most 24 entries or about 32 MiB
- PDF preview bytes live in a separate cache with a 50 MiB per-file cap and at most two decoded buffers, keeping open tabs protected
- Monaco keeps at most 12 models or about 24 MiB
- the Explorer keeps at most 25,000 loaded nodes and virtualizes visible rows

The project watcher is enabled by default. The workspace subscription excludes `.synergy` and other high-cost repository/build paths, while a separate `.synergy` subscription accepts only classified project runtime inputs such as config, agents, commands, skills, and custom tools. This keeps managed worktrees, caches, logs, and runtime state out of the workspace event path without making `.synergy` unavailable to explicit File workbench browsing. Folder ignores are plain top-level names (native top-level prefix paths: kernel exclusions on macOS, prefix pruning on Windows) **plus** recursive globs (`**/.synergy/**`, `**/node_modules/**`, …), so nested occurrences such as a generated worktree's `node_modules` are pruned at any depth of the Linux inotify tree walk and by every backend's event filter. User `watcher.ignore` extras are passed through verbatim and may be top-level folder names or absolute paths.

On Linux, an inotify capacity error (`ENOSPC`, "No space left on device") stops live watching instead of retrying: the kernel watch table cannot clear while the process runs, and each retried recursive scan repeats the native allocation that exhausted it. The first failure trips a process-wide breaker — the native backend and its watch budget are shared by every scope — so the failing scope's remaining subscriptions and other scopes' subscriptions skip native scans until `FileWatcher.reload()` resets the breaker or the process restarts; the error is logged with remediation guidance (raise `fs.inotify.max_user_watches` or open a smaller workspace, then reload watcher state or restart). `SYNERGY_DISABLE_FILEWATCHER=1` remains a full diagnostic escape hatch. Because Linux inotify scans cannot be cancelled, recovery never abandons an in-flight subscribe at the generic 10s timeout, and watcher state initialization never blocks on a native settle — the attempt runs in the background, settles before the next attempt starts, and cannot leak partial watches into the shared native backend.

A Linux scan that stalls rather than failing (typically a network-filesystem subtree such as NFS/autofs) is not cancelled: later Linux subscriptions queue behind it, one stall warning is logged after 60 seconds, and a settle notice follows when the scan ends. If the kernel watch budget was exhausted by sibling processes rather than this process — the budget is per-user — it can recover once they exit, but re-arming live watching still requires a watcher reload or restart.

Workspace events enter one per-Workspace drain that deduplicates paths, processes one batch at a time, bounds pending paths, and updates the file index without resolving Git status. Git-status reads share one in-flight build and perform at most one follow-up build when invalidated during that work. VCS branch refreshes run only for the dedicated Git `HEAD` event, not for ordinary file changes. If the watcher queue overflows, the backend invalidates its caches and emits one `file.watcher.updated` event with `resync: true`; the File context refreshes the root, expanded directories, and active document. `SYNERGY_DISABLE_FILEWATCHER=1` remains a diagnostic escape hatch. Refocus, refresh, and directory expansion still validate state, so correctness does not depend on lossless per-file delivery.

## Classic and Anchored Coding Tools

Synergy supports ordinary file tools and an anchored coding harness. The anchored family uses:

- `view_file` for an exact file/range view
- `scan_files` for bounded text matches
- `parse_code` for AST-aware matches
- `revise_file` for surgical changes
- `resolve_conflicts` for atomic, tag-checked merge-conflict resolution
- `save_file` for new files or intentional full-file replacement

Anchored reads return a `[path#TAG]` representing a session-local snapshot of that file. Displayed lines are recorded separately. `revise_file` accepts only a real current tag and operations on lines that the agent actually saw; fabricated, stale, truncated, or unseen anchors are rejected. `resolve_conflicts` also requires the current tag and exactly one explicit resolution for every conflict block in the file.

Every successful edit mints a new tag and makes older tags stale. The patch language applies all ranges to the original snapshot, resolves block operations with syntax-aware parsing, rejects overlapping/duplicate file sections, detects no-op loops, and refuses surgical edits across unresolved merge-conflict markers. A conflicted file must be resolved atomically with `resolve_conflicts`, or intentionally replaced in full with `save_file`. This turns freshness and observed context into enforced preconditions rather than prompt-only advice.

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

File snapshots share one Git object store and reference namespace per Scope under Synergy data. Each session, Workspace identity and binding generation has an independent, rebuildable index. Bound non-Git directories participate in text snapshots without creating a user Git repository. `SnapshotStore` is the sole resolver for registered legacy repositories and the shared store; snapshot readers validate session ownership before using a tree hash. The user's Git repository is not an object-store dependency.

Snapshot parts and derived file differences retain the source Workspace ID, binding generation and root. Transcript and Rollout transfer include references from all historical parts and summaries, remap them to unbound imported identities, and preserve original identity metadata. A reference without location metadata retains a null historical path and cannot obtain a local binding from an equal ID. Summary cursors group each binding separately; old cursors rebuild from historical parts without inventing binding authority for unattributed records. Historical object comparisons use the Scope store even when no local Workspace exists. Literal filenames use NUL-delimited Git metadata, preserving whitespace, backslashes and newlines.

Capture holds a shared Scope lease and an exclusive session index lock, writes objects, and retains `refs/synergy/snapshots/<session>/<tree>` before returning the tree hash. All historical roots remain retained. Fork and JSON import establish destination ownership before publishing copied messages; JSON import reports unavailable file objects as warnings. Archive, compaction of messages, and transcript rollback do not release roots.

Permanent deletion writes a durable deletion job and tombstones the owner before removing canonical session data. Both ordinary removal and recovery removal finish the same cleanup; startup resumes pending jobs. Physical collection occurs only through explicit offline maintenance, under an exclusive Scope lease. Full-home copies also hold a home-wide lease that excludes creation of new snapshot Scopes during the copy. A failed integrity check or unfinished maintenance job blocks collection. Process start identities use a consistent UTC encoding; lease age alone never displaces a live process.

Snapshot lease admission shares one timeout budget across the Home and Scope metadata gates and honors cancellation while waiting. Exhausted admission reports snapshot busy; corrupt metadata and storage failures remain errors. Lease disposal uses an independent, uncancelled file-lock wait so an expired admission deadline does not prevent removing ownership. See [lease lock budgets](../decisions/implemented/bug-fix/2026-09-22-snapshot-lease-lock-budgets.md).

The central `20260907-snapshot-shared-store` migration inventories owners without scanning objects. Explicit maintenance imports missing objects through a streaming SQLite inventory, preserves unknown objects, verifies roots, switches the owner, and then removes the legacy copy. Full-data archives materialize alternates and merge Git objects and references separately from JSON files. See [storage layout](../reference/storage-and-paths.md), [maintenance commands](../reference/cli-guide.md), and [the storage decision](../decisions/implemented/architecture/2026-09-07-shared-file-snapshot-storage.md).

Offline migration verifies historical trees in batches and publishes retention refs for at most 32 repositories together through a durable packed-ref file before switching ownership. Each source and its import keep remain intact until the entire batch is published. Cleanup rechecks shared ownership and the complete historical retention set with one ref scan per session. Required historical trees are explicitly included in the import inventory because Git can synthesize an empty tree that is absent from disk. Recovery can supply a missing historical tree in the shared store before migration; verification requires the complete history in the destination. Empty optional step snapshot strings carry no root; malformed nonempty references still fail verification. Reclaimed repositories with a confirmed session record follow the same migration; repositories without a session record remain unchanged. Loose copies remain until the packed file and its directory entry are flushed; Git before 2.36 retains explicitly flushed loose refs because it cannot durably replace packed refs. Import keeps and legacy sources survive any publication failure. A session filter also limits legacy owner registration. Pre-upgrade loose-object packing is an artifact-only maintenance operation under process ownership and the exclusive Scope lease, using a disk inventory and verified staging packs. It never imports records, drops unknown objects, or edits a source already included in an interrupted SQL backup. See [the maintenance decision](../decisions/implemented/bug-fix/2026-09-16-lossless-legacy-snapshot-compaction.md).

Object transfer stages one pack on disk and gives that file directly to Git’s strict indexer; producer and consumer errors retain their stage, and cancellation removes the temporary pack while keeping source repositories and import protection intact.

Scope-wide migration consolidates an old shared pool after all legacy owners have migrated. Every pool object receives a preserved reference in the standalone shared store. The pool keeps its original refs, index and unclassified artifacts; a flushed relative Git alternate replaces its local object copies, so unowned borrowers and relocated data directories remain readable. Session-filtered pilots leave pools unchanged. Interrupted publication retains local copies, and interrupted cleanup resumes from the retained shared objects and import keeps.

Message rollback changes the effective transcript through history events. It does not modify project files. Explicit file restoration owns the Session loop until native mutations drain. Harness verifies retained trees and original Workspace ID, generation and root; Runtime Local validates every target before reserving the complete set of writable roots. It compares entry identity and exact-byte content evidence captured before admission, atomically replaces file or link entries, and preserves newer conflicting files. Missing provenance, unavailable bindings, directories, special files and protected or escaping paths cannot authorize restoration. Results distinguish restored files, conflicts, cancellation and partial publication; Web reports the actual counts and never automatically retries a prompt after a failed restore. Redo is constrained once newer history makes the rollback ambiguous.

## Invariants

- Scope owns project context; workspace owns the execution directory.
- Worktree removal excludes new execution and binding use before it validates and migrates current bindings.
- Web file routes never escape the active workspace, including through symlinks; user-direct writes additionally reject sensitive paths, read-only targets, and conflicting content versions.
- File workbench state and caches have one frontend owner and explicit concurrency/size bounds.
- Tool reads and writes still cross execution-policy and sensitive-path checks.
- Anchored tags prove a file snapshot; seen-line tracking proves the agent observed an edit range.
- Formatting and diagnostics run after the persisted write and can change the final returned tag/diff.
- Transcript rollback and file restoration are separate explicit operations.
