import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  applyDesktopZoomToWindow,
  defaultDesktopZoomState,
  desktopZoomFilePath,
  loadDesktopZoom,
  parseDesktopZoomFactor,
  saveDesktopZoom,
} from "../src/zoom-state.js"

async function withTempUserData<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synergy-desktop-zoom-"))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("desktop zoom", () => {
  test("falls back to the default zoom factor when state is missing or invalid", async () => {
    await withTempUserData(async (dir) => {
      expect(await loadDesktopZoom(dir)).toEqual(defaultDesktopZoomState())
      await writeFile(desktopZoomFilePath(dir), "not json", "utf8")
      expect(await loadDesktopZoom(dir)).toEqual(defaultDesktopZoomState())
      await writeFile(desktopZoomFilePath(dir), JSON.stringify({ version: 1, zoomFactor: 9 }), "utf8")
      expect(await loadDesktopZoom(dir)).toEqual(defaultDesktopZoomState())
      await writeFile(desktopZoomFilePath(dir), JSON.stringify({ version: 2, zoomFactor: 1.25 }), "utf8")
      expect(await loadDesktopZoom(dir)).toEqual(defaultDesktopZoomState())
    })
  })

  test("persists and reloads a validated zoom factor", async () => {
    await withTempUserData(async (dir) => {
      await saveDesktopZoom(dir, { version: 1, zoomFactor: 1.25 })
      expect(await loadDesktopZoom(dir)).toEqual({ version: 1, zoomFactor: 1.25 })
      expect(JSON.parse(await Bun.file(desktopZoomFilePath(dir)).text())).toEqual({ version: 1, zoomFactor: 1.25 })
    })
  })

  test("accepts zoom factors in the supported range and rejects out-of-range input", () => {
    expect(parseDesktopZoomFactor(1)).toBe(1)
    expect(parseDesktopZoomFactor(1.75)).toBe(1.75)
    expect(parseDesktopZoomFactor(0.5)).toBe(0.5)
    expect(parseDesktopZoomFactor(2)).toBe(2)
    expect(() => parseDesktopZoomFactor(0.25)).toThrow()
    expect(() => parseDesktopZoomFactor(2.5)).toThrow()
    expect(() => parseDesktopZoomFactor("large")).toThrow()
  })

  test("applies the zoom factor to the main window webContents", () => {
    const setZoomFactor = (factor: number) => setZoomFactor.calls.push(factor)
    setZoomFactor.calls = [] as number[]
    const window = {
      isDestroyed: () => false,
      webContents: { setZoomFactor },
    }
    applyDesktopZoomToWindow(window, { version: 1, zoomFactor: 1.5 })
    expect(setZoomFactor.calls).toEqual([1.5])
  })

  test("skips destroyed windows", () => {
    let calls = 0
    const window = {
      isDestroyed: () => true,
      webContents: {
        setZoomFactor: () => {
          calls += 1
        },
      },
    }
    applyDesktopZoomToWindow(window, { version: 1, zoomFactor: 1.5 })
    expect(calls).toBe(0)
  })
})
