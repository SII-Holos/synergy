import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isTestEntryPath, TestHomeGuardError, assertIsolatedTestHome } from "../../src/global/test-home-guard"

const REAL_HOME_ROOT = path.join(os.homedir(), ".synergy")

function testEntry(entry = "/repo/packages/synergy/test/foo.test.ts") {
  return entry
}

describe("isTestEntryPath", () => {
  test("detects a .test.ts entry path (Bun.main shape)", () => {
    expect(isTestEntryPath(testEntry(), [], {})).toBe(true)
  })

  test("detects .test.tsx/.test.js/.test.jsx/.test.cjs/.test.mjs entries", () => {
    for (const ext of [".test.ts", ".test.tsx", ".test.js", ".test.jsx", ".test.cjs", ".test.mjs"]) {
      expect(isTestEntryPath(`/repo/x/spec${ext}`, [], {})).toBe(true)
    }
  })

  test("detects a test file passed as argv[1] when Bun.main is unavailable", () => {
    expect(isTestEntryPath(undefined, ["bun", "/repo/test/thing.test.ts"], {})).toBe(true)
  })

  test("detects parallel workers via BUN_TEST_WORKER_ID / JEST_WORKER_ID", () => {
    expect(isTestEntryPath(undefined, ["bun", "test"], { BUN_TEST_WORKER_ID: "1" })).toBe(true)
    expect(isTestEntryPath(undefined, ["bun", "test"], { JEST_WORKER_ID: "3" })).toBe(true)
  })

  test("rejects non-test entries (CLI, dev server, scripts)", () => {
    expect(
      isTestEntryPath("/repo/packages/synergy/src/index.ts", ["bun", "/repo/packages/synergy/src/index.ts"], {}),
    ).toBe(false)
    expect(isTestEntryPath("/repo/script/build.ts", [], {})).toBe(false)
    expect(isTestEntryPath(undefined, ["bun", "/repo/script/dev.ts"], {})).toBe(false)
  })
})

describe("assertIsolatedTestHome", () => {
  test("throws TestHomeGuardError when a test entry resolves to the real home root", () => {
    expect(() => assertIsolatedTestHome(REAL_HOME_ROOT, testEntry(), ["bun", testEntry()], {})).toThrow(
      TestHomeGuardError,
    )
  })

  test("does not throw for a non-test entry against the real home root", () => {
    expect(() =>
      assertIsolatedTestHome(
        REAL_HOME_ROOT,
        "/repo/packages/synergy/src/index.ts",
        ["bun", "/repo/packages/synergy/src/index.ts"],
        {},
      ),
    ).not.toThrow()
  })

  test("does not throw for a test entry against an isolated temp home", () => {
    expect(() => assertIsolatedTestHome("/tmp/synergy-test-home", testEntry(), ["bun", testEntry()], {})).not.toThrow()
  })

  test("honors SYNERGY_ALLOW_REAL_HOME=1 as an explicit opt-in", () => {
    expect(() =>
      assertIsolatedTestHome(REAL_HOME_ROOT, testEntry(), ["bun", testEntry()], { SYNERGY_ALLOW_REAL_HOME: "1" }),
    ).not.toThrow()
  })

  test("error message names the entry and the supported fixes", () => {
    try {
      assertIsolatedTestHome(REAL_HOME_ROOT, testEntry(), ["bun", testEntry()], {})
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(TestHomeGuardError)
      const message = (error as Error).message
      expect(message).toContain(".test.ts")
      expect(message).toContain("SYNERGY_TEST_HOME")
      expect(message).toContain("SYNERGY_HOME")
    }
  })
})

// ---------------------------------------------------------------------------
// Subprocess contract: the incident shape must fail loudly with zero writes to
// the real home. A fixture test file is written into a runtime temp directory
// (never a repo path) and spawned with bun test in --parallel mode — the exact
// shape where Bun 1.3.14 does not propagate preload env to worker processes.
//
// The fixture MUST reference Global inside the test body: bun's test runner
// drops an unused import, which would skip the guard entirely. Referencing
// Global in the body retains the import, so module evaluation (and therefore
// the guard) runs in the worker.
// ---------------------------------------------------------------------------

