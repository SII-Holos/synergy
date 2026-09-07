import { describe, expect, test } from "bun:test"
import { electronMockState, registerElectronMock } from "./electron-mock"

registerElectronMock()

interface PendingInvocation {
  channel: string
  args: unknown[]
  result: unknown
}

const pendingInvocations: PendingInvocation[] = []

electronMockState.ipcInvoke = (channel, ...args) => {
  const index = pendingInvocations.findIndex(
    (entry) => entry.channel === channel && JSON.stringify(entry.args) === JSON.stringify(args),
  )
  if (index < 0) throw new Error(`Unexpected invoke ${channel}`)
  const [match] = pendingInvocations.splice(index, 1)
  return Promise.resolve(match!.result)
}

function expectInvoke(channel: string, args: unknown[], result: unknown): void {
  pendingInvocations.push({ channel, args, result })
}

await import("../src/pet-preload.js")

type SynergyPetBridge = {
  poke(): Promise<{ ok: boolean }>
  dragBy(dx: number, dy: number): Promise<{ ok: boolean }>
  setDragging(dragging: boolean): Promise<{ ok: boolean }>
  getState(): Promise<{ ok: boolean; state?: unknown }>
  onState(listener: (state: unknown) => void): () => void
  onSettings(listener: (settings: unknown) => void): () => void
  onSprite(listener: (sprite: unknown) => void): () => void
}

const bridge = electronMockState.exposed["synergyPet"] as unknown as SynergyPetBridge

function emit(channel: string, payload: unknown): void {
  const listeners = electronMockState.ipcListeners.filter((entry) => entry.channel === channel)
  for (const entry of listeners) entry.wrapped({}, payload)
}

describe("pet preload bridge", () => {
  test("exposes a narrow synergyPet API on window", () => {
    expect(bridge).toBeTruthy()
    expect(typeof bridge.poke).toBe("function")
    expect(typeof bridge.dragBy).toBe("function")
    expect(typeof bridge.setDragging).toBe("function")
    expect(typeof bridge.getState).toBe("function")
    expect(typeof bridge.onState).toBe("function")
    expect(typeof bridge.onSettings).toBe("function")
    expect(typeof bridge.onSprite).toBe("function")
  })

  test("poke invokes the pet.poke channel", async () => {
    expectInvoke("pet.poke", [], { ok: true })
    await expect(bridge.poke()).resolves.toEqual({ ok: true })
  })

  test("dragBy invokes pet.dragBy with a delta payload", async () => {
    expectInvoke("pet.dragBy", [{ dx: 12, dy: -8 }], { ok: true })
    await expect(bridge.dragBy(12, -8)).resolves.toEqual({ ok: true })
  })

  test("setDragging invokes pet.setDragging with a boolean payload", async () => {
    expectInvoke("pet.setDragging", [{ dragging: true }], { ok: true })
    await expect(bridge.setDragging(true)).resolves.toEqual({ ok: true })
  })

  test("getState invokes pet.getState and returns the bridge state", async () => {
    expectInvoke("pet.getState", [], { ok: true, state: { mood: "happy", activeSessions: [], connected: true } })
    const result = await bridge.getState()
    expect(result).toMatchObject({ ok: true, state: { mood: "happy" } })
  })

  test("onState subscribes to pet:state and its disposer unsubscribes", () => {
    const received: unknown[] = []
    const dispose = bridge.onState((state) => received.push(state))
    emit("pet:state", { mood: "working", activeSessions: ["s1"], connected: true })
    emit("pet:state", { mood: "celebrate", activeSessions: [], connected: true })
    expect(received).toHaveLength(2)
    expect(received[0]).toMatchObject({ mood: "working" })
    expect(received[1]).toMatchObject({ mood: "celebrate" })

    dispose()
    emit("pet:state", { mood: "idle", activeSessions: [], connected: true })
    expect(received).toHaveLength(2)
  })

  test("onSettings subscribes to pet:settings and its disposer unsubscribes", () => {
    const received: unknown[] = []
    const dispose = bridge.onSettings((settings) => received.push(settings))
    emit("pet:settings", { version: 1, enabled: true, spritePath: "" })
    expect(received).toHaveLength(1)
    dispose()
    emit("pet:settings", { version: 1, enabled: false })
    expect(received).toHaveLength(1)
  })

  test("onSprite subscribes to pet:sprite and its disposer unsubscribes", () => {
    const received: unknown[] = []
    const dispose = bridge.onSprite((sprite) => received.push(sprite))
    emit("pet:sprite", { dataUrl: "data:image/png;base64,AAAA", columns: 8, rows: 7, frameMs: 120 })
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ columns: 8, rows: 7 })
    dispose()
    emit("pet:sprite", { dataUrl: null })
    expect(received).toHaveLength(1)
  })
})
