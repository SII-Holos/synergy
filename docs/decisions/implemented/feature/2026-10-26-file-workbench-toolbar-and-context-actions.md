# Decision Record: A single file toolbar and contextual entry actions

Status: implemented

## Problem

The file workbench repeated the resource name and exposed navigation and editing controls in separate visual groups. Common filesystem actions required a generic operation selector and an entire destination path. Adopting familiar Explorer interactions must not replace captured Workspace authority, observed versions, explicit editing or the existing resource-scoped drawer.

## Decision

The workbench uses the selected B layout: one main toolbar with Files disclosure, compact captured Workspace origin, optional parent-directory navigation, Source/Preview, source wrapping and explicit editing controls. The outer resource tab owns the filename. The origin picker retains full path options and binding generations; selecting an origin opens a directory resource through the existing close policy rather than changing a document's owner. The shared Workspace navigator owns resizing and narrow drawers.

The Explorer adopts inline new-file/new-folder naming and F2 rename, contextual cut/copy/paste and relative-path copy, and a dedicated permanent-delete confirmation. Enter confirms inline names; Escape cancels. Naming rows are scrolled into the virtual range before focus. Context menus preserve the initiating node, including an explicit root target for empty-area commands, and do not intercept native button activation. File operations keep the captured entry version and generated SDK path. Local copy-name suggestions avoid known collisions; the server rejects concurrent or unobserved collisions without overwriting.

The existing FileProvider manager retains an in-memory clipboard across file-panel remounts. Paste requires the captured server, Scope, Workspace and binding generation. Successful cuts are consumed; copies remain reusable. Entry writes remain registered with the FileProvider so a successful move's resource-key remount cannot abort its response; caller cancellation and provider disposal still cancel the transport. The destination is expanded before that remount. Drafts remain at their original paths during entry changes. Source wrapping defaults on, uses the existing per-file session view state and changes only the current Monaco options, including through owner-scoped Alt+Z.

The interaction reference is the VS Code Explorer; its source is cited beside `createFileEntryActions`. This adopts its naming and clipboard habits, not its filesystem authority, implicit editing model, OS trash or entire IDE layout.

## Alternatives considered

**Separate directory and document headers (A).** The selected single-toolbar layout groups the persistent controls without another filename or independent header hierarchy.

**Reading-first navigation hidden by default (C).** The selected layout keeps the saved navigation preference and changes only its presentation at narrow resource widths.

**A generic operation form.** It requires users to choose an operation after selecting an entry and enter a full path for routine tasks. Inline names and contextual actions make the affected entry and destination explicit; destructive deletion still requires confirmation.

**Another drawer, preference store or direct filesystem layer.** Existing navigation, persisted view state and Workspace SDK owners already cover these responsibilities. Parallel implementations would diverge in focus, draft recovery and version checks.

## Consequences

The toolbar has one hierarchy and familiar file actions remain close to their target. Virtualized naming, nested-menu dismissal and captured asynchronous identity require behavioral regressions, including long trees, narrow views and failed writes. Wrapping remains independent of source bytes and editing state.

The Explorer browser suite executes the private entry-action component in Vite/Chromium, which Bun cannot attribute to TSX in its coverage report. The existing coverage manifest classifies that one renderer file with its behavioral test path; package thresholds are unchanged. Real Workspace acceptance verifies bytes and destination visibility separately from mocked SDK responses.

The clipboard is not an OS file clipboard and does not authorize cross-Workspace transfers. Name suggestions use observed directory entries; partial listings or concurrent changes can still produce a visible server collision. No operation silently retries with a newer source version, overwrites an existing destination or discards a dirty draft.
