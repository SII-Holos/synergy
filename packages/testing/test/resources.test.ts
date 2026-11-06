import { expect, test } from "bun:test"
import { testResources } from "../src/resources"

test("cleanup drains in reverse acquisition order, attempts every release and reports ownership", async () => {
  const resources = testResources()
  const released: string[] = []
  resources.defer("directory", () => {
    released.push("directory")
  })
  resources.defer("server", () => {
    released.push("server")
    throw new Error("still listening")
  })
  resources.defer("page", async () => {
    released.push("page")
  })
  await expect(resources.close()).rejects.toThrow("server")
  expect(released).toEqual(["page", "server", "directory"])
  await expect(resources.close()).rejects.toThrow("server")
  expect(released).toHaveLength(3)
  expect(() => resources.defer("late", () => {})).toThrow("closed")
})

test("successful cleanup is safe to await more than once", async () => {
  const resources = testResources()
  let count = 0
  resources.defer("fixture", () => {
    count++
  })
  await Promise.all([resources.close(), resources.close()])
  expect(count).toBe(1)
})
