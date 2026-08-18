import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  isTestEntryPath,
  TestHomeGuardError,
  assertIsolatedTestHome,
  normalizeGuardPath,
} from "../../src/global/test-home-guard"

const REAL_HOME_ROOT = path.join(os.homedir(), ".synergy")

function testEntry(entry = "/repo/packages/synergy/test/foo.test.ts") {
  return entry
}

function marker(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { SYNERGY_TEST_HOME: "/tmp/synergy-test-home", ...extra }
}

describe("normalizeGuardPath", () => {
  test("lowercases paths on win32 for case-insensitive containment", () => {
    expect(normalizeGuardPath("C:\\Users\\Foo\\.SYNERGY\\Data", "win32")).toBe("c:\\users\\foo\\.synergy\\data")
    expect(normalizeGuardPath("C:\\Users\\Foo\\.synergy", "win32")).toBe("c:\\users\\foo\\.synergy")
  })

  test("leaves non-Windows paths unchanged", () => {
    expect(normalizeGuardPath("/Users/Foo/.synergy", "darwin")).toBe("/Users/Foo/.synergy")
    expect(normalizeGuardPath("/Users/Foo/.synergy", "linux")).toBe("/Users/Foo/.synergy")
  })
})

describe("isTestEntryPath", () => {
  test("detects a .test.ts entry path (Bun.main shape)", () => {
    expect(isTestEntryPath(testEntry(), [], {})).toBe(true)
  })

  test("detects .test.tsx/.test.js/.test.jsx/.test.cjs/.test.mjs entries", () => {
    for (const ext of [".test.ts", ".test.tsx", ".test.js", ".test.jsx", ".test.cjs", ".test.mjs"]) {
      expect(isTestEntryPath(`/repo/x/spec${ext}`, [], {})).toBe(true)
    }
  })

  test("detects .spec.* entries as test processes", () => {
    for (const ext of [".spec.ts", ".spec.tsx", ".spec.js", ".spec.jsx", ".spec.cjs", ".spec.mjs"]) {
      expect(isTestEntryPath(`/repo/x/thing${ext}`, [], {})).toBe(true)
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

  test("does not throw for a test entry with the isolation marker against an isolated temp home", () => {
    expect(() =>
      assertIsolatedTestHome("/tmp/synergy-test-home", testEntry(), ["bun", testEntry()], marker()),
    ).not.toThrow()
  })

  test("throws for a test entry without the isolation marker even outside the real root", () => {
    expect(() => assertIsolatedTestHome("/tmp/synergy-test-home", testEntry(), ["bun", testEntry()], {})).toThrow(
      TestHomeGuardError,
    )
  })

  test("throws when the root is the real config dir itself even with the marker (~/.synergy/.synergy)", () => {
    expect(() =>
      assertIsolatedTestHome(path.join(REAL_HOME_ROOT, ".synergy"), testEntry(), ["bun", testEntry()], marker()),
    ).toThrow(TestHomeGuardError)
  })

  test("throws for any root inside the real ~/.synergy tree even with the marker", () => {
    expect(() =>
      assertIsolatedTestHome(path.join(REAL_HOME_ROOT, "data"), testEntry(), ["bun", testEntry()], marker()),
    ).toThrow(TestHomeGuardError)
  })

  test("does not throw for a dedicated test home outside the real root with the marker", () => {
    expect(() =>
      assertIsolatedTestHome(
        path.join(os.homedir(), "synergy-test-home", ".synergy"),
        testEntry(),
        ["bun", testEntry()],
        marker(),
      ),
    ).not.toThrow()
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
      expect(message).toContain("SYNERGY_ALLOW_REAL_HOME")
    }
  })
})

// ---------------------------------------------------------------------------
// Subprocess contract: the incident shape must fail loudly with zero writes to
// any process home. A fixture test file is written into a runtime temp
// directory (never a repo path) and spawned with bun test in --parallel mode —
// the exact shape where Bun 1.3.14 does not propagate preload env to worker
// processes.
//
// Every child gets a TEMPORARY process home (HOME/USERPROFILE), so a guard
// regression can never touch the developer's real ~/.synergy: it can only
// create files under the throwaway home, which is snapshotted before spawn and
// asserted unchanged afterwards.
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
  test("stripped env + --parallel worker with a temp process home fails before creating anything", async () => {
    const fixture = await writeFixture()
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-guard-home-"))
    try {
      const synergyRoot = path.join(tempHome, ".synergy")
      // Snapshot before spawn: if the guard regresses, module init creates the
      // tree under the throwaway home and this assertion catches it.
      expect(await fs.stat(synergyRoot).catch(() => null)).toBeNull()
      const result = await runBunTestSpawn(
        ["--parallel=2", "--config", "/dev/null", fixture],
        strippedEnv({ HOME: tempHome, USERPROFILE: tempHome }),
      )
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("Refusing to run a test process")
      expect(await fs.stat(synergyRoot).catch(() => null)).toBeNull()
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true })
    }
  })

  test("marker present but root equals the process home's .synergy is still blocked", async () => {
    const fixture = await writeFixture()
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-guard-contain-"))
    try {
      const synergyRoot = path.join(tempHome, ".synergy")
      const result = await runBunTestSpawn(
        ["--parallel=2", "--config", "/dev/null", fixture],
        strippedEnv({ HOME: tempHome, USERPROFILE: tempHome, SYNERGY_TEST_HOME: tempHome }),
      )
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("Refusing to run a test process")
      expect(await fs.stat(synergyRoot).catch(() => null)).toBeNull()
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true })
    }
  })

  test("injected SYNERGY_TEST_HOME (orchestrator shape) keeps the same run isolated", async () => {
    const fixture = await writeFixture()
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-guard-inject-"))
    const procHome = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-guard-prochome-"))
    try {
      const result = await runBunTestSpawn(
        ["--parallel=2", "--config", "/dev/null", fixture],
        strippedEnv({
          HOME: procHome,
          USERPROFILE: procHome,
          SYNERGY_TEST_HOME: tempHome,
          SYNERGY_TEST_ROOT: path.join(tempHome, "fixtures"),
        }),
      )
      expect(result.exitCode).toBe(0)
      // global/index.ts ran and created the isolated root.
      expect(await fs.stat(path.join(tempHome, ".synergy")).catch(() => null)).not.toBeNull()
      // The process home must not receive a .synergy tree.
      expect(await fs.stat(path.join(procHome, ".synergy")).catch(() => null)).toBeNull()
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true })
      await fs.rm(procHome, { recursive: true, force: true })
    }
  })

  test("SYNERGY_ALLOW_REAL_HOME=1 opts out of the guard", async () => {
    const fixture = await writeFixture()
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-guard-optin-"))
    const procHome = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-guard-prochome2-"))
    try {
      const result = await runBunTestSpawn(
        ["--parallel=2", "--config", "/dev/null", fixture],
        strippedEnv({
          HOME: procHome,
          USERPROFILE: procHome,
          SYNERGY_ALLOW_REAL_HOME: "1",
          SYNERGY_HOME: fakeHome, // points homeDir at a temp dir: proves the opt-in path without touching real data
        }),
      )
      expect(result.exitCode).toBe(0)
      expect(result.stderr).not.toContain("Refusing to run a test process")
      expect(await fs.stat(path.join(fakeHome, ".synergy")).catch(() => null)).not.toBeNull()
    } finally {
      await fs.rm(fakeHome, { recursive: true, force: true })
      await fs.rm(procHome, { recursive: true, force: true })
    }
  })
})
