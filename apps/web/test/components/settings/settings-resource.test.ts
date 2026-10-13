import { createRoot, createSignal } from "solid-js"
import { expect, test } from "bun:test"
import { createSettingsResource } from "../../../src/components/settings/settings-resource"

test("an unused section stays unloaded, and a failed section can retry independently", async () => {
  let calls = 0
  let fail = true
  const [data, resource] = createSettingsResource(
    async () => {
      calls++
      if (fail) throw new Error("unavailable")
      return ["model"]
    },
    () => false,
  )
  await resource.refetch()
  expect(calls).toBe(0)
  await resource.retry()
  expect(data()).toBeUndefined()
  expect(resource.error()).toBeInstanceOf(Error)
  expect(resource.loading()).toBe(false)
  fail = false
  await resource.retry()
  expect(data()).toEqual(["model"])
  expect(resource.error()).toBeUndefined()
  expect(calls).toBe(2)
})

test("failed refresh retains the last good result and concurrent retries share a request", async () => {
  let calls = 0
  let fail = false
  const [data, resource] = createSettingsResource(
    async () => {
      calls++
      if (fail) throw new Error("unavailable")
      return { value: "kept" }
    },
    () => false,
  )
  await resource.retry()
  fail = true
  await Promise.all([resource.retry(), resource.retry()])
  expect(calls).toBe(2)
  expect(data()).toEqual({ value: "kept" })
  expect(resource.ready()).toBe(true)
  expect(resource.error()).toBeInstanceOf(Error)
})

test("capability selection changes invalidate late settings replies and wait until the section is available", async () => {
  const replies: Array<(value: string) => void> = []
  const [owner, setOwner] = createSignal<object | undefined>({})
  let dispose = () => {}
  const [data, resource] = createRoot((rootDispose) => {
    dispose = rootDispose
    return createSettingsResource(
      () => new Promise<string>((resolve) => replies.push(resolve)),
      () => !!owner(),
      owner,
    )
  })
  await Bun.sleep(0)
  expect(replies).toHaveLength(1)
  setOwner(undefined)
  replies[0]("previous server")
  await Bun.sleep(0)
  expect(data()).toBeUndefined()
  expect(resource.ready()).toBe(false)
  expect(replies).toHaveLength(1)
  setOwner({})
  await Bun.sleep(0)
  replies[1]("current server")
  await Bun.sleep(0)
  expect(data()).toBe("current server")
  expect(resource.ready()).toBe(true)
  dispose()
})
