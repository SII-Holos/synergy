# Issue #262 — Terminal CWD in Worktree Sessions

**Issue**: https://github.com/SII-Holos/synergy/issues/262
**Type**: Enhancement (Feature Request)
**Priority**: P3
**Area**: area/terminal

## Problem Statement

When a terminal is opened in a worktree-bound session, its working directory defaults to the **project root** (or scope directory) instead of the **worktree directory**. The user must manually `cd` into the worktree path every time.

## Root Cause

The PTY creation chain has a disconnect:

```
Frontend (terminal.tsx)
  → sdk.client.pty.create({ title: "..." })     ← no cwd passed
    → SDK POST /pty (x-synergy-directory header = scope root)
      → Server middleware: ScopeContext.provide({ scope })  ← NO workspace!
        → Pty.create(): cwd = input.cwd || ScopeContext.current.directory
            → workspaceContext.tryUse() is undefined (HTTP path)
            → falls back to scope.directory (= project root)
```

**The critical gap**: The session's workspace (which stores the worktree path) is only provided to `ScopeContext` during `SessionManager.run()` — the agent conversation loop. HTTP API requests (like `POST /pty`) go through a different path that has no workspace context.

Relevant code:

| File                                      | Line    | Role                                                                                |
| ----------------------------------------- | ------- | ----------------------------------------------------------------------------------- |
| `packages/synergy/src/process/pty.ts`     | 105     | `cwd = input.cwd \|\| ScopeContext.current.directory`                               |
| `packages/synergy/src/scope/context.ts`   | 45-48   | `ws?.path ?? scopeContext.use().directory` — workspace is always undefined for HTTP |
| `packages/synergy/src/server/server.ts`   | 281     | `ScopeContext.provide({ scope })` — no workspace                                    |
| `packages/app/src/context/terminal.tsx`   | 44-46   | `pty.create({ title: "..." })` — no cwd/scopeID override                            |
| `packages/synergy/src/session/manager.ts` | 186-194 | SessionManager.run() provides workspace — but PTY routes don't go through this path |

---

## Recent Commits: How the Status Bar Tracks Worktree

The status bar (and sidebar session icon) already dynamically reflects worktree state through
this pattern (from commits `4feac4c7` and `60ff3265`):

1. **`packages/app/src/context/workspace-transition.ts`** — a pure function `resolveWorkspaceTransition(part)`
   that inspects completed `worktree_enter`/`worktree_leave` tool parts and returns the new workspace.

2. **`packages/app/src/context/global-sync.tsx`** — the SSE `message.part.updated` handler calls
   `resolveWorkspaceTransition` and **optimistically updates** `store.session[X].workspace` before
   the WebSocket `session.updated` event arrives. This keeps `session.workspace` in the global
   sync store always accurate.

3. **Status bar** reads `session.workspace` from the global sync store to determine which icon/tone
   to show for each session.

**Key takeaway for terminal CWD**: The frontend's global sync store already has
`session.workspace` (with `type`, `path`, `scopeID`) accurately tracked for every session.
We can use this exact same mechanism to resolve the terminal CWD.

---

## Solution Approaches

### ★ Recommended: Frontend resolves CWD from session workspace in terminal context

**Core insight**: The terminal context (`terminal.tsx`) already has `params.id` (the session ID)
and can access `globalSync` which maintains `session.workspace`. When a terminal is created:

- Look up the current session in the global sync store
- If `session.workspace.type === "git_worktree"`, use `session.workspace.path` as `cwd`
- Otherwise, pass nothing (server defaults to scope directory — current behavior)

**How** (exact implementation):

```ts
// packages/app/src/context/terminal.tsx

init: () => {
  const sdk = useSDK()
  const params = useParams()
  const globalSync = useGlobalSync()

  // Resolve worktree CWD for terminal creation (lazily, so workspace updates are reflected)
  const getWorkspaceCwd = (): string | undefined => {
    const sessionID = params.id
    if (!sessionID || !params.dir) return undefined
    const [store] = globalSync.ensureScopeState(params.dir)
    const session = store.session.find((s) => s.id === sessionID)
    if (session?.workspace && session.workspace.type !== "main" && session.workspace.path) {
      return session.workspace.path
    }
    return undefined
  }

  const load = (dir: string, id: string | undefined) => {
    // ... existing cache logic ...
    const entry = createRoot((dispose) => ({
      value: createTerminalSession(sdk, dir, id, getWorkspaceCwd),
      dispose,
    }))
    // ...
  }
  // ...
}
```

