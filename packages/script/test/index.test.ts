import { describe, expect, test } from "bun:test"

// One module evaluation per process: pin the environment BEFORE importing so
// the module's top-level awaits run deterministically with no network access.
// SYNERGY_BUMP drives the "latest" channel; a failing registry fetch exercises
// the 0.1.0 fallback and the bump arithmetic.
process.env.SYNERGY_BUMP = "minor"
delete process.env.SYNERGY_VERSION
delete process.env.SYNERGY_CHANNEL
const registryFetch = (async () => ({ ok: false, statusText: "unavailable" })) as unknown as typeof fetch
globalThis.fetch = registryFetch

const { Script } = await import("../src/index.ts")

describe("Script identity derivation", () => {
  test("derives the latest channel from a bump input", () => {
    expect(Script.channel).toBe("latest")
    expect(Script.preview).toBe(false)
  })

  test("falls back to 0.1.0 and applies the minor bump when the registry is unreachable", () => {
    expect(Script.version).toBe("0.2.0")
  })
})

describe("Script.npmVersionExists", () => {
  test("reports true when the registry knows the version", async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch
    try {
      expect(await Script.npmVersionExists("pkg", "1.0.0")).toBe(true)
    } finally {
      globalThis.fetch = original
    }
  })

  test("reports false when the registry returns 404", async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch
    try {
      expect(await Script.npmVersionExists("pkg", "1.0.0")).toBe(false)
    } finally {
      globalThis.fetch = original
    }
  })
})

describe("Script.retry", () => {
  test("retries a transient failure and returns the eventual value", async () => {
    let calls = 0
    const value = await Script.retry(
      async () => {
        calls++
        if (calls < 2) throw new Error("boom")
        return "ok"
      },
      { attempts: 3, delay: 1 },
    )
    expect(value).toBe("ok")
    expect(calls).toBe(2)
  })

  test("rethrows the last failure when attempts are exhausted", async () => {
    await expect(
      Script.retry(
        async () => {
          throw new Error("boom")
        },
        { attempts: 2, delay: 1 },
      ),
    ).rejects.toThrow("boom")
  })
})
