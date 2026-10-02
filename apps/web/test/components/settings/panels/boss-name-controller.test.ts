import { expect, test } from "bun:test"
import { createBossNameController } from "../../../../src/components/settings/panels/boss-name-controller"
import type { BossNameGateway } from "../../../../src/components/settings/panels/boss-name-model"

function fixture() {
  const writes: string[] = []
  const gateway: BossNameGateway = {
    listSelfMemories: async () => [],
    createMemory: async (input) => {
      writes.push(input.content)
    },
    updateMemory: async (input) => {
      writes.push(input.content)
    },
    removeMemory: async () => {
      writes.push("")
    },
  }
  return { gateway, writes }
}

test("boss names remain staged until explicit save and discard does not write", async () => {
  const { gateway, writes } = fixture()
  const controller = createBossNameController(gateway)
  await controller.load()
  controller.setContent("Draft")
  expect(controller.dirty()).toBe(true)
  expect(writes).toEqual([])
  controller.discard()
  expect(controller.content()).toBe("")
  expect(writes).toEqual([])
  controller.setContent(" Saved ")
  expect(await controller.save()).toBe(true)
  expect(writes).toEqual(["Saved"])
  expect(controller.dirty()).toBe(false)
})

test("an edit made while a boss name is saving remains dirty", async () => {
  const { gateway } = fixture()
  let release!: () => void
  gateway.createMemory = () =>
    new Promise<void>((resolve) => {
      release = resolve
    })
  const controller = createBossNameController(gateway)
  await controller.load()
  controller.setContent("Submitted")
  const pending = controller.save()
  await new Promise((resolve) => setTimeout(resolve, 0))
  controller.setContent("New draft")
  release()
  await pending
  expect(controller.content()).toBe("New draft")
  expect(controller.dirty()).toBe(true)
  controller.discard()
  expect(controller.content()).toBe("Submitted")
})

test("failed name saves retain the draft for retry", async () => {
  const { gateway, writes } = fixture()
  const create = gateway.createMemory
  gateway.createMemory = async () => {
    throw new Error("Service unavailable")
  }
  const controller = createBossNameController(gateway)
  await controller.load()
  controller.setContent("Retry me")
  expect(await controller.save()).toBe(false)
  expect(controller.error()).toBe("Service unavailable")
  expect(controller.content()).toBe("Retry me")
  expect(controller.dirty()).toBe(true)
  gateway.createMemory = create
  expect(await controller.save()).toBe(true)
  expect(writes).toEqual(["Retry me"])
})
