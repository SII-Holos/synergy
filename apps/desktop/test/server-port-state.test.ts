import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { desktopServerPortFilePath, loadServerPort, saveServerPort } from "../src/server-port-state.js"

async function withTempUserData<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synergy-desktop-server-port-"))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("desktop server port state", () => {
  test("returns undefined when the state file is missing or unreadable", async () => {
    await withTempUserData(async (dir) => {
      expect(await loadServerPort(dir, "stable")).toBeUndefined()
      await writeFile(desktopServerPortFilePath(dir), "not json", "utf8")
      expect(await loadServerPort(dir, "stable")).toBeUndefined()
    })
  })

  test("ignores state owned by another channel", async () => {
    await withTempUserData(async (dir) => {
      await saveServerPort(dir, "dev", 4097)
      expect(await loadServerPort(dir, "dev")).toBe(4097)
      expect(await loadServerPort(dir, "stable")).toBeUndefined()
    })
  })

  test("ignores out-of-range ports and unknown schema shapes", async () => {
    await withTempUserData(async (dir) => {
      const filepath = desktopServerPortFilePath(dir)
      for (const state of [
        { version: 1, channel: "stable", port: 80, updatedAt: "2026-09-18T00:00:00.000Z" },
        { version: 1, channel: "stable", port: 70_000, updatedAt: "2026-09-18T00:00:00.000Z" },
        { version: 2, channel: "stable", port: 4096, updatedAt: "2026-09-18T00:00:00.000Z" },
        { version: 1, channel: "stable", port: 4096 },
        { version: 1, channel: "preview", port: 4096, updatedAt: "2026-09-18T00:00:00.000Z" },
      ]) {
        await writeFile(filepath, JSON.stringify(state), "utf8")
        expect(await loadServerPort(dir, "stable")).toBeUndefined()
      }
    })
  })

  test("persists the channel-scoped port with a version and timestamp", async () => {
    await withTempUserData(async (dir) => {
      await saveServerPort(dir, "dev", 4098)
      const stored = JSON.parse(await readFile(desktopServerPortFilePath(dir), "utf8"))
      expect(stored).toMatchObject({ version: 1, channel: "dev", port: 4098 })
      expect(Number.isNaN(Date.parse(stored.updatedAt))).toBe(false)
      expect(await loadServerPort(dir, "dev")).toBe(4098)
    })
  })
})
