import { expect, test } from "bun:test"
import type { StorageUpgradeStatus } from "@ericsanchezok/synergy-sdk/client"
import { createUpgradeStatusController } from "../../../src/components/status-bar/upgrade-status-controller"

function status(pending: number, quarantined = 0): StorageUpgradeStatus {
  return { ready: true, total: 3, pending, partial: 0, imported: 3 - pending - quarantined, quarantined }
}

test("upgrade polling continues only while historical sessions remain pending", async () => {
  const delays: number[] = []
  const seen: (StorageUpgradeStatus | undefined)[] = []
  let hidden = false
  let current = status(2)
  let cancelled = 0
  const controller = createUpgradeStatusController({
    load: async () => current,
    publish: (value) => seen.push(value),
    hidden: () => hidden,
    schedule: (_callback, delay) => {
      delays.push(delay)
      return () => cancelled++
    },
  })
  await controller.refresh()
  hidden = true
  await controller.refresh()
  current = status(0, 1)
  await controller.refresh()
  expect(delays).toEqual([2000, 10_000])
  expect(seen.at(-1)?.quarantined).toBe(1)
  controller.dispose()
  expect(cancelled).toBe(2)
})

test("a disposed server request cannot publish or schedule another refresh", async () => {
  const pending = Promise.withResolvers<StorageUpgradeStatus | undefined>()
  const seen: unknown[] = []
  const controller = createUpgradeStatusController({
    load: () => pending.promise,
    publish: (value) => seen.push(value),
    hidden: () => false,
    schedule: () => {
      throw new Error("Disposed request scheduled a refresh")
    },
  })
  const refresh = controller.refresh()
  controller.dispose()
  pending.resolve(status(2))
  await refresh
  await controller.refresh()
  expect(seen).toEqual([])
})

test("transient errors retry, while an absent status finishes polling", async () => {
  let fail = true
  let scheduled = 0
  const controller = createUpgradeStatusController({
    load: async () => {
      if (fail) throw new Error("temporarily unavailable")
      return undefined
    },
    publish: () => {},
    hidden: () => false,
    schedule: () => {
      scheduled++
      return () => {}
    },
  })
  await controller.refresh()
  fail = false
  await controller.refresh()
  expect(scheduled).toBe(1)
  controller.dispose()
})