Then in `createTerminalSession`, accept the getter and use it in `new()`:

```ts
function createTerminalSession(
  sdk: ReturnType<typeof useSDK>,
  dir: string,
  id: string | undefined,
  getWorkspaceCwd: () => string | undefined
) {
  // ...
  async new() {
    const cwd = getWorkspaceCwd()
    const pty = await sdk.client.pty.create({
      title: `Terminal ${store.all.length + 1}`,
      ...(cwd ? { cwd } : {}),
    })
    // ...
  }
}
```

**Files changed**: `packages/app/src/context/terminal.tsx` only (1 file, ~20 lines)

**Pros**:

- Single file change, no server/schema/SDK modifications needed
- Reuses the exact same `session.workspace` data that the status bar already relies on
- Lazy resolution via getter: workspace changes (via `worktree_enter`/`leave`) are immediately reflected
- SDK already supports `cwd` parameter in `PtyCreateData`
- Backward compatible: omitting `cwd` falls back to server default
- No regression risk

**Cons**:

- Frontend-only — external API/SDK clients don't get this behavior (they'd need to pass their own `cwd`)
- Requires `useGlobalSync` in the terminal provider

**Effort**: Small (1 file, ~20 lines)

---

### Approach B: Server-side session resolution (Architectural alternative)

**Change**: Add optional `sessionID` to `Pty.CreateInput`. In the PTY route handler, look up the session,
retrieve its workspace, and inject it into the scope context.

**How**:

1. Add `sessionID?: string` to `Pty.CreateInput` schema in `pty.ts`
2. In `packages/synergy/src/server/pty.ts`, before calling `Pty.create()`:
   ```ts
   const session = input.sessionID ? await Session.get(input.sessionID) : undefined
   const workspace = session?.workspace
   return ScopeContext.provide({ scope, workspace, fn: () => Pty.create(input) })
   ```
3. `ScopeContext.current.directory` will then return `ws?.path` for worktree sessions
4. Frontend passes `sessionID`

**Files changed**:

- `packages/synergy/src/process/pty.ts` (schema — add `sessionID`)
- `packages/synergy/src/server/pty.ts` (handler — resolve session workspace)
- `packages/app/src/context/terminal.tsx` (pass sessionID)
- `packages/sdk/js/src/gen/` (regenerate SDK if schema changes)

**Pros**:

- Clean separation: server owns the logic
- Works for any client (API, SDK, Web UI)
- Explicit session binding

**Cons**:

- More files, more risk, SDK regeneration needed
- Over-engineering for a P3 enhancement that frontend can handle

**Effort**: Medium (~4 files, ~40 lines)

---

### Approach C: User-configurable terminal CWD preference (Future extension)

Add a terminal CWD preference in settings:

- "Use scope default" (current)
- "Use worktree directory" (when in a worktree session)

This can be layered on top of Approach A/B later.

**Effort**: Large (~5 files, ~100 lines + new UI)

---

## Recommendation

**Adopt the frontend approach** (updated Approach A) — resolve CWD from `session.workspace` in
the terminal context, using the same `globalSync` pattern the status bar already uses.

1. Single file change in `packages/app/src/context/terminal.tsx`
2. Zero server-side risk
3. Reuses the battle-tested `session.workspace` tracking from `workspace-transition.ts` + `global-sync.tsx`
4. Lazy getter ensures workspace changes (`worktree_enter` in the same session) are immediately reflected
5. Backward compatible — no CWD means server default

### Implementation plan:

```
packages/app/src/context/terminal.tsx:
  1. Import useGlobalSync
  2. In init(): call useGlobalSync(), define getWorkspaceCwd() getter
  3. Pass getWorkspaceCwd to createTerminalSession
  4. In new(): call getWorkspaceCwd() and pass cwd to pty.create()

Behavior matrix:
  | Scenario                                | CWD                          |
  |-----------------------------------------|------------------------------|
  | No active session (params.id undefined) | Server default (scope root)  |
  | Session in main scope (type="main")     | Server default (scope root)  |
  | Session in git_worktree                 | worktree path                |
  | Explicit cwd passed to pty.create()     | explicit cwd (no change)     |
```
