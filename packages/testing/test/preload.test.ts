import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createIsolatedTestEnv } from "../src/env"

const preload = path.resolve(import.meta.dir, "../src/preload.ts")

describe("environment preload", () => {
  test("isolates inherited product homes and seeds deterministic fixtures without core initialization", async () => {
    const isolated = await createIsolatedTestEnv()
    try {
      const root = isolated.env.SYNERGY_TEST_ROOT!
      const inheritedHome = path.join(root, "product-home")
      const resultFile = path.join(root, "result.json")
      const testFile = path.join(root, "preload-contract.test.ts")
      await Bun.write(
        testFile,
        `import { expect, test } from "bun:test"
import path from "node:path"
test("isolated environment", async () => {
  expect(process.env.SYNERGY_HOME).toBeUndefined()
  expect(process.env.OPENAI_API_KEY).toBeUndefined()
  expect(process.env.ANTHROPIC_API_KEY).toBeUndefined()
  expect(process.env.SYNERGY_DISABLE_MODELS_FETCH).toBe("true")
  expect(process.env.SYNERGY_DISABLE_DEFAULT_PLUGINS).toBe("true")
  expect(process.env.SYNERGY_DISABLE_LSP_DOWNLOAD).toBe("true")
  expect(process.env.SYNERGY_DISABLE_BUILTIN_MCP).toBe("true")
  expect(process.env.SYNERGY_DISABLE_FILEWATCHER).toBe("true")
  const home = process.env.SYNERGY_TEST_HOME!
  const fixtureRoot = process.env.SYNERGY_TEST_ROOT!
  expect(home).toBeTruthy()
  expect(fixtureRoot).toBeTruthy()
  expect(path.dirname(home)).toBe(path.dirname(fixtureRoot))
  const catalog = await Bun.file(process.env.MODELS_DEV_API_JSON!).json()
  expect(catalog.openai).toBeDefined()
  expect(catalog.anthropic).toBeDefined()
  expect(catalog.google).toBeDefined()
  expect(await Bun.file(path.join(home, ".synergy", "cache", "version")).text()).toBe("15")
  await Bun.write(process.env.TEST_RESULT_FILE!, JSON.stringify({ home, fixtureRoot }))
})`,
      )
      const child = Bun.spawn([process.execPath, "test", "--config", "/dev/null", "--preload", preload, testFile], {
        env: {
          ...isolated.env,
          SYNERGY_HOME: inheritedHome,
          OPENAI_API_KEY: "fixture-only",
          ANTHROPIC_API_KEY: "fixture-only",
          TEST_RESULT_FILE: resultFile,
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ exitCode, output: exitCode === 0 ? "" : stdout + stderr }).toEqual({ exitCode: 0, output: "" })
      const result = (await Bun.file(resultFile).json()) as { home: string; fixtureRoot: string }
      expect(await fs.stat(inheritedHome).catch(() => undefined)).toBeUndefined()
      expect(await fs.stat(result.home).catch(() => undefined)).toBeUndefined()
      expect(await fs.stat(result.fixtureRoot).catch(() => undefined)).toBeUndefined()
    } finally {
      await isolated.dispose()
    }
  })
})