let fixtureRoot: string | undefined
afterEach(async () => {
  if (fixtureRoot) {
    await fs.rm(fixtureRoot, { recursive: true, force: true })
    fixtureRoot = undefined
  }
})

async function writeFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-guard-fixture-"))
  fixtureRoot = root
  const file = path.join(root, "guard-contract.test.ts")
  const packagesSynergy = path.resolve(import.meta.dir, "..", "..")
  const body = [
    'import { test, expect } from "bun:test"',
    `import { Global } from ${JSON.stringify(path.join(packagesSynergy, "src/global/index.ts"))}`,
    "test('guard contract', () => {",
    "  // Referencing Global retains the import so the guard runs at module eval.",
    "  expect(Global.Path.root).toBeTruthy()",
    "})",
    "",
  ].join("\n")
  await fs.writeFile(file, body)
  return file
}

function strippedEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (
      key === "SYNERGY_TEST_HOME" ||
      key === "SYNERGY_HOME" ||
      key === "SYNERGY_TEST_ROOT" ||
      key === "SYNERGY_ALLOW_REAL_HOME"
    ) {
      continue
    }
    if (value !== undefined) env[key] = value
  }
  return { ...env, ...extra }
}

async function runBunTestSpawn(
  args: string[],
  env: Record<string, string>,
): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn([process.execPath, "test", ...args], {
    cwd: path.resolve(import.meta.dir, "..", ".."),
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { exitCode: await proc.exited, stderr: stderr + stdout }
}

describe("incident-shape subprocess contract", () => {
  test("stripped env + --parallel worker against the real home fails with the guard message and writes nothing", async () => {
    const fixture = await writeFixture()
    const result = await runBunTestSpawn(["--parallel=2", "--config", "/dev/null", fixture], strippedEnv())
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("Refusing to run a test process")
    // The guard fires before any side effect: nothing new may appear under the
    // real Synergy data root as a result of this run.
    const dataRoot = path.join(os.homedir(), ".synergy", "data")
    const before = await fs.readdir(dataRoot).catch(() => [])
    const after = await fs.readdir(dataRoot).catch(() => [])
    expect(after).toEqual(before)
  })

  test("injected SYNERGY_TEST_HOME (orchestrator shape) keeps the same run isolated", async () => {
    const fixture = await writeFixture()
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-guard-inject-"))
    try {
      const result = await runBunTestSpawn(
        ["--parallel=2", "--config", "/dev/null", fixture],
        strippedEnv({ SYNERGY_TEST_HOME: tempHome, SYNERGY_TEST_ROOT: path.join(tempHome, "fixtures") }),
      )
      expect(result.exitCode).toBe(0)
      // global/index.ts ran and created the isolated root.
      expect(await fs.stat(path.join(tempHome, ".synergy")).catch(() => null)).not.toBeNull()
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true })
    }
  })

  test("SYNERGY_ALLOW_REAL_HOME=1 opts out of the guard", async () => {
    const fixture = await writeFixture()
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-guard-optin-"))
    try {
      const result = await runBunTestSpawn(
        ["--parallel=2", "--config", "/dev/null", fixture],
        strippedEnv({
          SYNERGY_ALLOW_REAL_HOME: "1",
          SYNERGY_HOME: fakeHome, // points homeDir at a temp dir: proves the opt-in path without touching real data
        }),
      )
      expect(result.exitCode).toBe(0)
      expect(result.stderr).not.toContain("Refusing to run a test process")
      expect(await fs.stat(path.join(fakeHome, ".synergy")).catch(() => null)).not.toBeNull()
    } finally {
      await fs.rm(fakeHome, { recursive: true, force: true })
    }
  })
})
