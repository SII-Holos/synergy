import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"

/**
 * Isolation environment for spawn-based core test orchestrators.
 *
 * Bun 1.3.x does not propagate `test/preload.ts` environment (SYNERGY_TEST_HOME
 * / SYNERGY_TEST_ROOT) into `--parallel` worker processes, so a spawned
 * coverage/CI run can fall through to the real user home. Injecting the
 * variables at spawn time fixes that: every child (and its workers) inherits
 * an isolated home, whether or not the preload runs in the child.
 *
 * The created root is disjoint from the per-process preload root
 * (synergy-test-data-*), so preload and orchestrator cleanup never collide.
 */
export async function createIsolatedTestEnv(): Promise<{
  env: Record<string, string | undefined>
  dispose: () => Promise<void>
}> {
  const root = path.join(os.tmpdir(), `synergy-orchestrated-${process.pid}-${crypto.randomBytes(4).toString("hex")}`)
  const home = path.join(root, "home")
  const fixtures = path.join(root, "fixtures")
  await fs.mkdir(home, { recursive: true })
  await fs.mkdir(fixtures, { recursive: true })

  const env: Record<string, string | undefined> = { ...process.env }
  delete env.SYNERGY_HOME
  env.SYNERGY_TEST_HOME = home
  env.SYNERGY_TEST_ROOT = fixtures
  // Deterministic locale: zh_CN `ps -o lstart` output breaks process-lock
  // identity parsing in suites that shell out (coverage-check.ts forces
  // LC_ALL=C for the same reason).
  env.LC_ALL = "C"
  // Bun 1.3.x fetch reads HTTP(S)_PROXY per request with no built-in loopback
  // bypass (oven-sh/bun#39352), so a proxied CI runner routes local
  // Bun.serve test-server requests through the proxy and fails them with
  // HTTP 404. Drop proxy variables for spawned children and pin NO_PROXY so
  // loopback fetches stay direct regardless of the host environment.
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) {
    delete env[key]
  }
  env.NO_PROXY = "localhost,127.0.0.1,[::1],0.0.0.0"
  env.no_proxy = env.NO_PROXY

  return {
    env,
    dispose: async () => {
      try {
        await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
      } catch (error) {
        // Recently exited test children can leave SQLite or other files
        // temporarily locked on Windows; match test/preload.ts cleanup
        // semantics so an otherwise passing run does not fail in dispose.
        if (process.platform === "win32" && isTransientCleanupError(error)) return
        throw error
      }
    },
  }
}

export function isTransientCleanupError(error: unknown) {
  const code = (error as { code?: unknown })?.code
  return code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY"
}
