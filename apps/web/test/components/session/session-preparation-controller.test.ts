import { expect, test } from "bun:test"
import type { StorageSessionPreparation } from "@ericsanchezok/synergy-sdk/client"
import { createSessionPreparationController } from "../../../src/components/session/session-preparation-controller"

const pending: StorageSessionPreparation = { sessionID: "history", state: "preparing", files: 0, bytes: 0 }

test("preparation polling stops on readiness and a disposed navigation ignores its old response", async () => {
  const seen: string[] = []
  const waits: number[] = []
  let tick: (() => void) | undefined
  const deferred = Promise.withResolvers<StorageSessionPreparation>()
  const controller = createSessionPreparationController({
    prepare: async () => pending,
    poll: () => deferred.promise,
    retry: async () => pending,
    publish: (value) => seen.push(value.state),
    failed: () => seen.push("error"),
    hidden: () => false,
    schedule: (callback, ms) => {
      tick = callback
      waits.push(ms)
      return () => {}
    },
  })
  await controller.start()
  tick?.()
  controller.dispose()
  deferred.resolve({ ...pending, state: "ready" })
  await deferred.promise
  expect(seen).toEqual(["preparing"])
  expect(waits).toEqual([1000])
})

test("a failed request can retry from durable preparation and blocked data does not spin", async () => {
  const seen: string[] = []
  const controller = createSessionPreparationController({
    prepare: async () => {
      throw new Error("offline")
    },
    poll: async () => pending,
    retry: async () => ({ ...pending, state: "blocked" }),
    publish: (value) => seen.push(value.state),
    failed: () => seen.push("offline"),
    hidden: () => false,
    schedule: () => {
      throw new Error("Blocked preparation must not poll")
    },
  })
  await controller.start()
  await controller.retry()
  expect(seen).toEqual(["offline", "blocked"])
  controller.dispose()
})
