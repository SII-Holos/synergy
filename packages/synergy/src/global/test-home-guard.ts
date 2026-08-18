import os from "os"
import path from "path"

/**
 * Guards against test processes resolving the Synergy home into the real user
 * home. Bun 1.3.x does not propagate `test/preload.ts` environment variables
 * (SYNERGY_TEST_HOME / SYNERGY_TEST_ROOT) into `--parallel` worker processes,
 * so a parallel test run against a source checkout falls through to
 * `os.homedir()` and writes fixtures into the real `~/.synergy` data.
 *
 * The guard blocks any test-entry process whose Synergy root is the real
 * `~/.synergy` root or any path inside it, including `SYNERGY_HOME` pointed at
 * the real config directory (which would resolve to `~/.synergy/.synergy`).
 *
 * The guard is deliberately pure: it performs no filesystem side effects, so
 * a violated check aborts module init in `src/global/index.ts` before any
 * directory creation. It imports only node builtins to keep that guarantee.
 */

const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx|cjs|mjs)$/

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
      `Refusing to run a test process with the Synergy home resolving into the real ~/.synergy tree${entry}. ` +
        "Bun does not propagate test/preload.ts environment into --parallel workers, so this run would " +
        "write test fixtures into ~/.synergy/data. " +
        "The package orchestrators (bun run test:ci / bun run test:coverage) set SYNERGY_TEST_HOME; " +
        "run the suite through them, set SYNERGY_HOME to a dedicated test home, " +
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
  const realHomeRoot = path.resolve(path.join(os.homedir(), ".synergy"))
  const resolvedRoot = path.resolve(root)
  const insideRealHome = resolvedRoot === realHomeRoot || resolvedRoot.startsWith(realHomeRoot + path.sep)
  if (!insideRealHome) return
  throw new TestHomeGuardError(entryPath)
}
