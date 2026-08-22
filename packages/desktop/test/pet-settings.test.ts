import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  defaultPetSettingsState,
  loadPetSettings,
  parsePetSettingsUpdate,
  petSettingsFilePath,
  savePetSettings,
} from "../src/pet-settings.js"

async function withTempUserData<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synergy-desktop-pet-"))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("pet settings", () => {
  test("falls back to defaults when state is missing or invalid", async () => {
    await withTempUserData(async (dir) => {
      expect(await loadPetSettings(dir)).toEqual(defaultPetSettingsState())
      await writeFile(petSettingsFilePath(dir), "not json", "utf8")
      expect(await loadPetSettings(dir)).toEqual(defaultPetSettingsState())
      await writeFile(
        petSettingsFilePath(dir),
        JSON.stringify({
          version: 1,
          enabled: true,
          spritePath: "",
          width: 0,
          height: 0,
          position: null,
          idleTimeoutMs: 1,
          frameMs: 1,
        }),
        "utf8",
      )
      expect(await loadPetSettings(dir)).toEqual(defaultPetSettingsState())
    })
  })

  test("persists and reloads validated settings", async () => {
    await withTempUserData(async (dir) => {
      const state = {
        version: 1 as const,
        enabled: true,
        spritePath: "/tmp/pet.png",
        width: 200,
        height: 180,
        position: { x: 100, y: 200 },
        idleTimeoutMs: 60_000,
        frameMs: 100,
      }
      await savePetSettings(dir, state)
      expect(await loadPetSettings(dir)).toEqual(state)
      expect(JSON.parse(await Bun.file(petSettingsFilePath(dir)).text())).toEqual(state)
    })
  })

  test("accepts full settings updates and rejects invalid shapes", () => {
    const valid = {
      version: 1,
      enabled: true,
      spritePath: "",
      width: 160,
      height: 140,
      position: null,
      idleTimeoutMs: 300_000,
      frameMs: 120,
    }
    expect(parsePetSettingsUpdate(valid)).toEqual(valid)
    expect(() => parsePetSettingsUpdate({ ...valid, width: 1000 })).toThrow()
    expect(() => parsePetSettingsUpdate({ ...valid, version: 2 })).toThrow()
  })
})
