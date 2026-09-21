import { RuntimeContext } from "../lifecycle/context"
/**
 * Session-scoped sandbox path approvals.
 *
 * A sandbox denial is an execution-time boundary, so the path that was denied
 * is not known when the tool call is authorized — only when the OS sandbox
 * stops the running command. Approving it therefore cannot flow through the
 * gate's own evaluate() pass: the gate is rebuilt for every tool call, and the
 * wrapper's roots come from that rebuilt gate.
 *
 * This store carries the paths the user approved for the session into the next
 * tool call, where the resolver seeds them through
 * `EnforcementGate.registerApprovedPaths`, so a retry of the same command runs
 * with the approved path inside the sandbox roots. It is deliberately
 * in-memory and session-scoped, following `SmartAllow`/`PermissionRules`
 * session state: approval is per session, not durable policy.
 */

export namespace SandboxSessionApproval {
  export type PathAccess = "read" | "write"

  const UNSCOPED = "__unscoped__"
  const runtimeState = RuntimeContext.state(() => ({
    approvals: new Map<string, Map<string, PathAccess>>(),
  }))

  function state(sessionID?: string): Map<string, PathAccess> {
    const instanceState = runtimeState()

    const key = sessionID ?? UNSCOPED
    let existing = instanceState.approvals.get(key)
    if (!existing) {
      existing = new Map()
      instanceState.approvals.set(key, existing)
    }
    return existing
  }

  export function remember(sessionID: string | undefined, path: string, access: PathAccess): void {
    state(sessionID).set(path, access)
  }

  export function has(sessionID: string | undefined, path: string): boolean {
    return state(sessionID).has(path)
  }

  export function accessFor(sessionID: string | undefined, path: string): PathAccess | undefined {
    return state(sessionID).get(path)
  }

  /** Paths approved for reading — either a read approval or a write approval. */
  export function readPaths(sessionID?: string): string[] {
    return [...state(sessionID).keys()]
  }

  /** Paths approved for writing. A write approval also permits reading. */
  export function writePaths(sessionID?: string): string[] {
    return [...state(sessionID).entries()].filter(([, access]) => access === "write").map(([path]) => path)
  }

  export function clear(sessionID?: string): void {
    const instanceState = runtimeState()

    if (sessionID) {
      instanceState.approvals.delete(sessionID)
      return
    }
    instanceState.approvals.clear()
  }
}
