import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { electronMockState, registerElectronMock } from "./electron-mock"

registerElectronMock()

const { loadWindowState, scheduleWindowStatePersistence } = await import("../src/window-state.js")

let fixtureDir: string

async function fixture() {
  const dir = await mkdtemp(path.join(import.meta.dir, ".window-state-"))
  return dir
}

afterEach(async () => {
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true })
})

describe("desktop window state", () => {
  test("returns default bounds when no state file exists", async () => {
    fixtureDir = await fixture()
    expect(await loadWindowState(fixtureDir)).toEqual({ width: 1440, height: 920 })
  })

  test("restores normalized persisted bounds", async () => {
    fixtureDir = await fixture()
    await writeFile(
      path.join(fixtureDir, "window-state.json"),
      JSON.stringify({ width: 800, height: 600, x: 120.6, y: 40.2, maximized: true }),
    )
    expect(await loadWindowState(fixtureDir)).toEqual({ width: 800, height: 600, x: 121, y: 40, maximized: true })
  })

  test("falls back to defaults for corrupt or invalid state", async () => {
    fixtureDir = await fixture()
    await writeFile(path.join(fixtureDir, "window-state.json"), "{not json")
    expect(await loadWindowState(fixtureDir)).toEqual({ width: 1440, height: 920 })

    await writeFile(
      path.join(fixtureDir, "window-state.json"),
      JSON.stringify({ width: -10, height: 0, x: "left", y: Infinity, maximized: "yes" }),
    )
    expect(await loadWindowState(fixtureDir)).toEqual({ width: 1440, height: 920, maximized: false })
  })

  test("rejects a restored position that is visible on no display", async () => {
    fixtureDir = await fixture()
    electronMockState.displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }]
    await writeFile(
      path.join(fixtureDir, "window-state.json"),
      JSON.stringify({ width: 800, height: 600, x: 9000, y: 9000 }),
    )
    expect(await loadWindowState(fixtureDir)).toEqual({ width: 1440, height: 920 })
  })

  test("persists bounds, maximized state, and close snapshots with debounce", async () => {
    fixtureDir = await fixture()
    const listeners = new Map<string, Array<() => void>>()
    const window = {
      destroyed: false,
      maximized: false,
      bounds: { x: 10, y: 20, width: 800, height: 600 },
      on(event: string, listener: () => void) {
        const current = listeners.get(event) ?? []
        current.push(listener)
        listeners.set(event, current)
      },
      isDestroyed() {
        return this.destroyed
      },
      getNormalBounds() {
        return this.bounds
      },
      isMaximized() {
        return this.maximized
      },
      emit(event: string) {
        for (const listener of listeners.get(event) ?? []) listener()
      },
    }

    scheduleWindowStatePersistence(window as never, fixtureDir)
    window.bounds = { x: 30, y: 40, width: 1000, height: 700 }
    window.maximized = true
    window.emit("resize")
    window.emit("move")
    window.emit("maximize")

    await Bun.sleep(350)
    const saved = JSON.parse(await readFile(path.join(fixtureDir, "window-state.json"), "utf8"))
    expect(saved).toEqual({ x: 30, y: 40, width: 1000, height: 700, maximized: true })

    // The close handler persists immediately instead of waiting for the timer.
    window.bounds = { x: 50, y: 60, width: 1200, height: 800 }
    window.maximized = false
    window.emit("close")
    await Bun.sleep(20)
    const closed = JSON.parse(await readFile(path.join(fixtureDir, "window-state.json"), "utf8"))
    expect(closed).toEqual({ x: 50, y: 60, width: 1200, height: 800, maximized: false })
  })

  test("skips persistence for a destroyed window", async () => {
    fixtureDir = await fixture()
    const window = {
      destroyed: true,
      on() {},
      isDestroyed() {
        return true
      },
    }
    scheduleWindowStatePersistence(window as never, fixtureDir)
    await Bun.sleep(50)
    expect(await Bun.file(path.join(fixtureDir, "window-state.json")).exists()).toBe(false)
  })
})
