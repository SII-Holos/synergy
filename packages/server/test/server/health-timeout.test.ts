import { expect, test } from "bun:test"
import { Server } from "../../src/server/server"

const empty = {}

test("resolveHealthModelReady returns true from a fast provider build", async () => {
  const modelReady = await Server.resolveHealthModelReady({
    list: async () => ({ "provider-a": { id: "provider-a" } }) as any,
    listSettled: () => empty as any,
    waitMs: 50,
  })
  expect(modelReady).toBe(true)
})

test("resolveHealthModelReady falls back to the last settled state when the build stalls", async () => {
  const modelReady = await Server.resolveHealthModelReady({
    list: () => new Promise(() => {}),
    listSettled: () => ({ "settled-provider": { id: "settled-provider" } }) as any,
    waitMs: 20,
  })
  expect(modelReady).toBe(true)
})

test("resolveHealthModelReady reports false when the build stalls and nothing has settled", async () => {
  const modelReady = await Server.resolveHealthModelReady({
    list: () => new Promise(() => {}),
    listSettled: () => empty as any,
    waitMs: 20,
  })
  expect(modelReady).toBe(false)
})

test("resolveHealthModelReady falls back to the last settled state when the build rejects", async () => {
  let sawError: unknown
  const modelReady = await Server.resolveHealthModelReady({
    list: async () => {
      throw new Error("build failed")
    },
    listSettled: () => ({ "settled-provider": { id: "settled-provider" } }) as any,
    waitMs: 50,
    onError: (error) => {
      sawError = error
    },
  })
  expect(modelReady).toBe(true)
  expect(sawError).toBeInstanceOf(Error)
})

test("resolveHealthModelReady reports false when the build rejects and nothing has settled", async () => {
  const modelReady = await Server.resolveHealthModelReady({
    list: async () => {
      throw new Error("build failed")
    },
    listSettled: () => empty as any,
    waitMs: 50,
  })
  expect(modelReady).toBe(false)
})
