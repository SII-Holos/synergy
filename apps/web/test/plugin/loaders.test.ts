import { expect, test } from "bun:test"
import { createPluginExportLoader, isCompatibleUIVersion } from "../../src/plugin/loaders"

test("only well-formed UI API 5 versions are compatible", () => {
  expect(isCompatibleUIVersion("5.0", "5.0")).toBe(true)
  expect(isCompatibleUIVersion("5.1", "5.0")).toBe(true)
  for (const version of ["4.0", "", "5broken", "5", "5.0.extra"]) {
    expect(isCompatibleUIVersion(version, "5.0")).toBe(false)
  }
})

test("rejects an undeclared author version before fetching or importing code", async () => {
  await expect(
    createPluginExportLoader().load("legacy", "data:text/javascript,export default null", "Panel", undefined),
  ).rejects.toThrow("requires UI API 4.0")
})

test("shares a bundle between exports and repeated mounts within its owner", async () => {
  let requests = 0
  const loader = createPluginExportLoader(async ({ url }) => {
    requests++
    return import(url)
  })
  const url = "data:text/javascript,export const Panel = 'panel'; export const Settings = 'settings'"
  const hash = "a".repeat(64)
  try {
    const values = await Promise.all([
      loader.load("sample", url, "Panel", "5.0", hash),
      loader.load("sample", url, "Settings", "5.0", hash),
      loader.load("sample", url, "Panel", "5.0", hash),
    ])
    expect(values.map((value) => value.default)).toEqual(["panel", "settings", "panel"])
    expect(requests).toBe(1)
    await expect(loader.load("sample", url, "Absent", "5.0", hash)).rejects.toThrow("Export")
    expect((await loader.load("sample", url, "Panel", "5.0", hash)).default).toBe("panel")
    await expect(loader.load("sample", url, "Panel", "4.0", hash)).rejects.toThrow("requires UI API 4.0")
    loader.dispose()
    await expect(loader.load("sample", url, "Panel", "5.0", hash)).rejects.toThrow("disposed")
    expect(requests).toBe(1)
  } finally {
    loader.dispose()
  }
})

test("failed preparations are retryable and cannot complete after owner disposal", async () => {
  let attempts = 0
  const pending = Promise.withResolvers<Record<string, unknown>>()
  const loader = createPluginExportLoader(async () => {
    attempts++
    if (attempts === 1) throw new Error("HTTP 503")
    if (attempts === 2) return { Retry: "ready" }
    return pending.promise
  })
  const hash = "a".repeat(64)
  await expect(loader.load("retry", "/bundle.js", "Retry", "5.0", hash)).rejects.toThrow("HTTP 503")
  expect((await loader.load("retry", "/bundle.js", "Retry", "5.0", hash)).default).toBe("ready")
  const old = loader.load("retry", "/next.js", "Retry", "5.0", hash)
  loader.dispose()
  pending.resolve({ Retry: "late" })
  await expect(old).rejects.toThrow("disposed")
  expect(attempts).toBe(3)
})
