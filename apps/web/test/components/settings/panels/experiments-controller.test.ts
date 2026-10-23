import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { FeatureStatus } from "@ericsanchezok/synergy-sdk/client"
import { createExperimentsController } from "../../../../src/components/settings/panels/experiments-controller"

const entry = (selected = false): FeatureStatus => ({
  id: "boss",
  selected,
  available: true,
  enabled: false,
  pendingRestart: selected,
  definition: {
    id: "boss",
    owner: "boss",
    maturity: "experimental",
    activation: "restart",
    name: "Boss",
    description: "Fixture",
    component: "boss",
  },
})

test("failed saves preserve the draft and successful saves retain truthful restart state", async () => {
  let fail = true
  let selected = false
  let dispose!: () => void
  const controller = createRoot((d) => {
    dispose = d
    return createExperimentsController(
      {
        get: async () => [entry(selected)],
        update: async (ids) => {
          if (fail) throw new Error("offline")
          selected = ids.includes("boss")
        },
      },
      { owner: () => "runtime", identity: () => "host", visible: () => false },
    )
  })
  try {
    await controller.load()
    controller.toggle("boss", true)
    expect(await controller.save()).toBe(false)
    expect(controller.selected("boss")).toBe(true)
    expect(controller.dirty()).toBe(true)
    expect(controller.error()?.operation).toBe("save")
    fail = false
    expect(await controller.save()).toBe(true)
    expect(controller.dirty()).toBe(false)
    expect(controller.catalog()[0]?.enabled).toBe(false)
    expect(controller.catalog()[0]?.pendingRestart).toBe(true)
  } finally {
    dispose()
  }
})

test("load failures can be retried without writing preferences", async () => {
  let failed = true
  let writes = 0
  let dispose!: () => void
  const controller = createRoot((d) => {
    dispose = d
    return createExperimentsController(
      {
        get: async () => {
          if (failed) throw new Error("private diagnostic")
          return [entry()]
        },
        update: async () => {
          writes++
        },
      },
      { owner: () => "runtime", identity: () => "host", visible: () => false },
    )
  })
  try {
    await controller.load()
    expect(controller.loaded()).toBe(false)
    expect(controller.status()).toBe("error")
    expect(controller.error()?.operation).toBe("load")
    failed = false
    await controller.load()
    expect(controller.loaded()).toBe(true)
    expect(controller.error()).toBeUndefined()
    expect(writes).toBe(0)
  } finally {
    dispose()
  }
})

test("late replies cannot restore a previous runtime catalog or erase retained drafts", async () => {
  let resolve!: (items: FeatureStatus[]) => void
  let get = async () => [entry()]
  let dispose!: () => void
  let change!: (value: string | undefined) => void
  const controller = createRoot((d) => {
    dispose = d
    const [owner, setOwner] = createSignal<string | undefined>("first")
    change = setOwner
    return createExperimentsController(
      { get: () => get(), update: async () => {} },
      { owner, identity: () => "host", visible: () => false },
    )
  })
  try {
    await controller.load()
    controller.toggle("boss", true)
    get = () =>
      new Promise((r) => {
        resolve = r
      })
    const stale = controller.load()
    change(undefined)
    await Promise.resolve()
    change("second")
    await Promise.resolve()
    get = async () => []
    await controller.load()
    resolve([entry(true)])
    await stale
    expect(controller.catalog()).toEqual([])
    expect(controller.selected("boss")).toBe(true)
  } finally {
    dispose()
  }
})
