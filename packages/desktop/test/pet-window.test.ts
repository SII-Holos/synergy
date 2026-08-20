import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { MockElectronWindow, electronMockState, registerElectronMock } from "./electron-mock"

const windows: MockElectronWindow[] = []

registerElectronMock()
electronMockState.windowBuilder = (options) => {
  const window = new MockElectronWindow(options as Record<string, unknown>)
  windows.push(window)
  return window
}

const { DesktopPetWindow } = await import("../src/pet-window.js?real")

interface SseConnection {
  url: string
  abort: AbortController
  emit(payload: Record<string, unknown>): void
}

const sseConnections: SseConnection[] = []

function installFetchMock() {
  // @ts-expect-error overriding global fetch for the test
  globalThis.fetch = async (url: string | URL, init?: { signal?: AbortSignal }) => {
    const abortController = new AbortController()
    if (init?.signal) {
      init.signal.addEventListener("abort", () => abortController.abort())
    }
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        sseConnections.push({
          url: String(url),
          abort: abortController,
          emit(payload) {
            const line = `data: ${JSON.stringify(payload)}\n\n`
            streamController.enqueue(new TextEncoder().encode(line))
          },
        })
      },
      cancel() {
        abortController.abort()
      },
    })
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    })
  }
}

async function withTempUserData<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synergy-desktop-petwin-"))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

beforeEach(() => {
  windows.length = 0
  sseConnections.length = 0
  electronMockState.displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }]
  installFetchMock()
})

afterEach(() => {
  // @ts-expect-error restoring global fetch
  delete globalThis.fetch
})

describe("desktop pet window", () => {
  test("creates a transparent always-on-top skip-taskbar window on start", async () => {
    await withTempUserData(async (dir) => {
      const pet = new DesktopPetWindow({
        serverUrl: "http://127.0.0.1:8765",
        userDataPath: dir,
        preloadPath: "/tmp/pet-preload.cjs",
        platform: "darwin",
      })
      await pet.start()
      expect(windows).toHaveLength(1)
      const win = windows[0]
      expect(win.options.transparent).toBe(true)
      expect(win.options.frame).toBe(false)
      expect(win.options.alwaysOnTop).toBe(true)
      expect(win.options.skipTaskbar).toBe(true)
      expect(win.alwaysOnTop).toBe(true)
      expect(win.skipTaskbar).toBe(true)
      expect(win.shown).toBe(true)
      await pet.stop()
    })
  })

  test("positions the pet at the bottom-right of the primary display by default", async () => {
    await withTempUserData(async (dir) => {
      const pet = new DesktopPetWindow({
        serverUrl: "http://127.0.0.1:8765",
        userDataPath: dir,
        preloadPath: "/tmp/pet-preload.cjs",
        platform: "win32",
      })
      await pet.start()
      const win = windows[0]
      expect(win.position[0]).toBe(1920 - 160 - 24)
      expect(win.position[1]).toBe(1080 - 140 - 24)
      await pet.stop()
    })
  })

  test("connects to the global event SSE stream", async () => {
    await withTempUserData(async (dir) => {
      const pet = new DesktopPetWindow({
        serverUrl: "http://127.0.0.1:8765",
        userDataPath: dir,
        preloadPath: "/tmp/pet-preload.cjs",
        platform: "darwin",
      })
      await pet.start()
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(sseConnections).toHaveLength(1)
      expect(sseConnections[0].url).toContain("/global/event?stream=delta")
      await pet.stop()
    })
  })

  test("broadcasts mood state to the renderer on session events", async () => {
    await withTempUserData(async (dir) => {
      const pet = new DesktopPetWindow({
        serverUrl: "http://127.0.0.1:8765",
        userDataPath: dir,
        preloadPath: "/tmp/pet-preload.cjs",
        platform: "darwin",
      })
      await pet.start()
      await new Promise((resolve) => setTimeout(resolve, 10))
      const conn = sseConnections[0]
      const win = windows[0]

      conn.emit({
        type: "session.updated",
        properties: { info: { id: "s1", working: { status: "busy" } } },
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      const sent = win.webContents.sent
      const lastState = sent.filter((s) => s.channel === "pet:state").at(-1)
      expect((lastState?.payload as { mood: string }).mood).toBe("working")

      conn.emit({
        type: "session.completion",
        properties: { sessionID: "s1", unreadCount: 1 },
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      const celebrateState = win.webContents.sent.filter((s) => s.channel === "pet:state").at(-1)
      expect((celebrateState?.payload as { mood: string }).mood).toBe("celebrate")
      await pet.stop()
    })
  })

  test("rejects IPC from untrusted senders and accepts poke/drag from the pet window", async () => {
    await withTempUserData(async (dir) => {
      const pet = new DesktopPetWindow({
        serverUrl: "http://127.0.0.1:8765",
        userDataPath: dir,
        preloadPath: "/tmp/pet-preload.cjs",
        platform: "darwin",
      })
      await pet.start()
      const win = windows[0]

      const untrusted = await pet.handleIpc("pet.poke", { sender: {} }, undefined)
      expect(untrusted).toEqual({ ok: false, error: "pet_sender_rejected" })

      const poke = await pet.handleIpc("pet.poke", { sender: win.webContents }, undefined)
      expect(poke).toEqual({ ok: true })

      const state = await pet.handleIpc("pet.getState", { sender: win.webContents }, undefined)
      expect(state).toMatchObject({ ok: true, state: { mood: "happy" } })

      const drag = await pet.handleIpc("pet.dragBy", { sender: win.webContents }, { dx: 10, dy: -5 })
      expect(drag).toEqual({ ok: true })
      expect(win.position).toEqual([1920 - 160 - 24 + 10, 1080 - 140 - 24 - 5])
      await pet.stop()
    })
  })

  test("stop destroys the window and closes the SSE stream", async () => {
    await withTempUserData(async (dir) => {
      const pet = new DesktopPetWindow({
        serverUrl: "http://127.0.0.1:8765",
        userDataPath: dir,
        preloadPath: "/tmp/pet-preload.cjs",
        platform: "darwin",
      })
      await pet.start()
      expect(pet.isActive()).toBe(true)
      await pet.stop()
      expect(pet.isActive()).toBe(false)
      expect(windows[0].destroyed).toBe(true)
    })
  })
})
