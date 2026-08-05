/**
 * Terminal lifecycle helpers shared between the Terminal component and its
 * reconnect/cleanup paths. Kept side-effect free so tests exercise the exact
 * production code instead of a local reimplementation.
 */

/**
 * Idempotence guard for onCleanup. Solid can run cleanup multiple times when a
 * flush double-visits an unmounting subtree; the first call returns true and
 * every later call returns false, so resource teardown (dispose controller,
 * remove listeners, close websocket, dispose terminal) runs exactly once.
 */
export function createCleanupGuard(): () => boolean {
  let ran = false
  return () => {
    if (ran) return false
    ran = true
    return true
  }
}

/**
 * True when the PTY is confirmed gone so the panel may release the tab.
 *
 * The server serializes Storage.NotFoundError (GET /pty/{id} 404, see
 * packages/synergy/src/server/pty.ts + server.ts onError) as
 * `{ name: "NotFoundError", data: { message } }` and the generated SDK client
 * throws that JSON unchanged (throwOnError). Older paths surfaced an APIError
 * carrying `data.statusCode === 404`; both shapes mean the PTY no longer
 * exists, and only then may onGone close the tab (pty.remove).
 */
export function isPtyNotFoundError(error: unknown) {
  if (typeof error !== "object" || error === null) return false
  const candidate = error as { name?: string; data?: { statusCode?: number } }
  return candidate.name === "NotFoundError" || (candidate.name === "APIError" && candidate.data?.statusCode === 404)
}
