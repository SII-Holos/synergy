import { describe, expect, test } from "bun:test"
import {
  computeStableVersion,
  npmTagMatches,
  npmVersionExists,
  waitForNpmVersion,
} from "../../../script/release/shared/runtime"
import { FIXED_REGISTRY_PACKAGES } from "../../../script/release/shared/packages"

describe("release npm registry waits", () => {
  test("allows a published package to become visible beyond the former polling cutoff", async () => {
    let calls = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(null, { status: ++calls > 60 ? 200 : 404 })) as typeof fetch
    try {
      expect(await waitForNpmVersion("@ericsanchezok/synergy-library", "3.1.0", { delay: 0 })).toBe(true)
      expect(calls).toBe(61)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("reports a package that remains unavailable when the polling budget expires", async () => {
    let calls = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      calls += 1
      return new Response(null, { status: 404 })
    }) as typeof fetch
    try {
      expect(await waitForNpmVersion("@ericsanchezok/synergy-library", "3.1.0", { attempts: 3, delay: 0 })).toBe(false)
      expect(calls).toBe(3)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("waits for a dist-tag to converge", async () => {
    let calls = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      calls += 1
      return Response.json({ next: calls === 1 ? "3.0.0" : "3.0.1" })
    }) as typeof fetch
    try {
      expect(await npmTagMatches("@ericsanchezok/synergy-sdk", "next", "3.0.1", { attempts: 2, delay: 1 })).toBe(true)
      expect(calls).toBe(2)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("bypasses stale registry caches between version probes", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input, init) => {
      requests.push({ url: String(input), init })
      return new Response(null, { status: requests.length === 1 ? 404 : 200 })
    }) as typeof fetch
    try {
      expect(await npmVersionExists("@ericsanchezok/synergy-plugin-kit", "3.0.2")).toBe(false)
      expect(await npmVersionExists("@ericsanchezok/synergy-plugin-kit", "3.0.2")).toBe(true)
      expect(requests).toHaveLength(2)
      expect(requests[0]?.url).not.toBe(requests[1]?.url)
      expect(new URL(requests[0]!.url).searchParams.has("cache-bust")).toBe(true)
      expect(requests[0]?.init?.cache).toBe("no-store")
      expect(new Headers(requests[0]?.init?.headers).get("cache-control")).toContain("no-cache")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("bumps after the highest published managed package version", async () => {
    const originalFetch = globalThis.fetch
    const requestedPackages = new Set<string>()
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input))
      const packageName = decodeURIComponent(url.pathname.slice(1))
      requestedPackages.add(packageName)
      const versions =
        packageName === "@ericsanchezok/synergy-plugin-kit"
          ? { "3.0.0": {}, "3.0.1": {}, "0.0.0-dev-20260724": {} }
          : { "3.0.0": {} }
      return Response.json({ versions })
    }) as typeof fetch
    try {
      expect(await computeStableVersion("patch")).toBe("3.0.2")
      expect(requestedPackages).toEqual(new Set(FIXED_REGISTRY_PACKAGES))
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("resumes only the highest partially published stable version without bumping it", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => Response.json({ versions: { "3.0.22": {}, "3.1.0": {} } })) as typeof fetch
    try {
      expect(await computeStableVersion("minor", "3.1.0")).toBe("3.1.0")
      await expect(computeStableVersion("minor", "3.0.22")).rejects.toThrow("highest published")
      await expect(computeStableVersion("minor", "3.2.0")).rejects.toThrow("not published")
      await expect(computeStableVersion("minor", "3.1.0-next")).rejects.toThrow("stable version")
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
