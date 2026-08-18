import os from "os"
import path from "path"

/**
 * Guards against test processes resolving the Synergy home into the real user
 * home. Bun 1.3.x does not propagate `test/preload.ts` environment variables
 * (SYNERGY_TEST_HOME / SYNERGY_TEST_ROOT) into `--parallel` worker processes,
 * so a parallel test run against a source checkout falls through to
 * `os.homedir()` and writes fixtures into the real `~/.synergy` data.
 *
 * The guard blocks any test-entry process that lacks an explicit positive
 * isolation marker (`SYNERGY_TEST_HOME`), and any such process whose root is
 * the real `~/.synergy` tree even when the marker is present (a
 * `SYNERGY_HOME` pointing at the real config directory resolves to
 * `~/.synergy/.synergy`). A relocated real instance with a custom
 * `SYNERGY_HOME` outside the user directory is indistinguishable from a
 * disposable test directory by pathname alone, so an arbitrary non-default
 * root is never treated as safe on its own.
 *
 * The guard is deliberately pure: it performs no filesystem side effects, so
 * a violated check aborts module init in `src/global/index.ts` before any
 * directory creation. It imports only node builtins to keep that guarantee.
 */

const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx|cjs|mjs)$/

/**
 * Windows paths are case-insensitive (drive letters and directory casing), so
 * containment comparisons must be normalized before comparing. Non-Windows
 * paths are returned unchanged.
 */
export function normalizeGuardPath(p: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? p.toLowerCase() : p
}

export function isTestEntryPath(
  entryPath: string | undefined,
  argv: string[],
  env: Record<string, string | undefined>,
): boolean {
  if (env.BUN_TEST_WORKER_ID !== undefined || env.JEST_WORKER_ID !== undefined) return true
  const candidate = entryPath ?? argv[1]
  if (!candidate) return false
  const base = path.basename(candidate.replace(/\\/g, "/"))
  return TEST_FILE_RE.test(base)
}

export class TestHomeGuardError extends Error {
  constructor(entryPath: string | undefined) {
    const entry = entryPath ? ` (entry: ${entryPath})` : ""
    super(
      `Refusing to run a test process without an isolated test home${entry}. ` +
        "Bun does not propagate test/preload.ts environment into --parallel workers, so this run would " +
        "write test fixtures into the active Synergy home. " +
        "The package orchestrators (bun run test:ci / bun run test:coverage) set SYNERGY_TEST_HOME; " +
        "run the suite through them, set SYNERGY_TEST_HOME to a dedicated test home, " +
        "or explicitly opt in with SYNERGY_ALLOW_REAL_HOME=1.",
    )
    this.name = "TestHomeGuardError"
  }
}

export function assertIsolatedTestHome(
  root: string,
  entryPath: string | undefined,
  argv: string[],
  env: Record<string, string | undefined>,
): void {
  if (env.SYNERGY_ALLOW_REAL_HOME === "1") return
  if (!isTestEntryPath(entryPath, argv, env)) return
  const realHomeRoot = normalizeGuardPath(path.resolve(path.join(os.homedir(), ".synergy")))
  const resolvedRoot = normalizeGuardPath(path.resolve(root))
  const insideRealHome = resolvedRoot === realHomeRoot || resolvedRoot.startsWith(realHomeRoot + path.sep)
  // Positive isolation marker: the orchestrators and preload both set
  // SYNERGY_TEST_HOME. Without it, any non-default root could be a relocated
  // real instance, so it is never treated as safe.
  if (env.SYNERGY_TEST_HOME !== undefined && !insideRealHome) return
  throw new TestHomeGuardError(entryPath)
}
