import { expect, test } from "bun:test"
import { createCommandRegistry } from "../../src/context/command-registry"

test("registrations preserve host precedence and reject disabled execution", async () => {
  const commands = createCommandRegistry()
  let calls = 0
  const remove = commands.register(() => [
    {
      id: "plugin:run",
      title: "Run",
      disabled: true,
      onSelect: () => {
        calls++
      },
    },
  ])
  expect(await commands.trigger("plugin:run")).toBe(false)
  const latest = commands.register(() => [
    {
      id: "plugin:run",
      title: "New",
      onSelect: async () => {
        calls++
        throw new Error("operation failed")
      },
    },
  ])
  await expect(commands.trigger("plugin:run")).rejects.toThrow("operation failed")
  expect(calls).toBe(1)
  latest()
  expect(commands.options()[0].title).toBe("Run")
  remove()
  remove()
  expect(commands.options()).toEqual([])
})

test("command metadata remains reactive and execution awaits completion", async () => {
  const commands = createCommandRegistry()
  let done = false
  commands.register(() => [
    {
      id: "run",
      title: "Run",
      onSelect: async () => {
        await Promise.resolve()
        done = true
      },
    },
  ])
  expect(await commands.trigger("run")).toBe(true)
  expect(done).toBe(true)
  expect(await commands.trigger("missing")).toBe(false)
})
