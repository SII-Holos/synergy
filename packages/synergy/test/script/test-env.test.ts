import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { createIsolatedTestEnv, isTransientCleanupError } from "../../script/test-env"

describe("createIsolatedTestEnv", () => {
  test("injects SYNERGY_TEST_HOME and SYNERGY_TEST_ROOT, deletes SYNERGY_HOME, forces LC_ALL=C", async () => {
    const isolated = await createIsolatedTestEnv()
    try {
      expect(isolated.env["SYNERGY_TEST_HOME"]).toBeTruthy()
      expect(isolated.env["SYNERGY_TEST_ROOT"]).toBeTruthy()
      expect("SYNERGY_HOME" in isolated.env).toBe(false)
      expect(isolated.env["SYNERGY_HOME"]).toBeUndefined()
      // Deterministic locale so process-lock suites that shell out to `ps`
      // parse start times identically regardless of the host locale.
      expect(isolated.env["LC_ALL"]).toBe("C")
      // The two roots must be disjoint from the per-process preload root.
      expect(isolated.env["SYNERGY_TEST_HOME"]).toContain("synergy-orchestrated-")
    } finally {
      await isolated.dispose()
    }
  })

  test("neutralizes proxy env vars so local Bun.serve fetches bypass CI proxies", async () => {
    // Bun 1.3.x fetch reads HTTP(S)_PROXY per request with no built-in
    // loopback bypass (oven-sh/bun#39352); a proxied CI runner routes local
    // test-server requests through the proxy and fails them with HTTP 404.
    const proxiedEnv = {
      ...process.env,
      HTTP_PROXY: "http://proxy.internal:8080",
      HTTPS_PROXY: "http://proxy.internal:8080",
      http_proxy: "http://proxy.internal:8080",
      https_proxy: "http://proxy.internal:8080",
    }
    const original = { ...process.env }
    process.env = { ...proxiedEnv } as NodeJS.ProcessEnv
    try {
      const isolated = await createIsolatedTestEnv()
      try {
        for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) {
          expect(isolated.env[key]).toBeUndefined()
        }
        expect(isolated.env["NO_PROXY"]).toContain("127.0.0.1")
        expect(isolated.env["no_proxy"]).toContain("localhost")
      } finally {
        await isolated.dispose()
      }
    } finally {
      process.env = original
    }
  })

  test("dispose removes the created root", async () => {
    const isolated = await createIsolatedTestEnv()
    const root = isolated.env["SYNERGY_TEST_HOME"]!
    expect(await fs.stat(pathOf(root)).catch(() => null)).not.toBeNull()
    await isolated.dispose()
    expect(await fs.stat(pathOf(root)).catch(() => null)).toBeNull()
  })
})

function pathOf(value: string) {
  // SYNERGY_TEST_HOME is <root>/home; the created root is its parent.
  return value.replace(/\/home$/, "")
}

describe("isTransientCleanupError", () => {
  test("accepts the Windows transient lock codes", () => {
    for (const code of ["EBUSY", "EPERM", "ENOTEMPTY"]) {
      expect(isTransientCleanupError({ code })).toBe(true)
    }
  })

  test("rejects other codes and non-error values", () => {
    expect(isTransientCleanupError({ code: "EACCES" })).toBe(false)
    expect(isTransientCleanupError({ code: "ENOENT" })).toBe(false)
    expect(isTransientCleanupError(new Error("boom"))).toBe(false)
  })
})
